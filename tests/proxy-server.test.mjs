import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { ProxyServer, defaultPortFor, parseConnectTarget } from "../lib/core/proxy-server.js";
import { RuleEngine } from "../lib/core/rules.js";

/**
 * ProxyServer tests.
 *
 * Everything runs on 127.0.0.1 with ephemeral ports: a raw HTTP target, a raw
 * TCP echo target, a fake upstream HTTP proxy, and the ProxyServer under test.
 * Sockets are tracked so the process can exit.
 */

const cleanup = [];

/** Attach a persistent reader to a socket (no data is lost between waits). */
function makeReader(socket) {
	let buffer = Buffer.alloc(0);
	let pending = null;
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		if (pending !== null && pending.test(buffer)) {
			const current = pending;
			pending = null;
			clearTimeout(current.timer);
			current.resolve(buffer);
		}
	});
	const closed = new Promise((resolve) => {
		socket.on("close", () => {
			if (pending !== null) {
				const current = pending;
				pending = null;
				clearTimeout(current.timer);
				current.reject(new Error("socket closed before the expected reply"));
			}
			resolve(buffer);
		});
		socket.on("error", () => {});
	});
	return {
		write(data) {
			socket.write(data);
		},
		waitFor(test, timeoutMs = 4000) {
			return new Promise((resolve, reject) => {
				if (test(buffer)) return resolve(buffer);
				const timer = setTimeout(() => {
					if (pending !== null) pending = null;
					reject(new Error(`timeout waiting for data (got ${buffer.length} bytes: ${JSON.stringify(buffer.toString("latin1").slice(0, 200))})`));
				}, timeoutMs);
				pending = { test, resolve, reject, timer };
			});
		},
		closed,
		get text() {
			return buffer.toString("latin1");
		},
	};
}

function connectTo(port) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1");
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function listen(server) {
	cleanup.push(server);
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** Local plain-HTTP target that echoes the request line and a few headers. */
async function httpTarget() {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/plain", "x-path": req.url });
		res.end(`method=${req.method} url=${req.url} host=${req.headers.host ?? ""} proxy-connection=${req.headers["proxy-connection"] ?? ""}`);
	});
	const port = await listen(server);
	cleanup.push(server);
	return port;
}

/** Local TCP server that echoes everything back. */
async function echoServer() {
	const server = net.createServer((socket) => {
		socket.on("data", (chunk) => socket.write(chunk));
		socket.on("error", () => {});
	});
	const port = await listen(server);
	return port;
}

/** Minimal CONNECT proxy standing in for an upstream node. */
async function fakeUpstreamProxy() {
	const seen = [];
	const server = net.createServer((client) => {
		client.once("data", (chunk) => {
			const head = chunk.toString("latin1");
			const match = /^CONNECT ([^ ]+) HTTP\/1\.1/.exec(head);
			if (match === null) {
				client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
				return;
			}
			seen.push(match[1]);
			const colon = match[1].lastIndexOf(":");
			// The fixture plays DNS for the fake node domain.
			const host = match[1].slice(0, colon) === "remote.test" ? "127.0.0.1" : match[1].slice(0, colon);
			const port = Number(match[1].slice(colon + 1));
			const upstream = net.connect(port, host);
			upstream.on("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				upstream.pipe(client);
				client.pipe(upstream);
			});
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream.destroy());
		});
	});
	const port = await listen(server);
	return { port, seen, server };
}

function makeServer({ rules = [], resolveNode = () => null } = {}) {
	const engine = new RuleEngine({ extraRules: rules });
	const server = new ProxyServer({ engine, resolveNode });
	cleanup.push(server);
	return server;
}

test.after(() => {
	for (const item of cleanup.reverse()) {
		try {
			if (typeof item.stop === "function") item.stop();
			else if (typeof item.close === "function") item.close();
		} catch {}
	}
});

test("parseConnectTarget accepts authority forms and rejects junk", () => {
	assert.deepEqual(parseConnectTarget("example.com:443"), { host: "example.com", port: 443 });
	assert.deepEqual(parseConnectTarget("[2001:db8::1]:8443"), { host: "2001:db8::1", port: 8443 });
	assert.deepEqual(parseConnectTarget("127.0.0.1:80"), { host: "127.0.0.1", port: 80 });
	assert.equal(parseConnectTarget("example.com"), null);
	assert.equal(parseConnectTarget(":443"), null);
	assert.equal(parseConnectTarget("[::1]443"), null);
	assert.equal(parseConnectTarget("[::1]:0"), null);
	assert.equal(parseConnectTarget("example.com:65536"), null);
	assert.equal(parseConnectTarget("example.com:44a"), null);
	assert.equal(parseConnectTarget("bad host:443"), null);
	assert.equal(parseConnectTarget("example.com:443\r\nX: y"), null);
	assert.equal(parseConnectTarget(""), null);
	assert.equal(parseConnectTarget(undefined), null);
});

test("defaultPortFor follows the scheme", () => {
	assert.equal(defaultPortFor("https:"), 443);
	assert.equal(defaultPortFor("http:"), 80);
	assert.equal(defaultPortFor("ftp:"), 80);
});

test("absolute-form HTTP requests are rewritten and relayed direct", async () => {
	const target = await httpTarget();
	const proxy = makeServer({ rules: ["IP-CIDR,127.0.0.0/8,DIRECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`GET http://127.0.0.1:${target}/hello?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nProxy-Connection: keep-alive\r\nUser-Agent: probe\r\n\r\n`);
	const reply = (await reader.closed).toString("latin1");
	assert.match(reply, /^HTTP\/1\.1 200 /);
	assert.match(reply, /method=GET url=\/hello\?q=1/);
	assert.match(reply, /proxy-connection=$/m);
	assert.match(reply, new RegExp(`host=127\\.0\\.0\\.1:${target}`));
	assert.ok(proxy.counters.down > 0);
	assert.ok(proxy.counters.up > 0);
});

test("a request head split across TCP segments is still parsed", async () => {	const target = await httpTarget();
	const proxy = makeServer({ rules: ["IP-CIDR,127.0.0.0/8,DIRECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`GET http://127.0.0.1:${target}/split HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n`);
	await new Promise((resolve) => setTimeout(resolve, 60));
	reader.write("User-Agent: split\r\n\r\n");
	const reply = (await reader.closed).toString("latin1");
	assert.match(reply, /^HTTP\/1\.1 200 /);
	assert.match(reply, /method=GET url=\/split/);
});

test("absolute-form request bodies are forwarded, not dropped", async () => {
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(`method=${req.method} body=${Buffer.concat(chunks).toString("utf8")}`);
		});
	});
	const target = await listen(server);
	cleanup.push(server);
	const proxy = makeServer({ rules: ["IP-CIDR,127.0.0.0/8,DIRECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`POST http://127.0.0.1:${target}/echo HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nContent-Length: 11\r\n\r\n`);
	await new Promise((resolve) => setTimeout(resolve, 40));
	// Body arrives in a later segment: the proxy must relay it to the target.
	reader.write("hello=world");
	const reply = (await reader.closed).toString("utf8");
	assert.match(reply, /method=POST/);
	assert.match(reply, /body=hello=world/);
});

test("https absolute-form is refused instead of writing plaintext to port 443", async () => {
	const proxy = makeServer();
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write("GET https://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
	const reply = (await reader.closed).toString("latin1");
	assert.match(reply, /^HTTP\/1\.1 501 /);
	assert.match(reply, /use CONNECT/i);
});

test("CONNECT establishes a tunnel to a direct target", async () => {
	const echo = await echoServer();
	const proxy = makeServer({ rules: ["IP-CIDR,127.0.0.0/8,DIRECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`CONNECT 127.0.0.1:${echo} HTTP/1.1\r\nHost: 127.0.0.1:${echo}\r\n\r\n`);
	await reader.waitFor((buffer) => buffer.includes("\r\n\r\n"));
	assert.match(reader.text, /^HTTP\/1\.1 200 Connection Established/);
	reader.write("ping");
	await reader.waitFor((buffer) => buffer.includes("ping"));
	socket.destroy();
});

test("a loopback target stays direct even when the default policy says proxy", async () => {
	const echo = await echoServer();
	const upstream = await fakeUpstreamProxy();
	// No rules: the engine's default action is "proxy", and a node exists — the
	// loopback guard must still dial the local server instead of the node.
	const proxy = makeServer({ resolveNode: () => ({ name: "up", type: "http", server: "127.0.0.1", port: upstream.port }) });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`CONNECT 127.0.0.1:${echo} HTTP/1.1\r\nHost: 127.0.0.1:${echo}\r\n\r\n`);
	await reader.waitFor((buffer) => buffer.includes("\r\n\r\n"));
	assert.match(reader.text, /^HTTP\/1\.1 200 /);
	reader.write("locally");
	await reader.waitFor((buffer) => buffer.includes("locally"));
	assert.deepEqual(upstream.seen, [], "the upstream node must not be asked to dial loopback");
	socket.destroy();
});

test("CONNECT keeps payload that arrives in the same segment", async () => {
	const echo = await echoServer();
	const proxy = makeServer({ rules: ["IP-CIDR,127.0.0.0/8,DIRECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	// A pipelining client writes the CONNECT head and its first payload together.
	// The proxy pauses the socket while dialling, so the remainder pushed back with
	// unshift() must still reach the target after the relay takes over.
	reader.write(`CONNECT 127.0.0.1:${echo} HTTP/1.1\r\nHost: 127.0.0.1:${echo}\r\n\r\npipelined-first-bytes`);
	await reader.waitFor((buffer) => buffer.includes("pipelined-first-bytes"));
	assert.match(reader.text, /^HTTP\/1\.1 200 /);
	socket.destroy();
});

test("CONNECT through the upstream node reaches the target", async () => {
	const echo = await echoServer();
	const upstream = await fakeUpstreamProxy();
	const proxy = makeServer({
		rules: ["DOMAIN,remote.test,PROXY"],
		resolveNode: () => ({ name: "up", type: "http", server: "127.0.0.1", port: upstream.port }),
	});
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`CONNECT remote.test:${echo} HTTP/1.1\r\nHost: remote.test:${echo}\r\n\r\n`);
	await reader.waitFor((buffer) => buffer.includes("\r\n\r\n"));
	assert.match(reader.text, /^HTTP\/1\.1 200 /);
	reader.write("through");
	await reader.waitFor((buffer) => buffer.includes("through"));
	assert.deepEqual(upstream.seen, [`remote.test:${echo}`]);
	socket.destroy();
});

test("a proxied target without a selected node fails with 502", async () => {
	const proxy = makeServer({ rules: ["DOMAIN,remote.test,PROXY"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write("CONNECT remote.test:443 HTTP/1.1\r\nHost: remote.test\r\n\r\n");
	const reply = (await reader.closed).toString("latin1");
	assert.match(reply, /^HTTP\/1\.1 502 /);
});

test("a rejected target fails with 502 and never dials out", async () => {
	const echo = await echoServer();
	const proxy = makeServer({ rules: ["DOMAIN,blocked.test,REJECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`CONNECT blocked.test:${echo} HTTP/1.1\r\nHost: blocked.test\r\n\r\n`);
	const reply = (await reader.closed).toString("latin1");
	assert.match(reply, /^HTTP\/1\.1 502 /);
});

test("a malformed CONNECT target is a 400", async () => {
	const proxy = makeServer();
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write("CONNECT not-a-target HTTP/1.1\r\nHost: x\r\n\r\n");
	const reply = (await reader.closed).toString("latin1");
	assert.match(reply, /^HTTP\/1\.1 400 /);
});

test("an oversized request head is refused without buffering it all", async () => {
	const proxy = makeServer();
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`GET http://127.0.0.1/ HTTP/1.1\r\nX-Pad: ${"a".repeat(40 * 1024)}`);
	const reply = (await reader.closed).toString("latin1");
	assert.ok(!reply.includes("200"), `unexpected reply: ${reply.slice(0, 80)}`);
});

test("SOCKS5 greeting and request may arrive in fragments", async () => {
	const echo = await echoServer();
	const proxy = makeServer({ rules: ["IP-CIDR,127.0.0.0/8,DIRECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(Buffer.from([0x05, 0x01]));
	await new Promise((resolve) => setTimeout(resolve, 30));
	reader.write(Buffer.from([0x00]));
	await reader.waitFor((buffer) => buffer.length >= 2);
	assert.deepEqual([...reader.text].slice(0, 2).map((char) => char.charCodeAt(0)), [0x05, 0x00]);
	reader.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1]));
	await new Promise((resolve) => setTimeout(resolve, 30));
	reader.write(Buffer.from([(echo >> 8) & 0xff, echo & 0xff]));
	await reader.waitFor((buffer) => buffer.length >= 12);
	assert.equal(reader.text.charCodeAt(0), 0x05);
	assert.equal(reader.text.charCodeAt(1), 0x00);
	reader.write("socks");
	await reader.waitFor((buffer) => buffer.includes("socks"));
	socket.destroy();
});

test("SOCKS5 domain-name addressing works", async () => {
	const echo = await echoServer();
	const proxy = makeServer({ rules: ["IP-CIDR,127.0.0.0/8,DIRECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	const host = Buffer.from("127.0.0.1", "utf8");
	reader.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([(echo >> 8) & 0xff, echo & 0xff])]));
	await reader.waitFor((buffer) => buffer.length >= 12);
	assert.equal((reader.text.charCodeAt(0)), 0x05);
	reader.write("domain");
	await reader.waitFor((buffer) => buffer.includes("domain"));
	socket.destroy();
});

test("SOCKS5 rejects a rule-rejected target with a reply code", async () => {
	const proxy = makeServer({ rules: ["DOMAIN,blocked.test,REJECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	const host = Buffer.from("blocked.test", "utf8");
	reader.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x01, 0xbb])]));
	// The greeting (2 bytes) is written before the failure reply (10 bytes).
	await reader.waitFor((buffer) => buffer.length >= 12);
	assert.equal(reader.text.charCodeAt(2), 0x05);
	assert.equal(reader.text.charCodeAt(3), 0x02);
	socket.destroy();
});

test("stop() destroys sockets that are still relaying", async () => {
	const echo = await echoServer();
	const proxy = makeServer({ rules: ["IP-CIDR,127.0.0.0/8,DIRECT"] });
	const port = await proxy.start(0);
	const socket = await connectTo(port);
	const reader = makeReader(socket);
	reader.write(`CONNECT 127.0.0.1:${echo} HTTP/1.1\r\nHost: 127.0.0.1:${echo}\r\n\r\n`);
	await reader.waitFor((buffer) => buffer.includes("\r\n\r\n"));
	assert.equal(proxy.connections, 1);
	proxy.stop();
	await reader.closed;
	assert.equal(proxy.connections, 0);
});
