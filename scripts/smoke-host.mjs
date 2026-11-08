// Imports the host half of the plugin into a fake cordis context.
//
// This is the cheapest way to catch what a hot reload catches in the app — e.g.
// touching a service outside `inject`, which only fails at apply() time.
//
// Run: node scripts/smoke-host.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "clash-host-"));
process.env.DSH_HOME = home;

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push([true, name]);
	} catch (error) {
		results.push([false, `${name}: ${error instanceof Error ? error.message : error}`]);
	}
}

const routes = [];
const tools = [];
const providerCalls = [];
const settingsMutations = [];
const effects = [];

const web = {
	config: {
		fetchProvider: { get: () => "free-search" },
		searchProvider: { get: () => "free-search" }
	},
	fetchProviders: new Map(),
	searchProviders: new Map(),
	registerFetchProvider(provider) {
		if (this.fetchProviders.has(provider.id)) throw new Error(`duplicate ${provider.id}`);
		this.fetchProviders.set(provider.id, provider);
		providerCalls.push(["registerFetch", provider.id]);
		return () => this.fetchProviders.delete(provider.id);
	},
	registerSearchProvider(provider) {
		if (this.searchProviders.has(provider.id)) throw new Error(`duplicate ${provider.id}`);
		this.searchProviders.set(provider.id, provider);
		providerCalls.push(["registerSearch", provider.id]);
		return () => this.searchProviders.delete(provider.id);
	}
};
web.searchProviders.set("free-search", {
	id: "free-search",
	available: () => true,
	async search() {
		return { query: "x", sources: [] };
	}
});

const settings = {
	async mutate(section, ops) {
		settingsMutations.push({ section, ops });
	}
};

const ctx = {
	logger: { info() {}, warn() {}, debug() {}, error() {} },
	web,
	effect(fn, label) {
		const dispose = fn();
		if (typeof dispose === "function") effects.push({ label, dispose });
		return () => dispose?.();
	},
	inject(dependencies, callback) {
		callback(ctx);
	},
	get(name) {
		return name === "settings" ? settings : undefined;
	},
	webServer: {
		register(route) {
			routes.push(route);
			return () => {
				const index = routes.indexOf(route);
				if (index >= 0) routes.splice(index, 1);
			};
		}
	},
	tools: {
		register(tool) {
			tools.push(tool);
			return () => {
				const index = tools.indexOf(tool);
				if (index >= 0) tools.splice(index, 1);
			};
		}
	},
	setInterval: () => () => {},
	timer: { setTimeout: (fn) => () => {}, setInterval: () => () => {} }
};

const plugin = await import("../lib/index.js");
await plugin.apply(ctx, { subscriptionUrl: "", extraRules: [], excludeRules: [], latencyTimeoutMs: 3000, autoUpdateHours: 0 });

await check("registers the panel route on webServer", () => {
	assert.equal(routes.length, 1);
	assert.equal(routes[0].kind, "prefix");
	assert.equal(routes[0].path, "/clash-proxy-panel");
	assert.equal(typeof routes[0].handler, "function");
});

await check("registers both providers", () => {
	assert.ok(web.fetchProviders.has("clash-proxy-fetch"));
	assert.ok(web.searchProviders.has("clash-proxy-search"));
});

await check("search provider only delegates when a base exists", async () => {
	const provider = web.searchProviders.get("clash-proxy-search");
	assert.equal(provider.available(), false, "no base provider chosen yet");
	await assert.rejects(() => provider.search({ query: "x" }, new AbortController().signal), /no base search provider/);
});

await check("registers both tools", () => {
	assert.deepEqual(tools.map((tool) => tool.name).sort(), ["proxy_control", "proxy_fetch"]);
});

await check("tool status reports the switched-off panel", async () => {
	const tool = tools.find((entry) => entry.name === "proxy_control");
	const result = await tool.execute({ action: "status" });
	assert.match(result.content, /proxy: off/);
	assert.match(result.content, /panel: \/clash-proxy-panel\//);
});

await check("tool env is empty while off", async () => {
	const tool = tools.find((entry) => entry.name === "proxy_control");
	const result = await tool.execute({ action: "env" });
	assert.match(result.content, /proxy is off/);
});

const server = http.createServer(async (req, res) => {
	if (!String(req.url).startsWith("/clash-proxy-panel/")) return res.writeHead(404).end();
	await routes[0].handler(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

await check("route serves the page and its state api", async () => {
	const page = await fetch(`${origin}/clash-proxy-panel/`);
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, /代理面板/);
	const token = /<meta name="clash-proxy-token" content="([^"]+)"/.exec(html)?.[1] ?? "";
	const state = await fetch(`${origin}/clash-proxy-panel/api/state`, { headers: { "x-clash-proxy-token": token } });
	assert.equal(state.status, 200);
	const body = await state.json();
	assert.equal(body.enabled, false);
	assert.equal(body.version, "0.3.0");
	assert.equal(typeof body.env.powershell, "object");
});

await check("fetch provider falls back to direct while off", async () => {
	const target = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("direct body");
	});
	await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
	const port = target.address().port;
	const provider = web.fetchProviders.get("clash-proxy-fetch");
	const response = await provider.fetch({ url: `http://127.0.0.1:${port}/x` });
	target.close();
	assert.equal(response.statusCode, 200);
	assert.equal(response.body.content, "direct body");
});

await check("fetch provider refuses non-absolute urls through decide", async () => {
	const provider = web.fetchProviders.get("clash-proxy-fetch");
	await assert.rejects(() => provider.fetch({ url: "not a url" }), /invalid|URL/i);
});

server.close();

await check("unload disposes routes, tools and providers", async () => {
	for (const effect of [...effects].reverse()) effect.dispose();
	assert.equal(routes.length, 0);
	assert.equal(tools.length, 0);
	assert.equal(web.fetchProviders.has("clash-proxy-fetch"), false);
	assert.equal(web.searchProviders.has("clash-proxy-search"), false);
});

await rm(home, { recursive: true, force: true });

let failures = 0;
for (const [ok, name] of results) {
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures > 0) process.exitCode = 1;
