import net from "node:net";
import { connectThrough } from "./transports.js";
import { isLoopbackHost } from "./tunnel.js";

/**
 * The loopback rule-splitting proxy server.
 *
 * One port speaks both:
 * - HTTP proxy: CONNECT for tunnels, absolute-form GET/POST for plain http
 * - SOCKS5: greeting/negotiation then TCP connect
 *
 * Every target is decided by the {@link RuleEngine}: `direct` connects
 * straight to the destination, `proxy` goes through the current upstream
 * node, `reject` drops the connection. Byte counters feed the GUI traffic
 * panel. No system proxy, no TUN, loopback only.
 * @module dsh-clash-proxy/proxy-server
 */

/** Refuse request heads larger than this (protects the harness heap). */
const MAX_HEAD_BYTES = 32 * 1024;

/** Pipe an async iterable of chunks into a writable socket. */
async function pumpInto(iterable, socket, counter) {
	try {
		for await (const chunk of iterable) {
			if (socket.destroyed) return;
			counter?.(chunk.length);
			if (!socket.write(chunk)) await new Promise((resolve) => socket.once("drain", resolve));
		}
		if (!socket.destroyed) socket.end();
	} catch {
		socket.destroy();
	}
}

/** Pipe one socket into another (plain duplex). */
function pipeSockets(source, target, counter) {
	source.on("data", (chunk) => {
		counter?.(chunk.length);
		if (!target.write(chunk)) source.pause();
	});
	target.on("drain", () => source.resume());
	source.on("end", () => target.end());
	source.on("close", () => target.destroy());
	source.on("error", () => target.destroy());
}

/** Wait for more bytes, returning the accumulated buffer. */
function readMore(socket, buffer) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
			// Stop the flowing mode before the next await: without this, bytes that
			// arrive while we connect upstream are emitted with no listener and are
			// silently dropped (CONNECT+payload pipelined in one segment lost them).
			try {
				socket.pause();
			} catch {}
		};
		const onData = (chunk) => {
			cleanup();
			resolve(Buffer.concat([buffer, chunk]));
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const onClose = () => {
			cleanup();
			reject(new Error("connection closed by client"));
		};
		socket.once("data", onData);
		socket.once("error", onError);
		socket.once("close", onClose);
		// cleanup() leaves the socket explicitly paused; an explicit pause disables
		// the automatic flowing mode a 'data' listener would otherwise enable, so
		// every wait has to resume the stream itself.
		try {
			socket.resume();
		} catch {}
	});
}

/**
 * Parse a CONNECT target ("host:port" / "[v6]:port") into `{host, port}`.
 * Returns null for anything that is not a usable authority.
 */
export function parseConnectTarget(target) {
	if (typeof target !== "string" || target.length === 0) return null;
	let host;
	let portText;
	if (target.startsWith("[")) {
		const end = target.indexOf("]");
		if (end === -1) return null;
		host = target.slice(1, end);
		if (target[end + 1] !== ":") return null;
		portText = target.slice(end + 2);
	} else {
		const colon = target.lastIndexOf(":");
		if (colon <= 0) return null;
		host = target.slice(0, colon);
		portText = target.slice(colon + 1);
	}
	const port = Number(portText);
	if (!/^\d{1,5}$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
	if (!/^[^\s\x00-\x1f\x7f]+$/.test(host)) return null;
	return { host, port };
}

/** Default port for an absolute-form proxy request. */
export function defaultPortFor(protocol) {
	return protocol === "https:" ? 443 : 80;
}

export class ProxyServer {
	#engine;
	#resolveNode;
	#server = null;
	#port = 0;
	/** In-flight client sockets, destroyed by stop(). */
	#sockets = new Set();
	/** @type {{up: number, down: number}} */
	counters = { up: 0, down: 0 };

	/**
	 * @param engine - rule engine deciding direct/proxy/reject.
	 * @param resolveNode - thunk returning the current upstream node
	 * (null → direct-only fallback when no node is selected).
	 */
	constructor({ engine, resolveNode }) {
		this.#engine = engine;
		this.#resolveNode = resolveNode;
	}

	/** Bound loopback port (0 until started). */
	get port() {
		return this.#port;
	}

	/** Open client connections, for diagnostics. */
	get connections() {
		return this.#sockets.size;
	}

	/** Start listening on 127.0.0.1. @returns the bound port. */
	start(port = 0) {
		return new Promise((resolve, reject) => {
			this.#server = net.createServer((client) => this.#handle(client));
			this.#server.once("error", reject);
			this.#server.on("connection", (socket) => {
				this.#sockets.add(socket);
				socket.on("close", () => this.#sockets.delete(socket));
			});
			this.#server.listen(port, "127.0.0.1", () => {
				this.#port = this.#server.address().port;
				// A server-level error after listen (EMFILE, EADDRINUSE from a
				// racing bind) would otherwise be swallowed: the once("error")
				// above is already consumed and no listener remains.
				this.#server.removeListener("error", reject);
				this.#server.on("error", (error) => {
					// eslint-disable-next-line no-console
					if (process.env.DSH_PROXY_DEBUG === "1") console.error("[proxy] server error:", error.message);
				});
				resolve(this.#port);
			});
		});
	}

	/** Stop listening and destroy every in-flight connection. */
	stop() {
		const server = this.#server;
		this.#server = null;
		this.#port = 0;
		if (server !== null) server.close();
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
	}

	/** Route one inbound connection by first byte: 0x05 → SOCKS5, else HTTP. */
	#handle(client) {
		client.once("data", (first) => {
			// Pause before dispatching: the handlers await an upstream connection and
			// push the post-header remainder back with unshift(). On a flowing socket
			// that remainder is emitted into the void (no listener yet) — a client
			// that pipelines CONNECT + payload lost every byte. Handlers resume when
			// they take ownership (readMore() resumes per wait, #relay() on takeover).
			try {
				client.pause();
			} catch {}
			if (first[0] === 0x05) {
				this.#handleSocks5(client, first).catch(() => client.destroy());
			} else {
				this.#handleHttp(client, first).catch(() => client.destroy());
			}
		});
		client.on("error", () => {});
	}

	/** Connect to the target per rules; returns the duplex face or throws. */
	async #connect(host, port) {
		// A loopback target is never useful through an upstream node (the node
		// would dial its own loopback, not this machine's). Keep it direct even
		// when the default policy says proxy — mirrors the node:http tunnel guard.
		const loopback = isLoopbackHost(host);
		const action = loopback ? "direct" : this.#engine.decide(host);
		if (action === "reject") throw new Error(`rejected by rule: ${host}`);
		const node = action === "proxy" ? this.#resolveNode() : null;
		if (action === "proxy" && (node === null || node === undefined)) throw new Error(`no upstream node available for ${host} (select a node or check the subscription)`);
		// eslint-disable-next-line no-console
		if (process.env.DSH_PROXY_DEBUG === "1") console.error(`[proxy] ${host}:${port} → ${action}${action === "proxy" ? ` via ${typeof node === "string" ? node : node?.name}(${node?.type})` : ""}`);
		return connectThrough(node, host, port);
	}

	#relay(face, client) {
		pumpInto(face.read, client, (bytes) => {
			this.counters.down += bytes;
		}).catch(() => client.destroy());
		client.on("data", (chunk) => {
			this.counters.up += chunk.length;
			face.write(chunk);
		});
		client.on("end", () => face.close());
		client.on("close", () => face.close());
		client.on("error", () => face.close());
		// readMore() paused the socket while the tunnel was being set up; resume now
		// that the relay owns it, so bytes buffered meanwhile are actually delivered.
		try {
			client.resume();
		} catch {}
	}

	// ---- SOCKS5 inbound ------------------------------------------------------

	async #handleSocks5(client, greeting) {
		let buffer = greeting;
		// greeting: VER(1) NMETHODS(1) METHODS(N) — may arrive split.
		while (buffer.length < 2) buffer = await readMore(client, buffer);
		const methodCount = buffer[1];
		while (buffer.length < 2 + methodCount) buffer = await readMore(client, buffer);
		const methods = [...buffer.subarray(2, 2 + methodCount)];
		const method = methods.includes(0x00) ? 0x00 : 0xff;
		client.write(Buffer.from([0x05, method]));
		if (method === 0xff) return client.end();
		const leftover = buffer.subarray(2 + methodCount);

		const { host, port, rest } = await this.#readSocks5Request(client, leftover);
		const action = this.#engine.decide(host);
		if (action === "reject") {
			client.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
			return;
		}
		try {
			const face = await this.#connect(host, port);
			client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
			if (rest.length > 0) client.unshift(rest);
			this.#relay(face, client);
		} catch (error) {
			// eslint-disable-next-line no-console
			if (process.env.DSH_PROXY_DEBUG === "1") console.error(`[proxy] socks5 connect failed for ${host}:${port}:`, error.message);
			client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
		}
	}

	/**
	 * Read the SOCKS5 request header, tolerating TCP fragmentation. Returns the
	 * decoded target plus any payload that arrived in the same chunk.
	 */
	async #readSocks5Request(client, pending) {
		let buffer = pending;
		while (buffer.length < 4) buffer = await readMore(client, buffer);
		const atyp = buffer[3];
		let host;
		let port;
		let consumed;
		if (atyp === 0x01) {
			while (buffer.length < 10) buffer = await readMore(client, buffer);
			host = [...buffer.subarray(4, 8)].join(".");
			port = buffer.readUInt16BE(8);
			consumed = 10;
		} else if (atyp === 0x04) {
			while (buffer.length < 22) buffer = await readMore(client, buffer);
			const groups = [];
			for (let i = 0; i < 8; i++) groups.push(buffer.subarray(4 + i * 2, 6 + i * 2).toString("hex"));
			host = groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
			port = buffer.readUInt16BE(20);
			consumed = 22;
		} else if (atyp === 0x03) {
			while (buffer.length < 5) buffer = await readMore(client, buffer);
			const length = buffer[4];
			while (buffer.length < 5 + length + 2) buffer = await readMore(client, buffer);
			host = buffer.subarray(5, 5 + length).toString("utf8");
			port = buffer.readUInt16BE(5 + length);
			consumed = 5 + length + 2;
		} else {
			throw new Error("socks5: unsupported address type");
		}
		return { host, port, rest: buffer.subarray(consumed) };
	}

	// ---- HTTP inbound --------------------------------------------------------

	async #handleHttp(client, first) {
		const head = await this.#readHttpHead(client, first);
		const lines = head.split("\r\n");
		const requestLine = lines[0] ?? "";
		const [method, target] = requestLine.split(" ");
		const headers = {};
		for (const line of lines.slice(1)) {
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
		}
		if (method === "CONNECT") {
			await this.#handleConnect(client, target, headers);
			return;
		}
		if (target !== undefined && (target.startsWith("http://") || target.startsWith("https://"))) {
			await this.#handleAbsolute(client, method, target, requestLine, lines);
			return;
		}
		client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	}

	async #readHttpHead(client, first) {
		let buffer = first;
		for (;;) {
			const end = buffer.indexOf("\r\n\r\n");
			if (end !== -1) {
				const head = buffer.subarray(0, end).toString("latin1");
				if (buffer.length > end + 4) client.unshift(buffer.subarray(end + 4));
				return head;
			}
			if (buffer.length > MAX_HEAD_BYTES) throw new Error(`request head too large (>${MAX_HEAD_BYTES} bytes)`);
			buffer = await readMore(client, buffer);
		}
	}

	async #handleConnect(client, target, headers) {
		const parsed = parseConnectTarget(target);
		if (parsed === null) {
			client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const { host, port } = parsed;
		try {
			const face = await this.#connect(host, port);
			// eslint-disable-next-line no-console
			if (process.env.DSH_PROXY_DEBUG === "1") console.error(`[proxy] tunnel established for ${host}:${port}`);
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			this.#relay(face, client);
		} catch (error) {
			// eslint-disable-next-line no-console
			if (process.env.DSH_PROXY_DEBUG === "1") console.error(`[proxy] connect failed for ${host}:${port}:`, error.message);
			client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		}
	}

	async #handleAbsolute(client, method, target, requestLine, lines) {
		let url;
		try {
			url = new URL(target);
		} catch {
			client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		if (url.protocol === "https:") {
			// TLS would have to be terminated here; browsers use CONNECT for that.
			// Say so instead of writing plaintext at port 443.
			client.end("HTTP/1.1 501 Not Implemented\r\n\r\nuse CONNECT for https targets\r\n");
			return;
		}
		const host = url.hostname;
		const port = url.port.length > 0 ? Number(url.port) : defaultPortFor(url.protocol);
		try {
			const face = await this.#connect(host, port);
			// Rebuild the request with an origin-form target and forced close.
			const path = `${url.pathname}${url.search}`;
			const rewritten = lines.slice(1).filter((line) => !/^(proxy-connection|connection):/i.test(line.trim()));
			const outbound = `${method} ${path} HTTP/1.1\r\n${rewritten.join("\r\n")}\r\nConnection: close\r\n\r\n`;
			this.counters.up += Buffer.byteLength(outbound);
			face.write(Buffer.from(outbound));
			// Relay the request body (any bytes already buffered were pushed back
			// onto the client socket by #readHttpHead) and the response in both
			// directions. Writing only face.read→client silently dropped bodies.
			this.#relay(face, client);
		} catch (error) {
			client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		}
	}
}
