import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile } from "./fs-atomic.js";
import { fetchSubscription, parseSubscription, sanitizeGroups } from "./subscription.js";
import { RuleEngine, releaseRuleData } from "./rules.js";
import { ProxyServer } from "./proxy-server.js";
import { measureLatency, hasNativeConnector } from "./transports.js";
import { measureBandwidth, testConnectivity } from "./speed.js";
// NOTE (DSH plugin fork): the upstream manager injects HTTP(S)_PROXY into
// process.env and swaps the global fetch dispatcher so that the *whole* host
// process is proxied. Inside DeepSeek Harness that would also reroute the model
// API traffic, so this fork keeps the listener local and lets the plugin's own
// fetch provider decide per request. `inject.js` is therefore unused here.

/**
 * v2 orchestrator: self-contained rule-splitting proxy (core pure JS;
 * hysteria2 / vless-reality via a bundled Go connector), no external
 * Clash/mihomo.
 * Owns the subscription cache, the rule engine, the loopback proxy server,
 * node selection and latency testing, harness-scoped env/dispatcher
 * injection, the auto-update timer, and the browser JSON API.
 * @module dsh-clash-proxy/manager
 */

/** Fields whose change requires a rebuild/restart. */
const RESTART_FIELDS = [
	"subscriptionUrl", "fetchProxyUrl", "autoUpdateHours", "groupType",
	"latencyTestUrl", "latencyTimeoutMs", "noProxy", "extraRules", "excludeRules"
];

/** Group types the UI exposes for node selection. */
const GROUP_TYPES = new Set(["select", "url-test", "fallback", "load-balance"]);

/** Node types the pure-JS transports implement. */
const SUPPORTED_TYPES = new Set(["http", "socks5", "socks", "ss", "trojan", "vless", "vmess"]);

/**
 * True when a node object speaks a protocol this build can actually connect
 * with. QUIC (hysteria2) and VLESS/REALITY need `lib/native/connector.exe`;
 * without that binary claiming support would make auto-selection pick a node
 * that always fails at connect time.
 */
function isSupported(node) {
	if (typeof node === "string") return false; // bare URI strings: not implemented
	const type = String(node?.type ?? "").toLowerCase();
	if (type === "hysteria2") return hasNativeConnector();
	if (type === "vless" && String(node?.security ?? "").toLowerCase() === "reality") return hasNativeConnector();
	return SUPPORTED_TYPES.has(type);
}

export class ClashManager {
	#ctx;
	#resolveConfig;
	#subscriptionUrlEnv;
	#dataDirName;

	#state = "stopped";
	#error = undefined;
	#runtimeOff = false;
	#applied = null;
	#subscription = null;
	#engine = null;
	#server = null;
	#selected = null;
	#latencies = {};
	#bandwidth = {};
	#undoEnv = null;
	#undoDispatcher = null;
	#autoUpdateDisposer = null;
	#latencyTimerDisposer = null;
	#task = Promise.resolve();
	#port = 0;
	#traffic = { up: 0, down: 0, at: 0 };
	/** Node the running engine answers with; set and cleared by panel tooling. */
	#override = null;
	/** Serializes override-scoped measurements so two tests never share a node. */
	#overrideChain = Promise.resolve();

	/** @param ctx - plugin context. @param resolveConfig - live section thunk. */
	constructor(ctx, resolveConfig, options) {
		this.#ctx = ctx;
		this.#resolveConfig = resolveConfig;
		this.#subscriptionUrlEnv = options.subscriptionUrlEnv;
		this.#dataDirName = options.dataDirName;
	}

	/** Data directory (`$DSH_HOME/<name>` or `~/.dsh/<name>`). */
	get dataDir() {
		const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
		return join(root, this.#dataDirName);
	}

	/** Node lookup table from the parsed subscription. */
	#nodeMap() {
		const map = new Map();
		for (const node of this.#subscription?.parsed?.proxies ?? []) {
			const name = typeof node === "string" ? node : node?.name;
			if (typeof name === "string" && name.length > 0) map.set(name, node);
		}
		return map;
	}

	/** Proxy groups exposed to the GUI (subscription groups + synthesized AUTO). */
	#groups() {
		const parsed = this.#subscription?.parsed;
		if (parsed === null || parsed === undefined) return [];
		const names = parsed.names;
		const groups = sanitizeGroups(parsed.groups, names).filter((group) => GROUP_TYPES.has(group.type));
		const hasAuto = groups.some((group) => group.name === "AUTO");
		if (!hasAuto && names.length > 0) {
			const section = this.#resolveConfig();
			groups.unshift({ name: "AUTO", type: section.groupType, proxies: names });
		}
		return groups.map((group) => ({
			name: group.name,
			type: group.type,
			now: group.name === "AUTO" ? this.#currentNodeName(group) : group.now ?? group.proxies?.[0] ?? null,
			all: group.proxies
		}));
	}

	/** The node currently answering proxy traffic (or null). */
	#resolveNode() {
		const map = this.#nodeMap();
		const names = [...map.keys()];
		if (names.length === 0) return null;
		if (this.#override !== null && map.has(this.#override)) return map.get(this.#override);
		if (this.#selected !== null && map.has(this.#selected)) return map.get(this.#selected);
		const supported = names.filter((name) => isSupported(map.get(name)));
		const section = this.#resolveConfig();
		if (section.groupType === "url-test") {
			let best = null;
			let bestDelay = Infinity;
			for (const name of supported) {
				const delay = this.#latencies[name];
				if (typeof delay === "number" && delay < bestDelay) {
					best = name;
					bestDelay = delay;
				}
			}
			if (best !== null) return map.get(best);
		}
		// Fall back to the first supported node so unsupported protocols
		// (vmess/hysteria2) never become the silent default.
		if (supported.length > 0) return map.get(supported[0]);
		return map.get(names[0]);
	}

	#currentNodeName(group) {
		if (group.type === "url-test") {
			const node = this.#resolveNode();
			return node === null ? null : (typeof node === "string" ? node : node.name);
		}
		return this.#selected ?? group.proxies?.[0] ?? null;
	}

	/** Live snapshot for the browser page (secrets redacted). */
	status() {
		const section = this.#resolveConfig();
		return {
			state: this.#state,
			error: this.#error ?? null,
			runtimeOff: this.#runtimeOff,
			enabled: section.enabled !== false,
			subscriptionUrlSet: (section.subscriptionUrl ?? "").length > 0,
			subscriptionUrlEnv: this.#subscriptionUrlEnv,
			lastSubscriptionUpdate: this.#subscription?.updatedAt ?? null,
			nodeCount: this.#subscription?.parsed?.names?.length ?? 0,
			port: this.#port,
			selected: this.#selected,
			current: this.currentNodeName,
			proxying: this.proxying,
			groupType: section.groupType,
			latencyTestUrl: section.latencyTestUrl,
			autoUpdateHours: section.autoUpdateHours,
			version: "2"
		};
	}

	#queue(operation) {
		const task = this.#task.then(operation, operation);
		this.#task = task.catch(() => {});
		return task;
	}

	start() {
		return this.#queue(async () => {
			const section = this.#resolveConfig();
			if (this.#server !== null || section.enabled === false || this.#runtimeOff) {
				this.#state = section.enabled === false || this.#runtimeOff ? "disabled" : this.#state;
				return;
			}
			await this.#startCore(section);
		});
	}

	stop() {
		return this.#queue(async () => {
			this.#disposeAutoUpdate();
			this.#disposeLatencyTimer();
			await this.#undoDispatcher?.();
			this.#undoDispatcher = null;
			this.#undoEnv?.();
			this.#undoEnv = null;
			this.#server?.stop();
			this.#server = null;
			this.#engine = null;
			// Free the embedded rule tables (~15 MB) while the listener is down.
			releaseRuleData();
			this.#port = 0;
			if (this.#state !== "disabled" && this.#state !== "no-subscription") this.#state = "stopped";
		});
	}

	restart() {
		return this.#queue(async () => {
			const section = this.#resolveConfig();
			if (section.enabled === false || this.#runtimeOff) {
				await this.stop();
				return;
			}
			await this.#startCore(section);
		});
	}

	reconcile(next) {
		const signature = JSON.stringify({
			...RESTART_FIELDS.reduce((pick, key) => ({ ...pick, [key]: next[key] }), {}),
			enabled: next.enabled
		});
		if (signature === this.#applied) return;
		this.#applied = signature;
		void (next.enabled === false ? this.stop() : this.restart());
	}

	updateSubscription() {
		return this.#queue(async () => {
			const section = this.#resolveConfig();
			if (section.enabled === false) return;
			await this.#loadSubscription(section, true);
			await this.#startCore(section);
			// Auto re-test every node after an update (manual click or scheduled
			// auto-update). Fire-and-forget so the HTTP call returns promptly;
			// the GUI polls /proxies and sees latencies stream in per node.
			if (this.#subscription !== null) {
				void this.testAllLatencies().catch((error) => {
					this.#ctx.logger?.warn?.("clash-proxy: post-update latency test failed: %s", String(error));
				});
			}
		});
	}

	async setRuntimeEnabled(enabled) {
		this.#runtimeOff = !enabled;
		await (enabled ? this.restart() : this.stop());
	}

	/** Load the subscription body from URL or the cached copy. */
	async #loadSubscription(section, force) {
		const dir = this.dataDir;
		const cachePath = join(dir, "subscription.yaml");
		const metaPath = join(dir, "subscription.meta.json");
		const url = (section.subscriptionUrl ?? "").length > 0
			? section.subscriptionUrl
			: process.env[this.#subscriptionUrlEnv] ?? "";

		if (!force && this.#subscription !== null) return;

		if (url.length > 0) {
			const raw = await fetchSubscription(url, section.fetchProxyUrl ?? "");
			await atomicWriteFile(cachePath, raw);
			// Deliberately no URL in the meta file: subscription links are bearer
			// secrets and this file sits in plain sight under ~/.dsh.
			await atomicWriteFile(metaPath, JSON.stringify({ at: Date.now() }));
			this.#subscription = { raw, updatedAt: Date.now(), parsed: parseSubscription(raw) };
			this.#ctx.logger?.info?.("clash-proxy: subscription updated (%d nodes)", this.#subscription.parsed.names.length);
			return;
		}

		const cached = await readFile(cachePath, "utf8").catch(() => null);
		if (cached === null || cached.trim().length === 0) {
			this.#subscription = null;
			this.#state = "no-subscription";
			return;
		}
		const meta = await readFile(metaPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
		this.#subscription = { raw: cached, updatedAt: meta?.at ?? null, parsed: parseSubscription(cached) };
	}

	/** Persist manual selection only; latencies stay in memory (ephemeral). */
	async #saveState() {
		try {
			await atomicWriteFile(join(this.dataDir, "state.json"), JSON.stringify({ selected: this.#selected }));
		} catch (error) {
			// Non-fatal, but never silent: a read-only data dir is a real problem.
			this.#ctx.logger?.warn?.("clash-proxy: cannot save state.json: %s", error instanceof Error ? error.message : String(error));
		}
	}

	async #loadState() {
		try {
			const state = JSON.parse(await readFile(join(this.dataDir, "state.json"), "utf8"));
			if (typeof state.selected === "string") this.#selected = state.selected;
		} catch {
			// First run.
		}
	}

	/** The real boot path. */
	async #startCore(section) {
		this.#state = "starting";
		this.#error = undefined;
		await this.#undoDispatcher?.();
		this.#undoDispatcher = null;
		await this.#undoEnv?.();
		this.#undoEnv = null;
		try {
			await this.#loadSubscription(section, false);
			if (this.#subscription === null) {
				this.#state = "no-subscription";
				return;
			}
			await this.#loadState();

			this.#engine = new RuleEngine({
				extraRules: section.extraRules ?? [],
				excludeRules: section.excludeRules ?? [],
				subscriptionRules: this.#subscription.parsed.rules
			});
			this.#server = new ProxyServer({ engine: this.#engine, resolveNode: () => this.#resolveNode() });
			this.#port = await this.#server.start(0);

			// Fork: no env / global-dispatcher injection. Only the local listener is
			// started; callers opt in per request through the plugin fetch provider.
			this.#state = "running";
			this.#error = undefined;
			this.#ctx.logger?.info?.("clash-proxy: rule proxy listening on 127.0.0.1:%d (%d nodes)", this.#port, this.#subscription.parsed.names.length);
			this.#scheduleAutoUpdate(section);
			this.#scheduleLatencyTests(section);
		} catch (error) {
			this.#state = "failed";
			this.#error = error instanceof Error ? error.message : String(error);
			this.#ctx.logger?.warn?.("clash-proxy: start failed: %s", this.#error);
			this.#server?.stop();
			this.#server = null;
			await this.#undoDispatcher?.();
			this.#undoDispatcher = null;
			await this.#undoEnv?.();
			this.#undoEnv = null;
		}
	}

	#scheduleAutoUpdate(section) {
		this.#disposeAutoUpdate();
		const hours = Number(section.autoUpdateHours ?? 0);
		if (!Number.isFinite(hours) || hours <= 0) return;
		// The timer service mixin (declared via inject: ["timer"]) owns the
		// interval and returns its disposer.
		this.#autoUpdateDisposer = this.#ctx.setInterval(() => {
			void this.updateSubscription().catch((error) => {
				this.#ctx.logger?.warn?.("clash-proxy: auto-update failed: %s", String(error));
			});
		}, hours * 3600 * 1000);
	}

	#disposeAutoUpdate() {
		this.#autoUpdateDisposer?.();
		this.#autoUpdateDisposer = null;
	}

	#scheduleLatencyTests(section) {
		this.#disposeLatencyTimer();
		if (section.groupType !== "url-test") return;
		this.#latencyTimerDisposer = this.#ctx.setInterval(() => {
			void this.#refreshLatencies(section).catch(() => {});
		}, 300 * 1000);
	}

	#disposeLatencyTimer() {
		this.#latencyTimerDisposer?.();
		this.#latencyTimerDisposer = null;
	}

	/** Test every node's latency and remember the best. */
	async #refreshLatencies(section) {
		const map = this.#nodeMap();
		for (const name of map.keys()) {
			this.#latencies[name] = await this.#testOne(name, section);
		}
	}

	#latencyTarget(section) {
		try {
			const url = new URL(section.latencyTestUrl ?? "http://www.gstatic.com/generate_204");
			return { host: url.hostname, port: url.port.length > 0 ? Number(url.port) : url.protocol === "http:" ? 80 : 443 };
		} catch {
			return { host: "www.gstatic.com", port: 443 };
		}
	}

	async #testOne(name, section) {
		const map = this.#nodeMap();
		const node = map.get(name);
		if (node === undefined) return null;
		const { host, port } = this.#latencyTarget(section);
		return measureLatency(node, host, port, section.latencyTimeoutMs ?? 3000);
	}

	/** Manual node selection inside a group. */
	async selectNode(name) {
		const map = this.#nodeMap();
		if (!map.has(name)) throw new Error(`unknown node ${name}`);
		this.#selected = name;
		await this.#saveState();
	}

	/** One node latency test for the GUI. */
	async testLatency(name) {
		const section = this.#resolveConfig();
		const delay = await this.#testOne(name, section);
		this.#latencies[name] = delay;
		return delay;
	}

	/** Drop all in-memory latencies (page refresh / fresh session). */
	clearLatencies() {
		this.#latencies = {};
	}

	// ---- panel surface -----------------------------------------------------

	/** The rule engine's verdict for a host ("direct" | "proxy" | "reject"). */
	decide(host) {
		if (this.#engine === null) return "direct";
		try {
			return this.#engine.decide(host);
		} catch {
			return "direct";
		}
	}

	/** Invalid rule lines the engine rejected (never silently dropped). */
	rulesDiagnostics() {
		return this.#engine === null ? [] : this.#engine.diagnostics;
	}

	/** True when the listener is up and a node can answer foreign traffic. */
	get proxying() {
		return this.#server !== null && this.#port > 0 && this.#resolveNode() !== null;
	}

	/** Name of the node that answers foreign traffic right now. */
	get currentNodeName() {
		const node = this.#resolveNode();
		if (node === null) return null;
		return typeof node === "string" ? node : node.name ?? null;
	}

	/** Nodes with their last known delay + throughput, for the panel table. */
	nodeSummary() {
		const nodes = [...this.#nodeMap().entries()].map(([name, node]) => ({
			name,
			type: typeof node === "string" ? "uri" : node.type,
			server: typeof node === "string" ? "" : node.server ?? "",
			delay: this.#latencies[name] ?? null,
			alive: this.#latencies[name] === undefined ? null : this.#latencies[name] !== null,
			mbps: this.#bandwidth[name]?.mbps ?? null,
			bytes: this.#bandwidth[name]?.bytes ?? null,
			testedAt: this.#bandwidth[name]?.at ?? null,
			current: name === this.currentNodeName,
			selected: name === this.#selected
		}));
		return { nodes, groups: this.#groups(), selected: this.#selected, current: this.currentNodeName };
	}

	/**
	 * Run `operation` while the engine answers every foreign connection with `name`.
	 * Serialized: two measurements never share one override window.
	 */
	async withNodeOverride(name, operation) {
		const map = this.#nodeMap();
		if (!map.has(name)) throw new Error(`unknown node ${name}`);
		const run = async () => {
			const previous = this.#override;
			this.#override = name;
			try {
				return await operation();
			} finally {
				this.#override = previous;
			}
		};
		const next = this.#overrideChain.then(run, run);
		this.#overrideChain = next.catch(() => {});
		return next;
	}

	/** Bandwidth through one node (or `null` for whatever the rules already pick). */
	async measureNodeBandwidth(name, options = {}) {
		if (!(this.#port > 0)) throw new Error("the proxy is not running; switch it on first");
		const urls = Array.isArray(options.urls) ? options.urls : [];
		const budgetMs = Number(options.budgetMs ?? 8000);
		const run = () => measureBandwidth({ urls, proxyPort: this.#port, budgetMs });
		const result = name == null ? await run() : await this.withNodeOverride(name, run);
		if (name != null) this.#bandwidth[name] = { mbps: result.mbps, bytes: result.bytes, at: Date.now() };
		return result;
	}

	/** Direct vs. proxied reachability of the agent's own test targets. */
	async connectivity(options = {}) {
		return testConnectivity({ proxyPort: this.#port, timeoutMs: Number(options.timeoutMs ?? 6000) });
	}

	/** Byte counters and their rate since the previous call. */
	traffic() {
		const counters = this.#server?.counters ?? { up: 0, down: 0 };
		const now = Date.now();
		const previous = this.#traffic;
		const elapsed = previous.at > 0 ? Math.max(1, now - previous.at) : 0;
		const up = counters.up ?? 0;
		const down = counters.down ?? 0;
		const result = {
			up,
			down,
			upRate: elapsed > 0 ? Math.max(0, (up - previous.up) / (elapsed / 1000)) : 0,
			downRate: elapsed > 0 ? Math.max(0, (down - previous.down) / (elapsed / 1000)) : 0,
			at: now
		};
		this.#traffic = { up, down, at: now };
		return result;
	}

	/**
	 * Test every node's latency with bounded concurrency (in-memory only).
	 * @param names - node names to test (defaults to all).
	 * @param concurrency - max parallel tests.
	 * @returns { [name]: delay } (null for failures).
	 */
	async testAllLatencies(names, concurrency = 8) {
		const section = this.#resolveConfig();
		const list = names ?? [...this.#nodeMap().keys()];
		const results = {};
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= list.length) return;
				const name = list[index];
				results[name] = await this.#testOne(name, section);
				this.#latencies[name] = results[name];
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
		return results;
	}

	// ---- browser API -------------------------------------------------------

	/** Route one HTTP request from the DSH webserver. */
	async handleHttp(req, res) {
		const url = new URL(req.url ?? "/", "http://x");
		const sub = url.pathname.slice("/clash-proxy".length).replace(/^\/+/, "");
		const method = (req.method ?? "GET").toUpperCase();
		const send = (status, payload) => {
			if (res.headersSent) return;
			const body = JSON.stringify(payload);
			res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
			res.end(body);
		};
		const readBody = () => new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > 1024 * 1024) {
					reject(new Error("request body too large"));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				try {
					resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch {
					resolve({});
				}
			});
			req.on("error", reject);
		});

		try {
			switch (sub) {
				case "status":
					if (method !== "GET") return send(405, { error: "GET only" });
					return send(200, this.status());
				case "restart":
					if (method !== "POST") return send(405, { error: "POST only" });
					await this.restart();
					return send(200, this.status());
				case "update-subscription":
					if (method !== "POST") return send(405, { error: "POST only" });
					await this.updateSubscription();
					return send(200, this.status());
				case "runtime-enabled": {
					if (method !== "POST") return send(405, { error: "POST only" });
					const body = await readBody();
					await this.setRuntimeEnabled(body.enabled !== false);
					return send(200, this.status());
				}
				case "proxies": {
					if (method !== "GET") return send(405, { error: "GET only" });
					const groups = this.#groups();
					const nodes = [...this.#nodeMap().entries()].map(([name, node]) => ({
						name,
						type: typeof node === "string" ? "uri" : node.type,
						delay: this.#latencies[name] ?? null,
						alive: this.#latencies[name] === undefined ? null : this.#latencies[name] !== null
					}));
					return send(200, { groups, nodes });
				}
				case "traffic": {
					if (method !== "GET") return send(405, { error: "GET only" });
					const up = this.#server?.counters.up ?? 0;
					const down = this.#server?.counters.down ?? 0;
					const now = Date.now();
					const seconds = Math.max(0.001, (now - this.#traffic.at) / 1000);
					const upRate = Math.max(0, up - this.#traffic.up) / seconds;
					const downRate = Math.max(0, down - this.#traffic.down) / seconds;
					this.#traffic = { up, down, at: now };
					return send(200, { up, down, upRate, downRate });
				}
				case "delay": {
					if (method !== "POST") return send(405, { error: "POST only" });
					const body = await readBody();
					if (typeof body.name !== "string") return send(400, { error: "missing name" });
					const delay = await this.testLatency(body.name);
					return send(200, { name: body.name, delay });
				}
				case "delay-all": {
					if (method !== "POST") return send(405, { error: "POST only" });
					const body = await readBody();
					const names = Array.isArray(body.names) && body.names.length > 0
						? body.names.filter((name) => typeof name === "string")
						: [...this.#nodeMap().keys()];
					const results = await this.testAllLatencies(names);
					return send(200, { results });
				}
				case "clear-latencies":
					if (method !== "POST") return send(405, { error: "POST only" });
					this.clearLatencies();
					return send(200, { ok: true });
				case "select": {
					if (method !== "POST") return send(405, { error: "POST only" });
					const body = await readBody();
					if (typeof body.name !== "string") return send(400, { error: "missing name" });
					await this.selectNode(body.name);
					return send(200, { ok: true });
				}
				default:
					return send(404, { error: `unknown endpoint ${sub}` });
			}
		} catch (error) {
			send(500, { error: error instanceof Error ? error.message : String(error) });
		}
	}
}
