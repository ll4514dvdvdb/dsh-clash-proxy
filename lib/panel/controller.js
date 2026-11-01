// The panel's brain: one object the page, the tools and the fetch provider all ask.
//
// It owns the four things that must agree with each other — the master switch, the
// per-channel policy, the node selection, and the camouflage header set — so no
// caller has to reimplement "is the proxy on for this request?".
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AutoDecider, isLoopback } from "../core/auto.js";
import { BrowserSession } from "../core/browser.js";
import { proxyEnvLines } from "../core/tunnel.js";
import { UA_PRESETS } from "./store.js";
import { fetchSubscriptionRaw } from "../subscription-refresh.js";

const VERSION = "0.2.0";

/** Chromium client hints that must agree with the chosen user agent. */
function clientHints(userAgent) {
	const chromium = /Chrome\/(\d+)/.exec(userAgent);
	const edge = /Edg\/(\d+)/.exec(userAgent);
	const android = /Android/.test(userAgent);
	const windows = /Windows NT/.test(userAgent);
	const mac = /Macintosh/.test(userAgent);
	if (chromium === null) return {};
	const brand = edge !== null ? `"Microsoft Edge";v="${edge[1]}", ` : "";
	return {
		"sec-ch-ua": `${brand}"Chromium";v="${chromium[1]}", "Not=A?Brand";v="24"`,
		"sec-ch-ua-mobile": android ? "?1" : "?0",
		"sec-ch-ua-platform": windows ? '"Windows"' : mac ? '"macOS"' : android ? '"Android"' : '"Linux"'
	};
}

export class ProxyController {
	#ctx;
	#manager;
	#store;
	#config;
	#decider;
	#browser;
	#searchDepth = 0;
	#busy = { connectivity: false, bandwidth: false, latency: false };
	#onChange;

	constructor(options) {
		this.#ctx = options.ctx;
		this.#manager = options.manager;
		this.#store = options.store;
		this.#config = options.config ?? (() => ({}));
		this.#onChange = options.onChange ?? null;
		this.#decider = new AutoDecider({
			directThresholdMs: () => this.settings.auto?.directThresholdMs,
			probeTimeoutMs: () => this.settings.auto?.probeTimeoutMs,
			cacheSeconds: () => this.settings.auto?.cacheSeconds
		});
		this.#browser = new BrowserSession({});
	}

	get manager() {
		return this.#manager;
	}

	get settings() {
		return this.#store.value;
	}

	get browser() {
		return this.#browser;
	}

	get busy() {
		return { ...this.#busy };
	}

	get dataDir() {
		const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
		return join(root, "clash-proxy");
	}

	/** Load settings and resume the master switch if the user left it on. */
	async init() {
		await this.#store.load();
		if (this.settings.enabled) {
			try {
				await this.#manager.start();
			} catch (error) {
				this.#ctx?.logger?.warn?.("clash-proxy: could not resume the proxy: %s", String(error?.message ?? error));
			}
		}
		await this.#changed();
	}

	// ---- decisions ---------------------------------------------------------

	/** Direct/auto decision for the `web` channel (web_fetch). */
	async decideFetch(url) {
		const settings = this.settings;
		if (!settings.enabled) return { useProxy: false, reason: "master off", host: hostOf(url) };
		if (!settings.scopes.web) return { useProxy: false, reason: "web scope off", host: hostOf(url) };
		const host = hostOf(url);
		if (isLoopback(host)) return { useProxy: false, reason: "loopback", host };
		if (!this.#manager.proxying) return { useProxy: false, reason: "proxy not running", host };
		const mode = String(settings.modes.web ?? "auto");
		if (mode === "off") return { useProxy: false, reason: "mode=off", host };
		if (mode === "on") return { useProxy: true, reason: "mode=on", host };
		// auto: the rule engine owns "is this a foreign destination"; the probe then
		// answers "do we even need the tunnel for it".
		const verdict = this.#manager.decide(host);
		if (verdict === "reject") return { useProxy: false, reason: "rule: reject", host };
		if (verdict === "direct") return { useProxy: false, reason: "rule: direct", host };
		const decided = await this.#decider.decide(url, "auto");
		return { useProxy: decided.useProxy, reason: decided.reason, host, directMs: decided.directMs };
	}

	/**
	 * Synchronous decision for the node:http(s) patch. Only the `search` and
	 * `scripts` channels reach here, and each one is opt-in.
	 */
	decideTunnel(host) {
		const settings = this.settings;
		if (!settings.enabled) return null;
		const channel = this.#searchDepth > 0 ? "search" : settings.scopes.scripts ? "scripts" : null;
		if (channel === null) return null;
		if (isLoopback(host)) return null;
		if (!this.#manager.proxying) return null;
		const mode = channel === "search" ? String(settings.modes.search ?? "auto") : "auto";
		if (mode === "off") return null;
		if (mode === "on") return { useProxy: true, port: this.#manager.status().port };
		if (this.#manager.decide(host) !== "proxy") return null;
		const known = this.#decider.peek(host);
		if (known !== undefined) return known.useProxy ? { useProxy: true, port: this.#manager.status().port } : null;
		// Unknown host: proxy now (the rule engine already said it is foreign) and learn
		// for next time whether the direct path would have been good enough.
		this.#decider.kick(`https://${host}/`, "auto");
		return { useProxy: true, port: this.#manager.status().port };
	}

	/** Run a delegated search with the proxy enabled irrespectively of the scripts scope. */
	async withSearchTunnel(operation) {
		this.#searchDepth += 1;
		try {
			return await operation();
		} finally {
			this.#searchDepth = Math.max(0, this.#searchDepth - 1);
		}
	}

	/** Header overrides for HTTP clients we control (fetch provider / browser). */
	spoofHeaders() {
		const spoof = this.settings.spoof ?? {};
		if (!spoof.enabled) return {};
		const userAgent = this.#userAgent();
		const headers = {
			"user-agent": userAgent,
			"accept-language": String(spoof.acceptLanguage ?? "en-US,en;q=0.9")
		};
		if (spoof.clientHints !== false) Object.assign(headers, clientHints(userAgent));
		return headers;
	}

	#userAgent() {
		const spoof = this.settings.spoof ?? {};
		const custom = String(spoof.userAgent ?? "").trim();
		if (custom.length > 0) return custom;
		return UA_PRESETS[String(spoof.uaPreset ?? "chrome_win")] ?? UA_PRESETS.chrome_win;
	}

	// ---- mutations ---------------------------------------------------------

	async patchSettings(patch) {
		const before = this.settings;
		const next = await this.#store.patch(patch ?? {});
		this.#decider.reset();
		if (before.enabled !== next.enabled) await this.setEnabled(next.enabled, { persist: false });
		if (before.spoof?.timezone !== next.spoof?.timezone || before.spoof?.locale !== next.spoof?.locale || before.spoof?.userAgent !== next.spoof?.userAgent) {
			// A running browser keeps the context it launched with; say so instead of lying.
			if (this.#browser.status.running) this.#ctx?.logger?.info?.("clash-proxy: browser camouflage changes apply on next launch");
		}
		await this.#changed();
		return this.state();
	}

	async setEnabled(enabled, options = {}) {
		if (options.persist !== false) await this.#store.patch({ enabled: enabled === true });
		this.#decider.reset();
		if (enabled === true) {
			await this.#manager.start();
			// Turning the switch on is the natural moment to refresh the numbers:
			// node latencies first, then one throughput sample of the chosen node.
			void this.#autoMeasure();
		} else {
			await this.#manager.stop();
			await this.#browser.close().catch(() => {});
		}
		this.#decider.log.push({ host: "*", action: enabled ? "on" : "off", reason: "master switch", mode: "manual" });
		await this.#changed();
		return this.state();
	}

	/** Notify the host wiring that channels may need to take over / release. */
	async #changed() {
		if (this.#onChange === null) return;
		try {
			await this.#onChange(this.settings);
		} catch (error) {
			this.#ctx?.logger?.warn?.("clash-proxy: channel reconcile failed: %s", String(error?.message ?? error));
		}
	}

	/** Best-effort auto speed test after switching the proxy on. */
	async #autoMeasure() {
		try {
			await this.testLatency("all");
		} catch {
			// a manual test already claimed the slot; nothing to do
		}
		try {
			await this.testBandwidth(this.#manager.currentNodeName ?? null);
		} catch {
			// same
		}
	}

	async selectNode(name) {
		await this.#manager.selectNode(name);
		this.#decider.reset();
		return this.state();
	}

	/** Forget the "why did this get proxied" history shown in the panel. */
	clearDecisions() {
		this.#decider.log.clear();
	}

	/** Record a web_fetch routing decision for the panel's history table. */
	recordFetchDecision(decision) {
		if (decision === null || decision === undefined) return;
		const host = String(decision.host ?? "");
		if (host.length === 0) return;
		this.#decider.log.push({
			host,
			action: decision.useProxy ? "proxy" : "direct",
			reason: String(decision.reason ?? ""),
			directMs: decision.directMs ?? null,
			mode: "fetch"
		});
	}

	// ---- measurements ------------------------------------------------------

	async testConnectivity() {
		if (this.#busy.connectivity) throw new Error("a connectivity test is already running");
		this.#busy.connectivity = true;
		try {
			const result = await this.#manager.connectivity({ timeoutMs: this.settings.speed?.connectTimeoutMs });
			this.#decider.log.push({
				host: "connectivity",
				action: result.direct?.ok ? "direct" : "proxy",
				reason: `direct ${result.direct?.ok ? `${result.direct.ms}ms` : result.direct?.error ?? "failed"} / proxy ${result.proxy === null ? "off" : result.proxy.ok ? `${result.proxy.ms}ms` : result.proxy.error ?? "failed"}`,
				mode: "probe"
			});
			return result;
		} finally {
			this.#busy.connectivity = false;
		}
	}

	async testLatency(name) {
		if (this.#busy.latency) throw new Error("a latency test is already running");
		this.#busy.latency = true;
		try {
			if (name === undefined || name === null || name === "all" || name === "") return { results: await this.#manager.testAllLatencies() };
			return { results: { [name]: await this.#manager.testLatency(name) } };
		} finally {
			this.#busy.latency = false;
		}
	}

	async testBandwidth(name) {
		if (this.#busy.bandwidth) throw new Error("a bandwidth test is already running");
		this.#busy.bandwidth = true;
		try {
			const result = await this.#manager.measureNodeBandwidth(name ?? null, {
				urls: this.settings.speed?.downloadUrls,
				budgetMs: this.settings.speed?.budgetMs
			});
			this.#decider.log.push({
				host: name ?? "current node",
				action: "speed",
				reason: `${result.ok ? `${result.mbps.toFixed(2)} Mbps${result.url ? ` via ${result.url}` : ""}` : result.error ?? "failed"}`,
				mode: "speed"
			});
			return result;
		} finally {
			this.#busy.bandwidth = false;
		}
	}

	// ---- subscription ------------------------------------------------------

	async refreshSubscription(explicitUrl) {
		const section = this.#config() ?? {};
		const url =
			String(explicitUrl ?? "").trim() ||
			String(section.subscriptionUrl ?? "").trim() ||
			String(process.env.CLASH_SUBSCRIPTION_URL ?? "").trim() ||
			(await readFile(join(this.dataDir, "sub.url"), "utf8").catch(() => ""));
		const target = String(url).replace(/^\uFEFF/, "").trim();
		if (target.length === 0) throw new Error("no subscription URL: set one in the panel, CLASH_SUBSCRIPTION_URL, or $DSH_HOME/clash-proxy/sub.url");
		const { raw, via } = await fetchSubscriptionRaw(target, { proxyPort: this.#manager.status().port, logger: this.#ctx?.logger });
		await mkdir(this.dataDir, { recursive: true });
		await writeFile(join(this.dataDir, "subscription.yaml"), raw);
		await writeFile(join(this.dataDir, "subscription.meta.json"), JSON.stringify({ at: Date.now(), via }));
		await this.#manager.restart();
		this.#decider.reset();
		return { via, bytes: raw.length, status: this.#manager.status() };
	}

	// ---- browser -----------------------------------------------------------

	async browserAction(action, options = {}) {
		if (action === "status") return this.#browser.status;
		if (action === "close") return this.#browser.close();
		if (action === "open" || action === "navigate") {
			const settings = this.settings;
			const proxyPort = settings.enabled && settings.scopes.browser && this.#manager.proxying ? this.#manager.status().port : 0;
			const urls = options.url !== undefined ? [String(options.url)] : ["https://ipinfo.io/json"];
			return this.#browser.open({
				proxyPort,
				spoof: settings.spoof,
				profile: settings.browser,
				urls
			});
		}
		throw new Error(`unknown browser action "${action}"`);
	}

	// ---- snapshot ----------------------------------------------------------

	proxyEnv() {
		const port = this.#manager.status().port;
		return {
			powershell: proxyEnvLines(port, { shell: "powershell" }),
			cmd: proxyEnvLines(port, { shell: "cmd" }),
			bash: proxyEnvLines(port, { shell: "bash" })
		};
	}

	state() {
		const settings = this.settings;
		const status = this.#manager.status();
		return {
			version: VERSION,
			enabled: settings.enabled,
			modes: settings.modes,
			scopes: settings.scopes,
			auto: settings.auto,
			spoof: { ...settings.spoof, resolvedUserAgent: this.#userAgent() },
			browserProfile: settings.browser,
			speed: settings.speed,
			engine: status,
			nodes: this.#manager.nodeSummary(),
			port: status.port,
			env: this.proxyEnv(),
			decisions: this.#decider.log.list(),
			browser: this.#browser.status,
			busy: this.busy,
			uaPresets: Object.keys(UA_PRESETS)
		};
	}
}

function hostOf(url) {
	try {
		return new URL(String(url)).hostname;
	} catch {
		return "";
	}
}

export { VERSION };
