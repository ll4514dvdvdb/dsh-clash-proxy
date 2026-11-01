// Local smoke test for the plugin core without a running DeepSeek Harness.
// Usage: node smoke.mjs
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, request } from "undici";
import { ClashManager } from "./lib/core/manager.js";

const here = dirname(fileURLToPath(import.meta.url));
const home = join(here, ".smoke-home");
process.env.DSH_HOME = home;
await mkdir(join(home, "clash-proxy"), { recursive: true });
await copyFile(
	join(here, "..", "clash-proxy", ".data", "clash-proxy-runner", "subscription.yaml"),
	join(home, "clash-proxy", "subscription.yaml")
);

const timers = new Set();
const ctx = {
	logger: {
		info: (...args) => console.log("[info]", ...args),
		warn: (...args) => console.warn("[warn]", ...args),
		debug: () => {}
	},
	setInterval: (fn, ms) => {
		const id = setInterval(fn, ms);
		timers.add(id);
		return () => {
			clearInterval(id);
			timers.delete(id);
		};
	}
};

const section = {
	enabled: true,
	subscriptionUrl: "",
	fetchProxyUrl: "",
	autoUpdateHours: 0,
	groupType: "url-test",
	latencyTestUrl: "http://www.gstatic.com/generate_204",
	latencyTimeoutMs: 3000,
	noProxy: "localhost,127.0.0.1,::1",
	extraRules: [],
	excludeRules: []
};

const manager = new ClashManager(ctx, () => section, { subscriptionUrlEnv: "CLASH_SUBSCRIPTION_URL", dataDirName: "clash-proxy" });
await manager.start();
const status = manager.status();
console.log("status:", JSON.stringify({ state: status.state, port: status.port, nodeCount: status.nodeCount, error: status.error }));
if (status.state !== "running" || !status.port) {
	await manager.stop();
	process.exit(1);
}

const dispatcher = new ProxyAgent(`http://127.0.0.1:${status.port}`);
for (const url of ["https://www.google.com/generate_204", "https://api.ipify.org?format=json", "https://www.baidu.com"]) {
	try {
		const res = await request(url, { dispatcher, method: "GET", headersTimeout: 20000, bodyTimeout: 20000 });
		const body = await res.body.text();
		console.log(`${url} -> ${res.statusCode} (${body.length}B) ${body.slice(0, 60).replace(/\n/g, " ")}`);
	} catch (error) {
		console.log(`${url} -> ERROR ${error?.message ?? error}`);
	}
}
dispatcher.close().catch(() => {});
await manager.stop();
for (const id of timers) clearInterval(id);
console.log("stopped:", manager.status().state);
