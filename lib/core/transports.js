import net from "node:net";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { sealVmessAeadHeader, buildVmessCommand, decodeVmessResponse, VmessChunkWriter, VmessChunkReader, vmessEncodeAddr } from "./vmess.js";
import { wsHandshake, WsStream } from "./ws.js";

/**
 * Lightweight upstream transports for subscription nodes.
 *
 * Supported node types: `direct` (no node), `http`, `socks5`, `ss`
 * (aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305), `trojan`
 * (tcp / tls / ws), `vless` (tcp / tls / ws), and `vmess` (AEAD alterId=0,
 * tcp / ws, AES-128-GCM). `vless` reality (xtls-rprx-vision) and `hysteria2`
 * (QUIC) are delegated to the bundled Go native connector (see nativeConnect);
 * `tuic` (another QUIC variant) is not implemented.
 *
 * Every transport resolves to a uniform duplex face:
 *   { read: AsyncIterable<Buffer> (decrypted bytes), write(buf), close() }
 * so the proxy server never cares which protocol a node speaks.
 *
 * One {@link SocketBuffer} per connection owns all inbound bytes: handshakes
 * consume exact counts from it and any leftovers stay buffered for the relay
 * phase, so pipelined early data (TLS ClientHello etc.) is never lost.
 * @module dsh-clash-proxy/transports
 */

const SS_SALT_SIZES = { "aes-128-gcm": 16, "aes-256-gcm": 32, "chacha20-ietf-poly1305": 32 };
const SS_KEY_SIZES = { "aes-128-gcm": 16, "aes-256-gcm": 32, "chacha20-ietf-poly1305": 32 };
const SS_CIPHER_NAMES = { "chacha20-ietf-poly1305": "chacha20-poly1305" };

/** Persistent inbound-byte buffer: handshake + relay share one stream. */
export class SocketBuffer {
	#buffer = Buffer.alloc(0);
	#waiters = [];
	#ended = false;
	#error = null;

	/** @param socket - the socket whose "data" events feed this buffer. */
	constructor(socket) {
		this.socket = socket;
		socket.on("data", (chunk) => {
			if (this.#ended) return;
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			this.#flush();
		});
		socket.once("close", () => {
			this.#ended = true;
			for (const waiter of this.#waiters.splice(0)) {
				if (waiter.any) waiter.resolve(null);
				else waiter.reject(new Error("connection closed while reading"));
			}
		});
		socket.on("error", (error) => {
			this.#error = error;
			for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
		});
	}

	/** Pause the socket once the buffer is this large (consumer is slow). */
	static HIGH_WATER = 1024 * 1024;
	/** Resume once the consumer drained the buffer below this. */
	static LOW_WATER = 64 * 1024;

	#flush() {
		while (this.#waiters.length > 0) {
			const waiter = this.#waiters[0];
			if (waiter.any) {
				if (this.#buffer.length === 0) return;
				this.#waiters.shift();
				waiter.resolve(this.#buffer);
				this.#buffer = Buffer.alloc(0);
				continue;
			}
			if (this.#buffer.length < waiter.count) return;
			this.#waiters.shift();
			waiter.resolve(this.#buffer.subarray(0, waiter.count));
			this.#buffer = this.#buffer.subarray(waiter.count);
		}
		this.#throttle();
	}

	/** Keep an unbounded buffer from growing when the consumer is slow. */
	#throttle() {
		if (this.#ended || this.#error !== null) return;
		if (this.#buffer.length >= SocketBuffer.HIGH_WATER) {
			if (!this.socket.isPaused()) this.socket.pause();
		} else if (this.#buffer.length <= SocketBuffer.LOW_WATER && this.socket.isPaused()) {
			this.socket.resume();
		}
	}

	/** Exactly `count` bytes (waits for them to arrive). */
	read(count) {
		return new Promise((resolve, reject) => {
			if (this.#error !== null) return reject(this.#error);
			if (this.#ended) return reject(new Error("connection closed"));
			this.#waiters.push({ count, resolve, reject });
			this.#flush();
		});
	}

	/** Whatever is currently buffered, waiting for at least one byte; null on close. */
	readAny() {
		return new Promise((resolve, reject) => {
			if (this.#error !== null) return reject(this.#error);
			if (this.#ended) return resolve(null);
			this.#waiters.push({ any: true, resolve, reject });
			this.#flush();
		});
	}
}

/** Default connect timeout; keeps a black-holed upstream from leaking sockets. */
const CONNECT_TIMEOUT_MS = 15000;

/**
 * Promisified TCP connect. The deadline is an explicit timer that is cleared on
 * success: socket.setTimeout() keeps its callback registered as a listener, so a
 * later idle timeout would re-fire it and kill a live socket with a misleading
 * "connect timeout" error.
 */
function tcpConnect(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		const timer = setTimeout(() => {
			socket.destroy(new Error(`tcp connect timeout: ${host}:${port}`));
			reject(new Error(`tcp connect timeout: ${host}:${port}`));
		}, timeoutMs);
		timer.unref?.();
		const onError = (error) => {
			clearTimeout(timer);
			reject(error);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.removeListener("error", onError);
			resolve(socket);
		});
	});
}

/** Promisified TLS connect (same deadline discipline as tcpConnect). */
function tlsConnect(host, port, servername, skipVerify, timeoutMs = CONNECT_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host, port, servername: servername ?? host, rejectUnauthorized: !skipVerify });
		const timer = setTimeout(() => {
			socket.destroy(new Error(`tls connect timeout: ${host}:${port}`));
			reject(new Error(`tls connect timeout: ${host}:${port}`));
		}, timeoutMs);
		timer.unref?.();
		const onError = (error) => {
			clearTimeout(timer);
			reject(error);
		};
		socket.once("error", onError);
		socket.once("secureConnect", () => {
			clearTimeout(timer);
			socket.removeListener("error", onError);
			resolve(socket);
		});
	});
}

/** Promisified socket write (drain-aware). */
function socketWrite(socket, data) {
	return new Promise((resolve, reject) => {
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const cleanup = () => {
			socket.off("error", onError);
			socket.off("drain", onDrain);
		};
		socket.once("error", onError);
		socket.once("drain", onDrain);
		if (!socket.write(data)) return;
		cleanup();
		resolve();
	});
}

/** SOCKS-style address encoding: [atyp][address][port BE16]. */
/**
 * Parse an IPv6 literal into 16 bytes. Handles `::` compression, bracketed
 * literals and trailing IPv4 (`::ffff:1.2.3.4`). Returns null for anything
 * that is not a full IPv6 address (zone ids included — they are link-local and
 * must not be sent to an upstream).
 */
export function ipv6Bytes(host) {
	const cleaned = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (cleaned.length === 0 || cleaned.includes("%")) return null;
	const halves = cleaned.split("::");
	if (halves.length > 2) return null;
	const expand = (text) => {
		if (text.length === 0) return [];
		const groups = [];
		for (const part of text.split(":")) {
			if (part.includes(".")) {
				if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(part)) return null;
				const octets = part.split(".").map(Number);
				if (octets.some((value) => value > 255)) return null;
				groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
			} else {
				if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
				groups.push(parseInt(part, 16));
			}
		}
		return groups;
	};
	const head = expand(halves[0]);
	const tail = halves.length === 2 ? expand(halves[1]) : [];
	if (head === null || tail === null) return null;
	if (halves.length === 1) {
		if (head.length !== 8) return null;
	} else if (head.length + tail.length > 7) return null;
	const groups = [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
	const bytes = Buffer.alloc(16);
	groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
	return bytes;
}

/** SOCKS-style address encoding: [atyp][address][port BE16]. */
export function encodeAddr(host, port) {
	const ip4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255);
	if (ip4) {
		const addr = Buffer.concat([Buffer.from(host.split(".").map(Number)), Buffer.from([port >> 8, port & 0xff])]);
		return Buffer.concat([Buffer.from([0x01]), addr]);
	}
	if (host.includes(":")) {
		const bytes = ipv6Bytes(host);
		if (bytes !== null) return Buffer.concat([Buffer.from([0x04]), bytes, Buffer.from([port >> 8, port & 0xff])]);
	}
	const hostBytes = Buffer.from(host);
	return Buffer.concat([Buffer.from([0x03, hostBytes.length]), hostBytes, Buffer.from([port >> 8, port & 0xff])]);
}

/** Read a CRLF-terminated header block from the buffer (leftovers stay buffered). */
async function readUntilCrlfCrlf(buffer) {
	let text = "";
	for (;;) {
		const byte = await buffer.read(1);
		text += byte.toString("latin1");
		if (text.endsWith("\r\n\r\n")) return text.slice(0, -4);
		if (text.length > 65536) throw new Error("header block too large");
	}
}

/**
 * Bound a protocol handshake with an idle deadline. tcpConnect/tlsConnect only
 * time out the TCP/TLS connect; a peer that accepts the connection and then goes
 * silent would otherwise leave an awaiting read() pending forever. The deadline
 * is cleared by rawFace() once the handshake succeeded.
 */
function armHandshake(socket, timeoutMs) {
	socket.setTimeout(timeoutMs, () => {
		socket.destroy(new Error(`upstream handshake timeout after ${timeoutMs}ms`));
	});
}

/** Plain duplex face over a raw socket + shared buffer. */
function rawFace(socket, buffer) {
	socket.setTimeout(0); // handshake finished: no idle deadline for the payload
	return {
		read: (async function* () {
			for (;;) {
				const chunk = await buffer.readAny();
				if (chunk === null) return;
				yield chunk;
			}
		})(),
		write: (data) => socket.write(data),
		close: () => socket.destroy()
	};
}

// ---- plain transports -----------------------------------------------------

async function httpConnect(node, host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
	const socket = node.tls ? await tlsConnect(node.server, node.port, node.sni ?? node.server, node["skip-cert-verify"], timeoutMs) : await tcpConnect(node.server, node.port, timeoutMs);
	const buffer = new SocketBuffer(socket);
	armHandshake(socket, timeoutMs);
	const auth = node.username !== undefined && node.username !== null && String(node.username).length > 0
		? `Proxy-Authorization: Basic ${Buffer.from(`${node.username}:${node.password ?? ""}`).toString("base64")}\r\n`
		: "";
	await socketWrite(socket, `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
	const head = await readUntilCrlfCrlf(buffer);
	const status = Number((head.split("\r\n")[0] ?? " 0").split(" ")[1] ?? 0);
	if (status < 200 || status >= 300) throw new Error(`http upstream CONNECT failed: ${head.split("\r\n")[0]}`);
	return rawFace(socket, buffer);
}

async function socks5Connect(node, host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
	const socket = await tcpConnect(node.server, node.port, timeoutMs);
	const buffer = new SocketBuffer(socket);
	armHandshake(socket, timeoutMs);
	const hasAuth = node.username !== undefined && node.username !== null && String(node.username).length > 0;
	await socketWrite(socket, Buffer.from([0x05, hasAuth ? 2 : 1, 0x00, ...(hasAuth ? [0x02] : [])]));
	const greeting = await buffer.read(2);
	if (greeting[1] === 0x02) {
		const user = Buffer.from(String(node.username));
		const pass = Buffer.from(String(node.password ?? ""));
		await socketWrite(socket, Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
		const authReply = await buffer.read(2);
		if (authReply[1] !== 0x00) throw new Error("socks5 upstream auth failed");
	} else if (greeting[1] !== 0x00) {
		throw new Error("socks5 upstream: no acceptable auth method");
	}
	await socketWrite(socket, Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), encodeAddr(host, port)]));
	const reply = await buffer.read(4);
	if (reply[1] !== 0x00) throw new Error(`socks5 upstream connect failed: code ${reply[1]}`);
	const restLength = reply[3] === 0x01 ? 6 : reply[3] === 0x04 ? 18 : 0;
	if (restLength === 0 && reply[3] === 0x03) {
		const length = (await buffer.read(1))[0];
		await buffer.read(length + 2);
	} else if (restLength > 0) {
		await buffer.read(restLength);
	}
	return rawFace(socket, buffer);
}

// ---- shadowsocks AEAD -----------------------------------------------------

/** EVP_BytesToKey (MD5 iteration), shadowsocks master key derivation. */
export function ssMasterKey(password, keyLength) {
	const out = [];
	let previous = Buffer.alloc(0);
	while (Buffer.concat(out).length < keyLength) {
		previous = createHash("md5").update(Buffer.concat([previous, Buffer.from(password)])).digest();
		out.push(previous);
	}
	return Buffer.concat(out).subarray(0, keyLength);
}

/** SIP004 subkey derivation. */
export function ssSubkey(password, salt, cipherName) {
	const keyLength = SS_KEY_SIZES[cipherName];
	const master = ssMasterKey(password, keyLength);
	return hkdfSync("sha1", master, salt, "ss-subkey", keyLength);
}

/** Nonce with a little-endian 64-bit counter (SIP004). */
export function makeSsNonce() {
	const nonce = Buffer.alloc(12);
	let counter = 0;
	return {
		next() {
			nonce.writeBigUInt64LE(BigInt(counter++));
			return Buffer.from(nonce);
		}
	};
}

/** One AEAD seal: ciphertext = [cipher || tag], AAD = the 2-byte length. */
export function ssSeal(cipherName, key, nonce, plaintext) {
	const length = Buffer.from([plaintext.length >> 8, plaintext.length & 0xff]);
	const cipher = createCipheriv(SS_CIPHER_NAMES[cipherName] ?? cipherName, key, nonce);
	cipher.setAAD(length);
	return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** One AEAD open. */
export function ssOpen(cipherName, key, nonce, sealed) {
	const length = Buffer.from([(sealed.length - 16) >> 8, (sealed.length - 16) & 0xff]);
	const decipher = createDecipheriv(SS_CIPHER_NAMES[cipherName] ?? cipherName, key, nonce);
	decipher.setAAD(length);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

async function ssConnect(node, host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
	const cipherName = String(node.cipher ?? "aes-256-gcm");
	if (SS_KEY_SIZES[cipherName] === undefined) throw new Error(`ss: unsupported cipher ${cipherName}`);
	const salt = randomBytes(SS_SALT_SIZES[cipherName]);
	const key = ssSubkey(String(node.password ?? ""), salt, cipherName);
	const socket = await tcpConnect(node.server, node.port, timeoutMs);
	const buffer = new SocketBuffer(socket);
	armHandshake(socket, timeoutMs);
	const outNonce = makeSsNonce();
	const inNonce = makeSsNonce();
	const first = ssSeal(cipherName, key, outNonce.next(), encodeAddr(host, port));
	await socketWrite(socket, Buffer.concat([salt, Buffer.from([first.length >> 8, first.length & 0xff]), first]));

	return {
		read: (async function* () {
			for (;;) {
				const lengthHeader = await buffer.read(2);
				const length = (lengthHeader[0] << 8) | lengthHeader[1];
				// The length field covers ciphertext + tag (ssSeal's output size).
				const sealed = await buffer.read(length);
				yield ssOpen(cipherName, key, inNonce.next(), sealed);
			}
		})(),
		write: (data) => {
			for (let offset = 0; offset < data.length; offset += 0x3fff) {
				const part = data.subarray(offset, Math.min(data.length, offset + 0x3fff));
				const sealed = ssSeal(cipherName, key, outNonce.next(), part);
				socket.write(Buffer.concat([Buffer.from([sealed.length >> 8, sealed.length & 0xff]), sealed]));
			}
		},
		close: () => socket.destroy()
	};
}

// ---- vmess (AEAD, tcp / ws transport) ------------------------------------

/** Wrap an async iterable of chunks as a fixed-size read(n) source. */
export function iterableSource(iterable) {
	const iterator = iterable[Symbol.asyncIterator]();
	let pending = Buffer.alloc(0);
	return {
		async read(count) {
			while (pending.length < count) {
				const { value, done } = await iterator.next();
				if (done) throw new Error("connection closed while reading");
				pending = Buffer.concat([pending, value]);
			}
			const out = pending.subarray(0, count);
			pending = pending.subarray(count);
			return out;
		},
		/** Whatever is buffered (or the next chunk); null when the stream ends. */
		async readAny() {
			if (pending.length > 0) {
				const out = pending;
				pending = Buffer.alloc(0);
				return out;
			}
			const { value, done } = await iterator.next();
			return done ? null : value;
		}
	};
}

async function vmessConnect(node, host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
	const socket = node.tls
		? await tlsConnect(node.server, node.port, node.sni ?? node.server, node["skip-cert-verify"], timeoutMs)
		: await tcpConnect(node.server, node.port, timeoutMs);
	const buffer = new SocketBuffer(socket);
	armHandshake(socket, timeoutMs);
	const network = String(node.network ?? "tcp").toLowerCase();
	let writeRaw;
	let source;
	if (network === "ws") {
		const path = node["ws-opts"]?.path ?? "/";
		const headers = node["ws-opts"]?.headers ?? {};
		const hostHeader = headers.Host ?? headers.host ?? node.server;
		await wsHandshake(buffer, path, hostHeader);
		const ws = new WsStream(socket, buffer);
		writeRaw = (data) => ws.write(data);
		source = iterableSource(ws.read());
	} else {
		writeRaw = (data) => socket.write(data);
		source = buffer;
	}

	const cmdKey = createHash("md5")
		.update(uuidBytes(node.uuid))
		.update("c48619fe-8f02-49e0-b9e9-edf763e17e21")
		.digest();
	const reqKey = randomBytes(16);
	const reqIV = randomBytes(16);
	const responseHeader = randomBytes(1)[0];
	const command = buildVmessCommand({ reqKey, reqIV, responseHeader, host, port });
	const header = sealVmessAeadHeader(cmdKey, command);
	writeRaw(header);

	// The request body writer is ready immediately: the server only flushes its
	// (buffered) response header after it receives data from the target, which
	// in turn needs the client's request body first. Writes must therefore be
	// pipelined with — not gated behind — the response header read.
	const writer = new VmessChunkWriter((chunk) => writeRaw(chunk), reqKey, reqIV);

	let decodedPromise = null;
	const decoded = () => {
		if (decodedPromise === null) decodedPromise = decodeVmessResponse(source, reqKey, reqIV);
		return decodedPromise;
	};

	return {
		read: (async function* () {
			const { responseHeader: resp, bodyKey, bodyIV } = await decoded();
			if (resp[0] !== responseHeader) throw new Error("vmess: response header V mismatch");
			const reader = new VmessChunkReader(source, bodyKey, bodyIV);
			for (;;) {
				const chunk = await reader.readChunk();
				if (chunk === null) return;
				yield chunk;
			}
		})(),
		write: (data) => writer.write(data),
		close: () => {
			try {
				writer.end();
			} catch {
				// Socket may already be gone.
			}
			socket.destroy();
		}
	};
}

// ---- trojan / vless -------------------------------------------------------

async function trojanConnect(node, host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
	const socket = await tlsConnect(node.server, node.port, node.sni ?? node.server, node["skip-cert-verify"], timeoutMs);
	const buffer = new SocketBuffer(socket);
	armHandshake(socket, timeoutMs);
	const network = String(node.network ?? "tcp").toLowerCase();
	let writeRaw;
	let source; // async iterable of payload bytes
	if (network === "ws") {
		const path = node["ws-opts"]?.path ?? "/";
		const headers = node["ws-opts"]?.headers ?? {};
		const hostHeader = headers.Host ?? headers.host ?? node.sni ?? node.server;
		await wsHandshake(buffer, path, hostHeader);
		const ws = new WsStream(socket, buffer);
		writeRaw = (data) => ws.write(data);
		source = ws.read();
	} else {
		writeRaw = (data) => socket.write(data);
		source = (async function* () {
			for (;;) {
				const chunk = await buffer.readAny();
				if (chunk === null) return;
				yield chunk;
			}
		})();
	}
	const passwordHash = createHash("sha224").update(String(node.password ?? "")).digest("hex");
	const request = Buffer.concat([
		Buffer.from(passwordHash),
		Buffer.from("\r\n"),
		Buffer.from([0x01]),
		encodeAddr(host, port),
		Buffer.from("\r\n")
	]);
	writeRaw(request);
	return {
		read: source,
		write: (data) => writeRaw(data),
		close: () => socket.destroy()
	};
}

function uuidBytes(uuid) {
	const hex = String(uuid ?? "").replace(/-/g, "");
	if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("vless: invalid uuid");
	return Buffer.from(hex, "hex");
}

async function vlessConnect(node, host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
	const flow = String(node.flow ?? "").toLowerCase();
	if (flow === "xtls-rprx-vision" || (node["reality-opts"] !== undefined && node["reality-opts"] !== null)) {
		throw new Error("vless: reality (xtls-rprx-vision + reality-opts) needs uTLS fingerprinting that Node cannot provide");
	}
	const uuid = uuidBytes(node.uuid);
	const tls = node.tls === true || node.tls === "true";
	const socket = tls
		? await tlsConnect(node.server, node.port, node.servername ?? node.sni ?? node.server, node["skip-cert-verify"], timeoutMs)
		: await tcpConnect(node.server, node.port, timeoutMs);
	const buffer = new SocketBuffer(socket);
	armHandshake(socket, timeoutMs);
	const network = String(node.network ?? "tcp").toLowerCase();
	let writeRaw;
	let source; // async iterable of payload bytes
	if (network === "ws") {
		const path = node["ws-opts"]?.path ?? "/";
		const headers = node["ws-opts"]?.headers ?? {};
		const hostHeader = headers.Host ?? headers.host ?? node.server;
		await wsHandshake(buffer, path, hostHeader);
		const ws = new WsStream(socket, buffer);
		writeRaw = (data) => ws.write(data);
		source = ws.read();
	} else {
		writeRaw = (data) => socket.write(data);
		source = (async function* () {
			for (;;) {
				const chunk = await buffer.readAny();
				if (chunk === null) return;
				yield chunk;
			}
		})();
	}
	const request = Buffer.concat([
		Buffer.from([0x00]), // version
		uuid,
		Buffer.from([0x00]), // addons length
		Buffer.from([0x01]), // cmd: TCP
		vmessEncodeAddr(host, port) // [port BE16][atyp][addr] (PortThenAddress)
	]);
	writeRaw(request);

	// VLESS response header: [version(1)][addons len(1)][addons...]. It is
	// buffered by the server until the target replies, so it must be stripped
	// lazily inside read() — never awaited before the face is returned — or
	// writes would deadlock exactly like vmess.
	const reader = iterableSource(source);
	let headerStripped = false;
	const stripHeader = async () => {
		if (headerStripped) return;
		headerStripped = true;
		const version = (await reader.read(1))[0];
		if (version !== 0x00) throw new Error(`vless: unexpected response version ${version}`);
		const addonsLen = (await reader.read(1))[0];
		if (addonsLen > 0) await reader.read(addonsLen);
	};

	return {
		read: (async function* () {
			await stripHeader();
			for (;;) {
				const chunk = await reader.readAny();
				if (chunk === null) return;
				yield chunk;
			}
		})(),
		write: (data) => writeRaw(data),
		close: () => socket.destroy()
	};
}

// ---- unified entry --------------------------------------------------------

/** Path to the self-compiled Go connector (QUIC/uTLS transports). */
const CONNECTOR_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "connector.exe");

/** Whether the native connector binary is present. */
export function hasNativeConnector() {
	try { return existsSync(CONNECTOR_PATH); } catch { return false; }
}

/**
 * Connect through the self-compiled Go connector via stdio: stdin feeds the
 * remote target, stdout carries the reply. Supports `hysteria2` and `reality`.
 */
function nativeConnect(proto, node, host, port) {
	const payload = {
		type: node.type,
		server: node.server,
		port: Number(node.port),
		password: node.password,
		sni: node.sni,
		"skip-cert-verify": node["skip-cert-verify"] === true,
		ports: node.ports,
		uuid: node.uuid,
		flow: node.flow,
		servername: node.servername,
		"public-key": node["reality-opts"]?.["public-key"],
		"short-id": node["reality-opts"]?.["short-id"],
		"client-fingerprint": node["client-fingerprint"]
	};
	const nodeB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
	const child = spawn(CONNECTOR_PATH, [proto, nodeB64, host, String(port)], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true
	});
	let ended = false;
	let stderrTail = "";
	child.stderr.on("data", (chunk) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-512);
	});
	child.on("exit", () => { ended = true; });

	return {
		read: (async function* () {
			for await (const chunk of child.stdout) {
				yield chunk;
			}
		})(),
		write: (data) => {
			if (!ended) child.stdin.write(data);
		},
		close: () => {
			try { child.stdin.end(); } catch { /* already closed */ }
			try { child.stdout.destroy(); } catch { /* already closed */ }
			if (!ended) setTimeout(() => child.kill(), 500);
		}
	};
}

/**
 * Connect to target (host, port) through a node.
 * @param node - subscription node object, or null/undefined for direct.
 * @returns the uniform duplex face.
 */
async function dial(node, host, port, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
	if (node === null || node === undefined || node.type === "direct" || node.type === "Direct") {
		const socket = await tcpConnect(host, port, timeoutMs);
		return rawFace(socket, new SocketBuffer(socket));
	}
	switch (String(node.type).toLowerCase()) {
		case "http":
			return httpConnect(node, host, port, timeoutMs);
		case "socks5":
		case "socks":
			return socks5Connect(node, host, port, timeoutMs);
		case "ss":
			return ssConnect(node, host, port, timeoutMs);
		case "trojan":
			return trojanConnect(node, host, port, timeoutMs);
		case "vless":
			if (String(node.flow ?? "").toLowerCase() === "xtls-rprx-vision" && node["reality-opts"] !== undefined && node["reality-opts"] !== null) {
				if (!hasNativeConnector()) throw new Error("vless reality needs the native connector (lib/native/connector.exe)");
				return nativeConnect("reality", node, host, port);
			}
			return vlessConnect(node, host, port, timeoutMs);
		case "vmess":
			return vmessConnect(node, host, port, timeoutMs);
		case "hysteria2":
		case "hy2":
			if (!hasNativeConnector()) throw new Error("hysteria2 needs the native connector (lib/native/connector.exe)");
			return nativeConnect("hysteria2", node, host, port);
		case "tuic":
			throw new Error(`unsupported node type "tuic"`);
		default:
			throw new Error(`unsupported node type "${node.type}" (supported: http, socks5, ss, trojan, vless, vmess, hysteria2)`);
	}
}

/**
 * Connect to `host:port` through `node`, bounding the *whole* dial — TCP connect
 * plus the protocol handshake — by `timeoutMs`. tcpConnect/tlsConnect only time
 * out the socket connect; an upstream that accepts TCP and then never answers
 * its CONNECT/hello used to hang the caller forever. A face that arrives after
 * the deadline is closed instead of leaking its socket.
 */
export async function connectThrough(node, host, port, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
	let timedOut = false;
	let timer;
	const dialing = dial(node, host, port, { timeoutMs });
	const backstopMs = timeoutMs + 1000; // inner handshake deadlines fire first
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(new Error(`upstream handshake timeout after ${timeoutMs}ms (${node?.type ?? "direct"} → ${host}:${port})`));
		}, backstopMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([dialing, deadline]);
	} finally {
		clearTimeout(timer);
		if (timedOut) dialing.then((face) => face?.close?.(), () => {});
	}
}

/**
 * Measure TCP connect latency through a node (or direct). Resolves to
 * milliseconds, or null when it fails within the timeout.
 */
/**
 * Measure TCP connect latency through a node (or direct). Resolves to
 * milliseconds, or null when it fails within the timeout. A face that arrives
 * only after the timeout is closed instead of leaking its socket.
 */
export async function measureLatency(node, host, port, timeoutMs = 3000) {
	const start = Date.now();
	let timedOut = false;
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(new Error("timeout"));
		}, timeoutMs);
	});
	try {
		const attempt = connectThrough(node, host, port, { timeoutMs }).then((face) => {
			// The timeout already won: close the late face instead of leaking it.
			if (timedOut) {
				face.close();
				return null;
			}
			return face;
		});
		const face = await Promise.race([attempt, timeout]);
		if (face === null) return null;
		face.close();
		return Date.now() - start;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

