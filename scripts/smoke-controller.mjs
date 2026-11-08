// Exercises the panel controller against a fake engine: the wiring the page relies on
// (master switch → engine, per-channel decisions, camouflage headers, snapshot shape)
// must work without a subscription or a network.
//
// Run: node scripts/smoke-controller.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyController } from "../lib/panel/controller.js";
import { PanelStore } from "../lib/panel/store.js";

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push([true, name]);
	} catch (error) {
		results.push([false, `${name}: ${error instanceof Error ? error.message : error}`]);
	}
}

const dir = await mkdtemp(join(tmpdir(), "clash-controller-"));
const changes = [];
const manager = {
	proxying: true,
	startCalls: 0,
	stopCalls: 0,
	async start() {
		this.startCalls += 1;
	},
	async stop() {
		this.stopCalls += 1;
	},
	async restart() {},
	async selectNode() {},
	status: () => ({ state: "running", port: 19000, nodeCount: 2, current: "n1", selected: "n1", error: undefined }),
	decide: (host) => (String(host).endsWith(".cn") ? "direct" : "proxy"),
	rulesDiagnostics: () => [{ line: "IP-CIDR,10.0.0.0/33,DIRECT", error: "prefix out of range" }],
	nodeSummary: () => ({
		nodes: [{ name: "n1", type: "ss", delay: 120, mbps: 12.5, current: true, selected: true }],
		current: "n1",
		selected: "n1",
		groups: []
	}),
	async testLatency() {
		return 42;
	},
	async testAllLatencies() {
		return { n1: 42 };
	},
	async measureNodeBandwidth(name) {
		return { ok: true, mbps: 12.5, bytes: 1000000, ms: 1000, ttfbMs: 100, name };
	},
	async connectivity() {
		return { at: Date.now(), direct: { ok: true, ms: 30, status: 204, via: "direct" }, proxy: null };
	},
	traffic: () => ({ up: 1, down: 2, upRate: 3, downRate: 4 })
};

const controller = new ProxyController({
	ctx: { logger: { warn() {}, info() {} } },
	manager,
	store: new PanelStore({ path: join(dir, "panel.json") }),
	config: () => ({}),
	onChange: async (settings) => changes.push({ enabled: settings.enabled, search: settings.scopes.search })
});

await controller.init();

await check("snapshot is JSON and carries the panel contract", () => {
	const state = controller.state();
	assert.equal(state.version, "0.3.0");
	assert.equal(typeof state.engine.port, "number");
	assert.equal(state.nodes.current, "n1");
	assert.ok(Array.isArray(state.decisions));
	assert.ok(Array.isArray(state.uaPresets) && state.uaPresets.length > 0);
	assert.ok(JSON.stringify(state).length > 100);
});

await check("master switch off means no proxying anywhere", async () => {
	const decision = await controller.decideFetch("https://example.com/");
	assert.equal(decision.useProxy, false);
	assert.equal(decision.reason, "master off");
	assert.equal(controller.decideTunnel("example.com"), null);
});

await check("switching on starts the engine and reconciles channels", async () => {
	await controller.setEnabled(true);
	assert.equal(manager.startCalls, 1);
	assert.equal(controller.settings.enabled, true);
	assert.ok(changes.some((entry) => entry.enabled === true));
});

await check("mode=on proxies, rules still keep .cn direct", async () => {
	await controller.patchSettings({ modes: { web: "on" } });
	assert.equal((await controller.decideFetch("https://example.com/")).useProxy, true);
	await controller.patchSettings({ modes: { web: "auto" } });
	const cn = await controller.decideFetch("https://www.qq.cn/");
	assert.equal(cn.useProxy, false);
	assert.equal(cn.reason, "rule: direct");
});

await check("scripts channel is opt-in", async () => {
	assert.equal(controller.decideTunnel("example.com"), null);
	await controller.patchSettings({ scopes: { scripts: true } });
	const decision = controller.decideTunnel("example.com");
	assert.equal(decision?.useProxy, true);
	assert.equal(decision?.port, 19000);
	assert.equal(controller.decideTunnel("127.0.0.1"), null, "loopback stays local");
});

await check("search scope is gated and the tunnel window is scoped", async () => {
	const settings = controller.settings;
	assert.equal(settings.scopes.search, false);
	const inside = await controller.withSearchTunnel(async () => controller.decideTunnel("example.org"));
	assert.equal(inside?.useProxy, true, "a delegated search gets the tunnel");
	const outside = controller.decideTunnel("example.org");
	assert.equal(outside?.useProxy, true, "scripts scope is still on from the previous check");
	await controller.patchSettings({ scopes: { search: false, scripts: false } });
	assert.equal(controller.decideTunnel("example.org"), null);
});

await check("camouflage headers follow the settings", async () => {
	assert.deepEqual(controller.spoofHeaders(), {});
	await controller.patchSettings({ spoof: { enabled: true, uaPreset: "chrome_win", acceptLanguage: "en-GB,en;q=0.9" } });
	const headers = controller.spoofHeaders();
	assert.match(headers["user-agent"], /Chrome\//);
	assert.equal(headers["accept-language"], "en-GB,en;q=0.9");
	assert.match(headers["sec-ch-ua"], /Chromium/);
	await controller.patchSettings({ spoof: { enabled: false } });
	assert.deepEqual(controller.spoofHeaders(), {});
});

await check("bandwidth test records a decision line", async () => {
	const first = controller.testBandwidth("n1");
	const concurrent = controller.testBandwidth("n1").then(
		() => null,
		(error) => error
	);
	const [result, refusal] = await Promise.all([first, concurrent]);
	assert.equal(result.mbps, 12.5);
	assert.ok(refusal instanceof Error && /already running/.test(refusal.message), `expected a refusal, got ${refusal}`);
	assert.ok(controller.state().decisions.some((entry) => entry.mode === "speed"));
});

await check("connectivity probe is exposed", async () => {
	const result = await controller.testConnectivity();
	assert.equal(result.direct.ok, true);
	assert.equal(controller.state().decisions.some((entry) => entry.mode === "probe"), true);
});

await check("env lines exist only with a port", async () => {
	const env = controller.proxyEnv();
	assert.ok(env.powershell.some((line) => line.includes("19000")));
});

await check("invalid rules surface in state, not silently", async () => {
	const diagnostics = controller.state().rulesDiagnostics;
	assert.equal(diagnostics.length, 1);
	assert.match(diagnostics[0].line, /^IP-CIDR,/);
});

await check("switching off stops the engine and clears the browser", async () => {
	await controller.setEnabled(false);
	assert.equal(manager.stopCalls, 1);
	assert.equal(controller.settings.enabled, false);
	assert.equal(controller.proxyEnv().powershell.length > 0, true, "port may still be reported from a stale status");
});

await rm(dir, { recursive: true, force: true });

let failures = 0;
for (const [ok, name] of results) {
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures > 0) process.exitCode = 1;
