// Offline smoke test for the 0.2.0 panel surface.
//
// Everything here runs without the harness and without a subscription: the point is
// to prove the pieces the page depends on (settings store, route guards, static
// serving, decision cache, the node:http tunnel) behave before the plugin is loaded.
//
// Run: node scripts/smoke-panel.mjs
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoDecider, DecisionLog, probeTcp } from "../lib/core/auto.js";
import { installNodeTunnel, proxyEnvLines } from "../lib/core/tunnel.js";
import { createPanelRoute } from "../lib/panel/routes.js";
import { PanelStore, defaultSettings, mergeSettings } from "../lib/panel/store.js";

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push([true, name]);
	} catch (error) {
		results.push([false, `${name}: ${error instanceof Error ? error.message : error}`]);
	}
}

// ---- settings -----------------------------------------------------------------
const directory = await mkdtemp(join(tmpdir(), "clash-panel-"));
const store = new PanelStore({ path: join(directory, "panel.json") });
await store.load();
await check("defaults are conservative", () => {
	assert.equal(store.value.enabled, false);
	assert.equal(store.value.modes.web, "auto");
	assert.equal(store.value.scopes.search, false);
});
await store.patch({ modes: { web: "on" }, spoof: { enabled: true, timezone: "Asia/Tokyo" } });
await check("patch persists and merges", () => {
	assert.equal(store.value.modes.web, "on");
	assert.equal(store.value.modes.search, "auto", "untouched sibling stays");
	assert.equal(store.value.spoof.timezone, "Asia/Tokyo");
	assert.equal(store.value.spoof.locale, defaultSettings().spoof.locale);
});
await store.patch({ modes: { web: "auto" } });
await check("second patch keeps spoof", () => assert.equal(store.value.spoof.timezone, "Asia/Tokyo"));
await check("reload reads what was written", async () => {
	const again = new PanelStore({ path: join(directory, "panel.json") });
	await again.load();
	assert.equal(again.value.spoof.timezone, "Asia/Tokyo");
	assert.equal(again.value.modes.web, "auto");
});

await check("merge replaces arrays, keeps objects", () => {
	const merged = mergeSettings({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, d: 2 });
	assert.deepEqual(merged, { a: { b: 1, c: [3] }, d: 2 });
});

// ---- probes / decisions -------------------------------------------------------
const log = new DecisionLog(2);
log.push({ host: "a" });
log.push({ host: "b" });
log.push({ host: "c" });
await check("decision log keeps the newest entries", () => assert.deepEqual(log.list().map((entry) => entry.host), ["c", "b"]));

await check("loopback probes are fast and local", async () => {
	const server = net.createServer((socket) => socket.end());
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	const ms = await probeTcp("127.0.0.1", port, 500);
	server.close();
	assert.equal(typeof ms, "number");
	assert.ok(ms >= 0 && ms < 500);
});

const decider = new AutoDecider({ directThresholdMs: () => 10, probeTimeoutMs: () => 200, cacheSeconds: () => 60 });
await check("mode=off/loopback never proxy", async () => {
	assert.equal((await decider.decide("https://example.com/", "off")).useProxy, false);
	assert.equal((await decider.decide("http://127.0.0.1:9/", "auto")).useProxy, false);
});
await check("probe learns the host and caches it", async () => {
	const decision = await decider.decide("https://example.com/", "auto");
	assert.equal(typeof decision.useProxy, "boolean");
	assert.notEqual(decider.peek("example.com"), undefined, "verdict must be cached");
});
await check("kick probes in the background", async () => {
	decider.kick("https://example.org/");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.notEqual(decider.peek("example.org"), undefined);
});

// ---- routes -------------------------------------------------------------------
const stubController = {
	state: () => ({ version: "test", enabled: false, modes: { web: "auto" }, scopes: { web: true }, engine: { state: "stopped" }, nodes: { nodes: [] }, decisions: [] }),
	setEnabled: async (enabled) => stubController.state(),
	patchSettings: async () => stubController.state(),
	selectNode: async () => stubController.state(),
	testConnectivity: async () => ({ at: Date.now(), direct: null, proxy: null }),
	testLatency: async () => ({ results: {} }),
	testBandwidth: async () => ({ ok: true }),
	refreshSubscription: async () => ({ bytes: 1, via: "test" }),
	browserAction: async () => ({}),
	clearDecisions: () => {},
	manager: { traffic: () => ({ up: 0, down: 0, upRate: 0, downRate: 0 }) }
};
const route = createPanelRoute(stubController);
const server = http.createServer(async (req, res) => {
	// Mirrors the harness contract: a prefix route handler sees the full URL, and the
	// route only answers inside its prefix.
	if (!String(req.url).startsWith("/clash-proxy-panel/")) {
		res.writeHead(404).end("not mine");
		return;
	}
	await route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function get(path, headers = {}) {
	const response = await fetch(origin + path, { headers });
	return { status: response.status, text: await response.text(), type: response.headers.get("content-type") };
}

await check("serves the page", async () => {
	const page = await get("/clash-proxy-panel/");
	assert.equal(page.status, 200);
	assert.match(page.type ?? "", /text\/html/);
	assert.match(page.text, /代理面板/);
});
await check("serves assets", async () => {
	for (const asset of ["app.js", "app.css"]) {
		const file = await get(`/clash-proxy-panel/${asset}`);
		assert.equal(file.status, 200, asset);
	}
});
await check("unknown asset is a 404, unknown page is the shell", async () => {
	assert.equal((await get("/clash-proxy-panel/nope.js")).status, 404);
	const shell = await get("/clash-proxy-panel/some/deep/route");
	assert.equal(shell.status, 200);
	assert.match(shell.text, /<!doctype html>/i);
});
await check("api needs the custom header", async () => {
	assert.equal((await get("/clash-proxy-panel/api/state")).status, 403);
	const ok = await get("/clash-proxy-panel/api/state", { "x-clash-proxy": "1" });
	assert.equal(ok.status, 200);
	assert.equal(JSON.parse(ok.text).version, "test");
});
await check("non-loopback Host is refused", async () => {
	const status = await new Promise((resolve, reject) => {
		const request = http.request(
			{ host: "127.0.0.1", port: server.address().port, path: "/clash-proxy-panel/api/state", headers: { host: "evil.example", "x-clash-proxy": "1" } },
			(response) => {
				response.resume();
				resolve(response.statusCode);
			}
		);
		request.on("error", reject);
		request.end();
	});
	assert.equal(status, 403);
});
await check("api rejects unknown endpoints and bad modes", async () => {
	const unknown = await fetch(`${origin}/clash-proxy-panel/api/nope`, { method: "POST", headers: { "x-clash-proxy": "1" } });
	assert.equal(unknown.status, 404);
	const bad = await fetch(`${origin}/clash-proxy-panel/api/mode`, {
		method: "POST",
		headers: { "x-clash-proxy": "1", "content-type": "application/json" },
		body: JSON.stringify({ channel: "web", mode: "sometimes" })
	});
	assert.equal(bad.status, 500);
});
await check("static traversal is refused", async () => {
	const response = await get("/clash-proxy-panel/../package.json");
	assert.ok([403, 404].includes(response.status), `got ${response.status}`);
});
server.close();

// ---- tunnel -------------------------------------------------------------------
// A real (if tiny) CONNECT proxy: parse the CONNECT line, dial the target, then pipe.
const targetServer = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end(`tunnelled ${req.url}`);
});
await new Promise((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
const targetPort = targetServer.address().port;

const tunnelProxy = net.createServer((client) => {
	let buffered = Buffer.alloc(0);
	let finished = false;
	client.on("data", function onData(chunk) {
		if (finished) return;
		buffered = Buffer.concat([buffered, chunk]);
		const split = buffered.indexOf("\r\n\r\n");
		if (split < 0) return;
		finished = true;
		client.off("data", onData);
		const head = buffered.slice(0, split).toString("latin1");
		const rest = buffered.slice(split + 4);
		const match = /^CONNECT\s+([^:\s]+):(\d+)/i.exec(head);
		if (match === null) {
			client.destroy();
			return;
		}
		const upstream = net.connect(Number(match[2]), match[1], () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (rest.length > 0) upstream.write(rest);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		upstream.on("error", () => client.destroy());
	});
});
await new Promise((resolve) => tunnelProxy.listen(0, "127.0.0.1", resolve));
const proxyPort = tunnelProxy.address().port;
const disposeTunnel = installNodeTunnel((host) => (host === "localhost" ? { useProxy: true, port: proxyPort } : null));

await check("http request goes through the CONNECT tunnel", async () => {
	const body = await new Promise((resolve, reject) => {
		const request = http.request({ host: "localhost", port: targetPort, path: "/hello", headers: { connection: "close" } }, (response) => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => (text += chunk));
			response.on("end", () => resolve({ status: response.statusCode, text }));
		});
		request.on("error", reject);
		request.end();
	});
	assert.equal(body.status, 200);
	assert.equal(body.text, "tunnelled /hello");
});
await check("hosts the decider declines keep the original path", async () => {
	const request = http.request({ host: "127.0.0.1", port: 1, path: "/" });
	const result = await new Promise((resolve) => {
		request.on("error", (error) => resolve(error.code ?? "error"));
		request.end();
	});
	assert.equal(result, "ECONNREFUSED", "should be refused locally, not proxied");
});
disposeTunnel();
tunnelProxy.close();
targetServer.close();

await check("env lines name the loopback port", () => {
	const lines = proxyEnvLines(7890, { shell: "powershell" });
	assert.ok(lines.some((line) => line.includes("127.0.0.1:7890")));
	assert.deepEqual(proxyEnvLines(0), []);
});

await rm(directory, { recursive: true, force: true });

let failures = 0;
for (const [ok, name] of results) {
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures > 0) process.exitCode = 1;
