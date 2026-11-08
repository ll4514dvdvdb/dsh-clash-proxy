// Node http/https interception tests: CONNECT handshake edge cases, wrapper
// install/dispose semantics, caller-agent precedence, loopback bypass.
// No external network: a local fake CONNECT proxy and local targets are used.
import { test as base } from "node:test";
const test = Object.assign((name, fn) => base(name, { timeout: 5000 }, fn), { after: base.after, before: base.before });
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { connectTunnel, HttpsTunnelAgent, installNodeTunnel, isNodeTunnelInstalled } from "../lib/core/tunnel.js";

const originalHttp = http.request;
const originalHttps = https.request;
const cleanups = [];

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

async function httpTarget(handler) {
	const server = http.createServer(handler);
	const port = await listen(server);
	cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
	return { server, port };
}

function trackSockets(server) {
	const sockets = new Set();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	return () => {
		for (const socket of sockets) socket.destroy();
	};
}


async function tcpServer(onConnection) {
	const server = net.createServer(onConnection);
	const drop = trackSockets(server);
	const port = await listen(server);
	cleanups.push(() => new Promise((resolve) => { drop(); server.close(() => resolve()); }));
	return { server, port };
}

/** Minimal CONNECT proxy; `mode` selects the failure behaviour under test. */
async function fakeProxy(mode = "tunnel") {
	const seen = [];
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("error", () => {});
		socket.on("data", function onData(chunk) {
			buffer += chunk.toString("latin1");
			const end = buffer.indexOf("\r\n\r\n");
			if (end === -1) {
				if (buffer.length > 128 * 1024) socket.destroy();
				return;
			}
			socket.off("data", onData);
			const line = buffer.slice(0, buffer.indexOf("\r\n"));
			seen.push(line);
			if (mode === "refuse") {
				socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
				return;
			}
			if (mode === "oversize") {
				socket.write(`HTTP/1.1 200 Connection Established\r\nX-Pad: ${"a".repeat(40 * 1024)}`);
				return;
			}
			if (mode === "close") {
				socket.destroy();
				return;
			}
			if (mode === "silent") return;
			const target = /^CONNECT (\S+) HTTP\//.exec(line)?.[1] ?? "";
			const port = Number(target.slice(target.lastIndexOf(":") + 1));
			const upstream = net.connect(port, "127.0.0.1", () => {
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (mode === "banner") socket.write("banner\n");
				const rest = buffer.slice(end + 4);
				if (rest.length > 0) upstream.write(rest);
				socket.pipe(upstream);
				upstream.pipe(socket);
			});
			upstream.on("error", () => socket.destroy());
		});
	});
	const drop = trackSockets(server);
	const port = await listen(server);
	cleanups.push(() => new Promise((resolve) => { drop(); server.close(() => resolve()); }));
	return { port, seen };
}

function send(options, mod = http) {
	return new Promise((resolve, reject) => {
		const req = mod.request(options, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

function expectError(promise, pattern) {
	return promise.then(
		() => assert.fail(`expected the request to fail (${pattern})`),
		(error) => assert.match(String(error?.message ?? error), pattern)
	);
}

test.after(async () => {
	http.request = originalHttp;
	https.request = originalHttps;
	http.globalAgent.destroy();
	https.globalAgent.destroy();
	for (const close of cleanups.reverse()) await close();
});

test("plain HTTP through CONNECT (options object)", async () => {
	const target = await httpTarget((req, res) => res.end(`ok:${req.url}`));
	const proxy = await fakeProxy();
	const dispose = installNodeTunnel(() => ({ useProxy: true, port: proxy.port }));
	try {
		const res = await send({ host: "fake.test", port: target.port, path: "/x" });
		assert.deepEqual(res, { status: 200, body: "ok:/x" });
		assert.equal(proxy.seen.length, 1);
		assert.equal(proxy.seen[0], `CONNECT fake.test:${target.port} HTTP/1.1`);
	} finally {
		dispose();
	}
});

test("URL string and URL instance are proxied too", async () => {
	const target = await httpTarget((req, res) => res.end(`ok:${req.url}`));
	const proxy = await fakeProxy();
	const dispose = installNodeTunnel(() => ({ useProxy: true, port: proxy.port }));
	try {
		const viaString = await new Promise((resolve, reject) => {
			const req = http.request(`http://fake.test:${target.port}/str`, (res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve(body));
			});
			req.on("error", reject);
			req.end();
		});
		const viaUrl = await new Promise((resolve, reject) => {
			const req = http.request(new URL(`http://fake.test:${target.port}/obj`), (res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve(body));
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal(viaString, "ok:/str");
		assert.equal(viaUrl, "ok:/obj");
		assert.equal(proxy.seen.length, 2);
	} finally {
		dispose();
	}
});

test("caller-supplied agent wins over the tunnel", async () => {
	const target = await httpTarget((req, res) => res.end("direct"));
	const proxy = await fakeProxy();
	const dispose = installNodeTunnel(() => ({ useProxy: true, port: proxy.port }));
	const agent = new http.Agent({ keepAlive: false });
	try {
		// fake.test does not resolve, so a bypassed request must fail with a DNS error.
		await expectError(send({ host: "fake.test", port: target.port, agent }), /getaddrinfo|ENOTFOUND|EAI_AGAIN/);
		assert.equal(proxy.seen.length, 0, "no CONNECT for a request that carries its own agent");
	} finally {
		agent.destroy();
		dispose();
	}
});

test("loopback destinations bypass the tunnel", async () => {
	const target = await httpTarget((req, res) => res.end("direct"));
	const proxy = await fakeProxy();
	const dispose = installNodeTunnel(() => ({ useProxy: true, port: proxy.port }));
	try {
		const res = await send({ host: "127.0.0.1", port: target.port, path: "/loop" });
		assert.deepEqual(res, { status: 200, body: "direct" });
		assert.equal(proxy.seen.length, 0);
	} finally {
		dispose();
	}
});

test("proxy refusals and broken replies surface as request errors", async () => {
	const refuse = await fakeProxy("refuse");
	const disposeRefuse = installNodeTunnel(() => ({ useProxy: true, port: refuse.port }));
	try {
		await expectError(send({ host: "fake.test", port: 443 }), /tunnel refused .*403/);
	} finally {
		disposeRefuse();
	}

	const oversize = await fakeProxy("oversize");
	const disposeOversize = installNodeTunnel(() => ({ useProxy: true, port: oversize.port }));
	try {
		await expectError(send({ host: "fake.test", port: 443 }), /head too large/);
	} finally {
		disposeOversize();
	}

	const closing = await fakeProxy("close");
	const disposeClose = installNodeTunnel(() => ({ useProxy: true, port: closing.port }));
	try {
		await expectError(send({ host: "fake.test", port: 443 }), /closed before the CONNECT reply/);
	} finally {
		disposeClose();
	}
});

test("connectTunnel timeout and early-banner preservation", async () => {
	const silent = await fakeProxy("silent");
	await expectError(
		new Promise((resolve, reject) => connectTunnel(silent.port, "fake.test", 443, (error) => (error ? reject(error) : resolve()), { timeoutMs: 150 })),
		/tunnel timeout/
	);

	const banner = await fakeProxy("banner");
	const echo = await tcpServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
	const socket = await new Promise((resolve, reject) => {
		connectTunnel(banner.port, "fake.test", echo.port, (error, s) => (error ? reject(error) : resolve(s)), { timeoutMs: 2000 });
	});
	const firstChunk = await new Promise((resolve, reject) => {
		socket.once("data", (chunk) => resolve(chunk.toString("latin1")));
		socket.once("error", reject);
	});
	socket.destroy();
	assert.match(firstChunk, /banner/);
});

test("TLS handshake timeout is enforced", async () => {
	const deadTarget = await tcpServer(() => {});
	const proxy = await fakeProxy();
	const agent = new HttpsTunnelAgent(proxy.port, { tlsTimeoutMs: 200 });
	const error = await new Promise((resolve) => {
		agent.createConnection({ hostname: "fake.test", port: deadTarget.port }, (err) => resolve(err));
	});
	assert.match(String(error?.message ?? error), /TLS handshake timeout/);
});

test("https through the tunnel reports TLS failures to the caller", async () => {
	const plain = await tcpServer((socket) => socket.end("definitely not TLS\n"));
	const proxy = await fakeProxy();
	const dispose = installNodeTunnel(() => ({ useProxy: true, port: proxy.port }));
	try {
		await expectError(
			new Promise((resolve, reject) => {
				const req = https.request({ hostname: "fake.test", port: plain.port, rejectUnauthorized: false }, () => resolve());
				req.on("error", reject);
				req.end();
			}),
			// Node 20/22 surface "wrong version number"/"socket hang up", Node 24
			// "disconnected before secure TLS", Node 22's OpenSSL can say "packet
			// length too long". Any of those means the failure reached the caller.
			/EPROTO|wrong version number|socket hang up|disconnected before secure TLS|packet length too long|SSL routines/i
		);
		assert.equal(proxy.seen.length, 1);
	} finally {
		dispose();
	}
});

test("installing twice is idempotent; dispose restores only our own wrapper", async () => {
	const before = http.request;
	const disposeA = installNodeTunnel(() => null);
	const disposeB = installNodeTunnel(() => null);
	assert.equal(isNodeTunnelInstalled(), true);
	const installed = http.request;
	disposeA();
	assert.equal(isNodeTunnelInstalled(), true, "still installed while a second reference is held");
	assert.equal(http.request, installed);
	disposeB();
	assert.equal(isNodeTunnelInstalled(), false);
	assert.equal(http.request, before);
});

test("a foreign wrapper installed after ours survives our dispose", async () => {
	const target = await httpTarget((req, res) => res.end("through-foreign"));
	const proxy = await fakeProxy();
	const before = http.request;
	const dispose = installNodeTunnel(() => ({ useProxy: true, port: proxy.port }));
	const foreignCalls = [];
	const foreign = (input, ...rest) => {
		foreignCalls.push(input);
		return originalHttp.call(http, input, ...rest);
	};
	http.request = foreign;
	try {
		dispose();
		assert.equal(http.request, foreign, "foreign wrapper must not be overwritten");
		assert.equal(isNodeTunnelInstalled(), false);
		const res = await send({ host: "127.0.0.1", port: target.port, path: "/f" });
		assert.deepEqual(res, { status: 200, body: "through-foreign" });
		assert.equal(foreignCalls.length, 1);
		assert.equal(proxy.seen.length, 0, "disposed wrappers pass straight through");
	} finally {
		http.request = before;
	}
});

test("a port change mid-flight keeps the in-flight request alive", async () => {
	const target = await httpTarget((req, res) => {
		const delay = req.url === "/slow" ? 150 : 0;
		setTimeout(() => res.end(`done:${req.url}`), delay);
	});
	const proxyA = await fakeProxy();
	const proxyB = await fakeProxy();
	let current = proxyA.port;
	const dispose = installNodeTunnel(() => ({ useProxy: true, port: current }));
	try {
		const slow = send({ host: "fake.test", port: target.port, path: "/slow" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		current = proxyB.port;
		const fast = send({ host: "fake.test", port: target.port, path: "/fast" });
		const [slowRes, fastRes] = await Promise.all([slow, fast]);
		assert.deepEqual(slowRes, { status: 200, body: "done:/slow" });
		assert.deepEqual(fastRes, { status: 200, body: "done:/fast" });
		assert.equal(proxyA.seen.length, 1);
		assert.equal(proxyB.seen.length, 1);
	} finally {
		dispose();
	}
});

test("cancelling a tunnelled request does not leak or crash", async () => {
	const target = await httpTarget((req, res) => setTimeout(() => res.end("late"), 200));
	const proxy = await fakeProxy();
	const dispose = installNodeTunnel(() => ({ useProxy: true, port: proxy.port }));
	try {
		await new Promise((resolve) => {
			const req = http.request({ host: "fake.test", port: target.port, path: "/cancel" }, () => {});
			req.on("error", () => resolve());
			req.end();
			setTimeout(() => {
				req.destroy();
				resolve();
			}, 40);
		});
	} finally {
		dispose();
	}
});
