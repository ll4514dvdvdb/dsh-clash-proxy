import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
	SocketBuffer,
	connectThrough,
	encodeAddr,
	ipv6Bytes,
	measureLatency,
} from "../lib/core/transports.js";

/**
 * Transports tests: wire formats (IPv6 address encoding above all), the
 * upstream SOCKS5/HTTP handshakes, connect timeouts and the latency probe's
 * socket cleanup. All servers are local fixtures on 127.0.0.1.
 */

const cleanup = [];

function listen(server) {
	cleanup.push(server);
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function tcpServer(onConnection) {
	const server = net.createServer((socket) => {
		server.sockets.add(socket);
		socket.on("close", () => server.sockets.delete(socket));
		socket.on("error", () => {});
		onConnection(socket);
	});
	server.sockets = new Set();
	server.port = await listen(server);
	return server;
}

function connectTo(port) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1");
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function readBytes(socket, count, timeoutMs = 3000) {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => reject(new Error("timeout reading bytes")), timeoutMs);
		const onData = (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length >= count) {
				cleanupReader();
				resolve(buffer.subarray(0, count));
			}
		};
		const cleanupReader = () => {
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("error", onError);
		};
		const onError = (error) => {
			cleanupReader();
			reject(error);
		};
		socket.on("data", onData);
		socket.once("error", onError);
	});
}

test.after(() => {
	for (const item of cleanup.reverse()) {
		try {
			if (typeof item.port === "number") {
				for (const socket of item.sockets ?? []) socket.destroy();
				item.close();
			} else {
				item.close();
			}
		} catch {}
	}
});

test("ipv6Bytes expands every IPv6 form to 16 bytes", () => {
	assert.equal(ipv6Bytes("2001:db8::1").toString("hex"), "20010db8000000000000000000000001");
	assert.equal(ipv6Bytes("::1").toString("hex"), "00000000000000000000000000000001");
	assert.equal(ipv6Bytes("::").toString("hex"), "00000000000000000000000000000000");
	assert.equal(ipv6Bytes("::ffff:1.2.3.4").toString("hex"), "00000000000000000000ffff01020304");
	assert.equal(ipv6Bytes("[2001:db8::1]").toString("hex"), "20010db8000000000000000000000001");
	assert.equal(ipv6Bytes("1:2:3:4:5:6:7:8").toString("hex"), "00010002000300040005000600070008");
	// A single omitted group ("1::8") fills exactly one zero group.
	assert.equal(ipv6Bytes("1::8").toString("hex"), "00010000000000000000000000000008");
});

test("ipv6Bytes rejects malformed input", () => {
	for (const host of ["", ":::", "1::2::3", "12345::1", "fe80::1%eth0", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "::::", "1:2:3:4:5:6:7:8::"]) {
		assert.equal(ipv6Bytes(host), null, `expected null for ${JSON.stringify(host)}`);
		assert.equal(ipv6Bytes(host), null);
	}
});

test("encodeAddr picks the right address type", () => {
	assert.deepEqual([...encodeAddr("127.0.0.1", 80)], [0x01, 127, 0, 0, 1, 0, 80]);
	const v6 = encodeAddr("2001:db8::1", 443);
	assert.equal(v6[0], 0x04);
	assert.equal(v6.length, 1 + 16 + 2);
	assert.equal(v6.subarray(1, 17).toString("hex"), "20010db8000000000000000000000001");
	assert.deepEqual([...v6.subarray(17)], [0x01, 0xbb]);
	const domain = encodeAddr("example.com", 8080);
	assert.equal(domain[0], 0x03);
	assert.equal(domain[1], 11);
	assert.equal(domain.subarray(2, 13).toString(), "example.com");
	assert.deepEqual([...domain.subarray(13)], [8080 >> 8, 8080 & 0xff]);
});

test("a compressed IPv6 target is encoded correctly in a SOCKS5 handshake", async () => {
	const seen = [];
	const server = await tcpServer((socket) => {
		socket.on("data", (chunk) => {
			seen.push(chunk);
			if (seen.length === 1) socket.write(Buffer.from([0x05, 0x00]));
			else if (seen.length === 2) socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
		});
	});
	const face = await connectThrough({ type: "socks5", server: "127.0.0.1", port: server.port }, "2001:db8::1", 443);
	assert.deepEqual([...seen[0]], [0x05, 0x01, 0x00]);
	const request = seen[1];
	assert.deepEqual([...request.subarray(0, 4)], [0x05, 0x01, 0x00, 0x04]);
	assert.equal(request.subarray(4, 20).toString("hex"), "20010db8000000000000000000000001");
	assert.deepEqual([...request.subarray(20)], [0x01, 0xbb]);
	face.close();
});

test("socks5Connect reports upstream failure codes", async () => {
	const server = await tcpServer((socket) => {
		socket.once("data", () => socket.write(Buffer.from([0x05, 0x00])));
		socket.once("data", () => socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
	});
	await assert.rejects(connectThrough({ type: "socks5", server: "127.0.0.1", port: server.port }, "example.com", 80), /code 5/);
});

test("socks5Connect performs username/password auth when configured", async () => {
	let authPacket = null;
	const server = await tcpServer((socket) => {
		let step = 0;
		socket.on("data", (chunk) => {
			step += 1;
			if (step === 1) socket.write(Buffer.from([0x05, 0x02]));
			else if (step === 2) {
				authPacket = Buffer.from(chunk);
				socket.write(Buffer.from([0x01, 0x00]));
			} else if (step === 3) socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
		});
	});
	const face = await connectThrough({ type: "socks5", server: "127.0.0.1", port: server.port, username: "user", password: "pass" }, "example.com", 80);
	assert.deepEqual([...authPacket.subarray(0, 2)], [0x01, 4]);
	assert.equal(authPacket.subarray(2, 6).toString(), "user");
	assert.equal(authPacket[6], 4);
	assert.equal(authPacket.subarray(7, 11).toString(), "pass");
	face.close();
});

test("httpConnect sends CONNECT, optional basic auth, and rejects 407", async () => {
	const seen = [];
	const proxy = await tcpServer((socket) => {
		socket.once("data", (chunk) => {
			seen.push(chunk.toString("latin1"));
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		});
	});
	const face = await connectThrough({ type: "http", server: "127.0.0.1", port: proxy.port, username: "u", password: "p" }, "target.test", 8443);
	assert.match(seen[0], /^CONNECT target\.test:8443 HTTP\/1\.1\r\n/);
	assert.match(seen[0], /\r\nHost: target\.test:8443\r\n/);
	assert.match(seen[0], /\r\nProxy-Authorization: Basic dTpw\r\n/);
	assert.match(seen[0], /\r\n\r\n$/);
	face.close();

	const rejecting = await tcpServer((socket) => {
		socket.once("data", () => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
	});
	await assert.rejects(
		connectThrough({ type: "http", server: "127.0.0.1", port: rejecting.port }, "target.test", 443),
		/http upstream CONNECT failed: HTTP\/1\.1 407/,
	);
});

test("tlsConnect times out on a peer that never completes the handshake", async () => {
	const silent = await tcpServer(() => {});
	const node = { type: "http", server: "127.0.0.1", port: silent.port, tls: true };
	const started = Date.now();
	await assert.rejects(connectThrough(node, "example.com", 443, { timeoutMs: 300 }), /tls connect timeout/);
	assert.ok(Date.now() - started < 3000);
});

test("measureLatency returns a number for a reachable node and null when it fails", async () => {
	const echo = await tcpServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
	const ok = await measureLatency({ type: "direct" }, "127.0.0.1", echo.port, 1500);
	assert.equal(typeof ok, "number");
	assert.ok(ok >= 0);
	const dead = await measureLatency({ type: "direct" }, "127.0.0.1", 1, 800);
	assert.equal(dead, null);
});

test("measureLatency closes the face when the timeout wins the race", async () => {
	let accepted = null;
	let closed = false;
	const slow = await tcpServer((socket) => {
		accepted = socket;
		// The server has to consume its input, otherwise the peer's close is not
		// observable on this side (a paused socket keeps the close queued).
		socket.resume();
		socket.on("close", () => {
			closed = true;
		});
		// Complete the upstream CONNECT only after the probe has already timed out.
		setTimeout(() => {
			if (!socket.destroyed) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		}, 400);
	});
	const started = Date.now();
	const result = await measureLatency({ type: "http", server: "127.0.0.1", port: slow.port }, "example.com", 443, 120);
	assert.equal(result, null);
	assert.ok(Date.now() - started < 350);
	assert.ok(accepted !== null);
	// The late face must be closed once the handshake finally completes.
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(closed, true);
});

test("SocketBuffer pauses the socket when the consumer falls behind", async () => {
	const total = 2 * 1024 * 1024;
	const server = await tcpServer((socket) => {
		socket.write(Buffer.alloc(total, 0x61));
	});
	const socket = await connectTo(server.port);
	const buffer = new SocketBuffer(socket);
	await new Promise((resolve) => setTimeout(resolve, 200));
	// More than HIGH_WATER is queued and nobody is reading: the socket is paused.
	assert.equal(socket.isPaused(), true);
	let received = 0;
	const deadline = Date.now() + 5000;
	while (received < total && Date.now() < deadline) {
		const chunk = await buffer.readAny();
		if (chunk === null) break;
		received += chunk.length;
	}
	// Draining below LOW_WATER must resume the socket, otherwise the tail would
	// never arrive.
	assert.equal(received, total);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(socket.isPaused(), false);
	socket.destroy();
});

test("SocketBuffer rejects pending readers after a socket error", async () => {
	const sockets = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
	});
	const port = await listen(server);
	const socket = await connectTo(port);
	const buffer = new SocketBuffer(socket);
	const pending = buffer.read(4);
	socket.destroy(new Error("boom"));
	await assert.rejects(pending, /boom/);
	await assert.rejects(buffer.read(1), /boom/);
	for (const other of sockets) other.destroy();
	socket.destroy();
});

test("an upstream that accepts TCP but never answers CONNECT times out", async () => {
	// A tarpit: the TCP handshake succeeds, then the peer says nothing. tcpConnect
	// alone cannot notice this — the protocol handshake needs its own deadline.
	const sockets = new Set();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		// Resume, otherwise the FIN from a destroyed peer is never observed (a
		// paused socket queues it) and the close assertion below would fail.
		socket.resume();
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		const started = Date.now();
		await assert.rejects(
			connectThrough({ type: "http", server: "127.0.0.1", port }, "example.com", 443, { timeoutMs: 300 }),
			/upstream handshake timeout after 300ms/
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 280 && elapsed < 3000, `timeout fired after ${elapsed}ms`);
		// The dial keeps running after the race is lost; it must close its face and
		// with it the socket, not leak one connection per hung handshake.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(sockets.size, 0, "the timed-out dial must not leave its socket open");
	} finally {
		for (const socket of sockets) socket.destroy();
		server.close();
	}
});
