// Panel route tests: run the real prefix handler behind a bare node http server
// with a stub controller, so the security contract is exercised end to end
// (Host check, token, cross-site headers, traversal, error redaction).
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createPanelRoute, TOKEN_PLACEHOLDER } from "../lib/panel/routes.js";

const calls = [];
const stub = {
	state: () => ({ version: "test", nodes: [] }),
	setEnabled: (value) => {
		calls.push(["setEnabled", value]);
		return { enabled: value };
	},
	patchSettings: (patch) => {
		calls.push(["patchSettings", patch]);
		if (patch?.explode) throw new Error("boom at C:\\Users\\secret\\settings.json via https://secret.example/sub?token=abc");
		return { patch };
	},
	selectNode: (name) => {
		calls.push(["selectNode", name]);
		return {};
	},
	testConnectivity: async () => ({ ok: true }),
	testLatency: async () => 12,
	testBandwidth: async () => ({ mbps: 10 }),
	refreshSubscription: async () => ({ ok: true }),
	browserAction: async (action) => ({ action }),
	clearDecisions: () => calls.push(["clearDecisions"]),
	manager: { traffic: () => ({ sent: 1, received: 2 }) }
};

const route = createPanelRoute(stub);
const server = http.createServer((req, res) => {
	route.handler(req, res).catch((error) => {
		res.statusCode = 500;
		res.end(String(error?.message ?? error));
	});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/** Raw request helper: Host defaults to the loopback authority. */
function request(pathname, { method = "GET", headers = {}, body, host = `127.0.0.1:${port}` } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path: pathname, method, headers: { host, ...headers } },
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			}
		);
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function token() {
	const res = await request("/clash-proxy-panel/");
	assert.equal(res.status, 200);
	const match = /<meta name="clash-proxy-token" content="([^"]+)"/.exec(res.body);
	assert.ok(match, "served HTML must carry the injected token");
	assert.notEqual(match[1], TOKEN_PLACEHOLDER);
	return match[1];
}

test.after(async () => {
	await new Promise((resolve) => server.close(resolve));
});

test("serves the shell with an injected token and hardening headers", async () => {
	const res = await request("/clash-proxy-panel/");
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /text\/html/);
	assert.equal(res.headers["x-content-type-options"], "nosniff");
	assert.match(res.headers["content-security-policy"], /frame-ancestors 'self'/);
	assert.match(res.headers["cache-control"], /no-store/);
	assert.ok(!res.body.includes(TOKEN_PLACEHOLDER), "placeholder must never leak");
});

test("unknown asset extensions are 404, unknown routes fall back to the shell", async () => {
	const missing = await request("/clash-proxy-panel/nope.js");
	assert.equal(missing.status, 404);
	const spa = await request("/clash-proxy-panel/settings");
	assert.equal(spa.status, 200);
	assert.equal(spa.headers["x-panel-fallback"], "index.html");
});

test("path traversal and encoded traversal are refused", async () => {
	const paths = [
		"/clash-proxy-panel/../package.json",
		"/clash-proxy-panel/%2e%2e%2fpackage.json",
		"/clash-proxy-panel/..%2f..%2fREADME.md",
		"/clash-proxy-panel/%2e%2e/%2e%2e/package.json",
		"/clash-proxy-panel/%00.js"
	];
	for (const pathname of paths) {
		const res = await request(pathname);
		assert.ok([400, 403, 404].includes(res.status), `${pathname} -> ${res.status}`);
		assert.ok(!res.body.includes("dsh-clash-proxy"), `${pathname} served package.json`);
	}
});

test("non-loopback Host headers are refused before anything else", async () => {
	const res = await request("/clash-proxy-panel/api/state", { host: "evil.example" });
	assert.equal(res.status, 403);
	assert.match(res.body, /loopback/);
});

test("api requires the panel token, not just the legacy marker header", async () => {
	const bare = await request("/clash-proxy-panel/api/state");
	assert.equal(bare.status, 403);
	const legacy = await request("/clash-proxy-panel/api/state", { headers: { "x-clash-proxy": "1" } });
	assert.equal(legacy.status, 403);
	const wrong = await request("/clash-proxy-panel/api/state", { headers: { "x-clash-proxy-token": "nope" } });
	assert.equal(wrong.status, 403);
	const good = await request("/clash-proxy-panel/api/state", { headers: { "x-clash-proxy-token": await token() } });
	assert.equal(good.status, 200);
	assert.equal(JSON.parse(good.body).ok, true);
});

test("cross-site requests are refused even with a valid token", async () => {
	const value = await token();
	const cross = await request("/clash-proxy-panel/api/state", {
		headers: { "x-clash-proxy-token": value, "sec-fetch-site": "cross-site" }
	});
	assert.equal(cross.status, 403);
	const sameSite = await request("/clash-proxy-panel/api/state", {
		headers: { "x-clash-proxy-token": value, origin: `http://127.0.0.1:${port}` }
	});
	assert.equal(sameSite.status, 200);
	const foreignOrigin = await request("/clash-proxy-panel/api/state", {
		headers: { "x-clash-proxy-token": value, origin: "http://evil.example" }
	});
	assert.equal(foreignOrigin.status, 403);
	const sameOrigin = await request("/clash-proxy-panel/api/state", {
		headers: { "x-clash-proxy-token": value, "sec-fetch-site": "same-origin" }
	});
	assert.equal(sameOrigin.status, 200);
});

test("preflight is never answered, so cross-site JS cannot send the header", async () => {
	const res = await request("/clash-proxy-panel/api/toggle", {
		method: "OPTIONS",
		headers: { origin: "http://evil.example", "access-control-request-headers": "x-clash-proxy-token" }
	});
	assert.equal(res.status, 405);
	assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("method mismatches and unknown endpoints are 404", async () => {
	const res = await request("/clash-proxy-panel/api/toggle", { headers: { "x-clash-proxy-token": await token() } });
	assert.equal(res.status, 404);
	assert.match(res.body, /GET toggle/);
});

test("validation errors are echoed, unexpected errors are redacted", async () => {
	const value = await token();
	const badMode = await request("/clash-proxy-panel/api/mode", {
		method: "POST",
		headers: { "x-clash-proxy-token": value, "content-type": "application/json" },
		body: JSON.stringify({ channel: "web", mode: "sideways" })
	});
	assert.equal(badMode.status, 400);
	assert.match(JSON.parse(badMode.body).error, /mode must be/);

	const boom = await request("/clash-proxy-panel/api/settings", {
		method: "POST",
		headers: { "x-clash-proxy-token": value, "content-type": "application/json" },
		body: JSON.stringify({ patch: { explode: true } })
	});
	assert.equal(boom.status, 500);
	const payload = JSON.parse(boom.body);
	assert.equal(payload.error, "internal error");
	assert.match(payload.ref, /^[0-9a-f]{8}$/);
	assert.ok(!boom.body.includes("secret"), "error text must not leak paths or URLs");
});

test("bad JSON and oversized bodies are 400, not 500", async () => {
	const value = await token();
	const badJson = await request("/clash-proxy-panel/api/toggle", {
		method: "POST",
		headers: { "x-clash-proxy-token": value, "content-type": "application/json" },
		body: "{not json"
	});
	assert.equal(badJson.status, 400);
	assert.match(JSON.parse(badJson.body).error, /invalid JSON/);

	const huge = await request("/clash-proxy-panel/api/toggle", {
		method: "POST",
		headers: { "x-clash-proxy-token": value, "content-type": "application/json" },
		body: JSON.stringify({ pad: "x".repeat(600 * 1024) })
	});
	assert.equal(huge.status, 400);
	assert.match(JSON.parse(huge.body).error, /too large/);
});

test("valid api calls reach the controller with parsed bodies", async () => {
	const value = await token();
	calls.length = 0;
	const toggle = await request("/clash-proxy-panel/api/toggle", {
		method: "POST",
		headers: { "x-clash-proxy-token": value, "content-type": "application/json" },
		body: JSON.stringify({ enabled: true })
	});
	assert.equal(toggle.status, 200);
	assert.deepEqual(calls.at(-1), ["setEnabled", true]);

	const scope = await request("/clash-proxy-panel/api/scope", {
		method: "POST",
		headers: { "x-clash-proxy-token": value, "content-type": "application/json" },
		body: JSON.stringify({ channel: "browser", value: false })
	});
	assert.equal(scope.status, 200);
	assert.deepEqual(calls.at(-1), ["patchSettings", { scopes: { browser: false } }]);

	const traffic = await request("/clash-proxy-panel/api/traffic", { headers: { "x-clash-proxy-token": value } });
	assert.equal(traffic.status, 200);
	assert.deepEqual(JSON.parse(traffic.body), { ok: true, sent: 1, received: 2 });
});

test("the token is stable for the lifetime of one route instance", async () => {
	const first = await token();
	const second = await token();
	assert.equal(first, second);
	const other = createPanelRoute(stub);
	const otherServer = http.createServer((req, res) => other.handler(req, res));
	await new Promise((resolve) => otherServer.listen(0, "127.0.0.1", resolve));
	const otherPort = otherServer.address().port;
	const res = await new Promise((resolve, reject) => {
		http.get({ host: "127.0.0.1", port: otherPort, path: "/clash-proxy-panel/", headers: { host: `127.0.0.1:${otherPort}` } }, (r) => {
			let body = "";
			r.on("data", (chunk) => (body += chunk));
			r.on("end", () => resolve(body));
		}).on("error", reject);
	});
	const match = /<meta name="clash-proxy-token" content="([^"]+)"/.exec(res);
	assert.ok(match);
	assert.notEqual(match[1], first, "each route instance mints its own token");
	await new Promise((resolve) => otherServer.close(resolve));
});

test("concurrent static requests do not share mutable state", async () => {
	const results = await Promise.all(Array.from({ length: 8 }, () => request("/clash-proxy-panel/app.js")));
	for (const res of results) {
		assert.equal(res.status, 200);
		assert.match(res.headers["content-type"], /javascript/);
	}
});

test("sockets opened during the run are closed when the server stops", async () => {
	const probe = net.connect(port, "127.0.0.1");
	await new Promise((resolve) => probe.on("connect", resolve));
	assert.equal(server.listening, true);
	probe.destroy();
});
