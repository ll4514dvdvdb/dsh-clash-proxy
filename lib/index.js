// DeepSeek Harness plugin: on-demand rule-splitting proxy for the agent's own web access.
//
// Since 0.2.0 this is one self-contained plugin with one page:
//
// * `web/clash-proxy-panel` —a same-origin page (served by the harness `webServer`
//   under the `/clash-proxy-panel/` prefix and embedded by the GUI as an iframe), plus
//   a sidebar entry that opens it. No second port, no CORS, no token in a URL.
// * four independent channels, so "proxy" is never all-or-nothing:
//     web      web_fetch (this plugin's fetch provider decides per URL)
//     search   web_search upstream calls (tunnel installed only for the duration of
//              the delegated search, so it cannot leak into unrelated traffic)
//     scripts  every other `node:http(s)` caller (env vars shown on the page; the
//              tunnel is also always armed while this scope is on)
//     browser  the browser the panel launches itself (it owns proxy + camouflage)
// * a user-owned master switch persisted in `$DSH_HOME/clash-proxy/panel.json`, and
//   per-channel `off | on | auto`, where auto asks the rule engine first and then
//   probes the direct path for that host.
// * camouflage on the HTTP side (user agent, accept-language, client hints) and on
//   the browser side (timezone, locale, WebRTC, `navigator.webdriver`).
//
// Still true from 0.1.0: nothing touches the system proxy, WinHTTP, a TUN adapter,
// `globalThis.fetch` or `process.env`; the model API traffic keeps its own path.
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { ClashManager } from "./core/manager.js";
import { installNodeTunnel } from "./core/tunnel.js";
import { ProxyController, VERSION } from "./panel/controller.js";
import { createPanelRoute, PREFIX as PANEL_PREFIX } from "./panel/routes.js";
import { PanelStore } from "./panel/store.js";
import { createProxyFetchProvider, PROXY_PROVIDER_ID } from "./provider.js";

const SEARCH_PROVIDER_ID = "clash-proxy-search";

// Startup trace. The host exposes no plugin-load log, so the only way to tell
// "module never imported" apart from "apply() threw" is to write a line ourselves.
const BOOT_LOG = join(homedir(), ".dsh", "clash-proxy-boot.log");
function boot(message) {
	try {
		appendFileSync(BOOT_LOG, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`);
	} catch {
		// tracing must never break the plugin
	}
}

export const name = "clash-proxy";

boot(`module loaded (node ${process.version}, panel ${VERSION})`);

/** `web` provides the provider registries and `webServer` the page route. */
export const inject = ["timer", "web"];

export const Config = z.object({
	/** Kept in the schema so the settings page shows the field; the listener never auto-starts. */
	subscriptionUrl: z.string().default("").volatile(),
	groupType: z.string().default("url-test").volatile(),
	latencyTestUrl: z.string().default("http://www.gstatic.com/generate_204").volatile(),
	latencyTimeoutMs: z.number().default(3000).volatile(),
	autoUpdateHours: z.number().default(0).volatile(),
	extraRules: z.array(z.string()).default([]).volatile(),
	excludeRules: z.array(z.string()).default([]).volatile()
});

function resolveConfig(config) {
	if (config === null || typeof config !== "object") return {};
	const out = {};
	for (const [key, value] of Object.entries(config)) {
		out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
	}
	return out;
}

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function describe(status) {
	const parts = [`state=${status.state}`];
	if (status.port) parts.push(`port=${status.port}`);
	if (status.nodeCount) parts.push(`nodes=${status.nodeCount}`);
	if (status.current) parts.push(`node=${status.current}`);
	if (status.error) parts.push(`error=${status.error}`);
	return parts.join(" ");
}

async function apply(ctx, config) {
	boot(`apply() entered; services=${Object.keys(ctx).length > 0 ? "ctx ok" : "ctx empty"}`);
	try {
		await applyInner(ctx, config);
		boot("apply() completed");
	} catch (error) {
		boot(`apply() threw: ${error?.stack ?? error}`);
		throw error;
	}
}

async function applyInner(ctx, config) {
	const current = () => resolveConfig(config);
	const logger = ctx.logger;
	boot(`logger=${logger ? "present" : "absent"}; web=${ctx.web ? "present" : "absent"}`);

	const manager = new ClashManager(
		ctx,
		() => {
			const section = current();
			// The manager loads the subscription from its cache file only; refresh is handled
			// in the controller because the upstream `fetchSubscription` uses HTTP/1.1, which
			// this subscription host drops (see lib/subscription-refresh.js).
			return { ...section, enabled: true, subscriptionUrl: "" };
		},
		{ subscriptionUrlEnv: "CLASH_SUBSCRIPTION_URL", dataDirName: "clash-proxy" }
	);

	// --- web_fetch provider -------------------------------------------------
	const controller = new ProxyController({
		ctx,
		manager,
		store: new PanelStore({ path: join(dshHome(), "clash-proxy", "panel.json") }),
		config: current,
		onChange: () => reconcile()
	});

	const fetchProvider = createProxyFetchProvider({
		decide: (url) => controller.decideFetch(url),
		headers: () => controller.spoofHeaders(),
		onDecision: (decision) => controller.recordFetchDecision(decision),
		logger
	});

	// --- provider takeover bookkeeping -------------------------------------
	const webProviderRef = (field) => {
		const ref = ctx.web?.config?.[field];
		return ref !== undefined && ref !== null && typeof ref.get === "function" ? ref : null;
	};
	const currentProviderId = (field) => {
		const ref = webProviderRef(field);
		if (ref !== null) return ref.get();
		return field === "fetchProvider" ? ctx.web?.fetchProviderId : ctx.web?.searchProviderId;
	};
	const setProvider = async (field, id) => {
		const ref = webProviderRef(field);
		if (ref !== null) {
			const settings = ctx.get("settings");
			if (typeof settings?.mutate !== "function") throw new Error("settings service unavailable; cannot switch the web provider");
			await settings.mutate("web", [{ op: "set", path: [field], value: id }]);
			return;
		}
		if (ctx.web) ctx.web[field] = id;
	};

	let previousFetchProvider = null;
	let previousSearchProvider = null;
	let searchProviderRegistered = false;

	try {
		const disposeFetch = ctx.web.registerFetchProvider(fetchProvider);
		boot(`fetch provider registered as ${PROXY_PROVIDER_ID}`);
		ctx.effect(
			() => () => {
				fetchProvider.dispose?.();
				disposeFetch?.();
			},
			"clash-proxy: fetch provider"
		);
	} catch (error) {
		boot(`fetch provider registration failed: ${error?.stack ?? error}`);
		logger?.warn?.("clash-proxy: fetch provider registration failed: %s", String(error?.message ?? error));
	}

	/** The search provider we wrap: whichever one settings named before us. */
	const resolveSearchDelegate = () => {
		const id = String(previousSearchProvider ?? "").trim();
		if (id.length === 0 || id === SEARCH_PROVIDER_ID) return null;
		return ctx.web?.searchProviders?.get(id) ?? null;
	};

	const searchProvider = {
		id: SEARCH_PROVIDER_ID,
		available() {
			return resolveSearchDelegate() !== null;
		},
		async search(request, signal) {
			const delegate = resolveSearchDelegate();
			if (delegate === null) throw new Error("clash-proxy-search: no base search provider to delegate to (set one in Settings →Web)");
			// The tunnel is armed only for this call: a search either uses it entirely or
			// not at all, and no unrelated request can be caught in between.
			return controller.withSearchTunnel(() => delegate.search(request, signal));
		},
		dispose() {}
	};

	try {
		const disposeSearch = ctx.web.registerSearchProvider(searchProvider);
		searchProviderRegistered = true;
		boot(`search provider registered as ${SEARCH_PROVIDER_ID}`);
		ctx.effect(
			() => () => {
				searchProvider.dispose?.();
				disposeSearch?.();
			},
			"clash-proxy: search provider"
		);
	} catch (error) {
		searchProviderRegistered = false;
		boot(`search provider registration failed: ${error?.stack ?? error}`);
		logger?.warn?.("clash-proxy: search provider registration failed: %s", String(error?.message ?? error));
	}

	// --- channel reconcile --------------------------------------------------
	/** Any registered search provider that is not us (fallback when a static config names us). */
	const firstForeignSearchProvider = () => {
		const map = ctx.web?.searchProviders;
		if (!map || typeof map.keys !== "function") return null;
		for (const id of map.keys()) {
			if (id !== SEARCH_PROVIDER_ID) return String(id);
		}
		return null;
	};

	const reconcile = async () => {
		const settings = controller.settings;
		const live = manager.status().state === "running";
		// web_fetch: point the registry at us only while the proxy is actually on.
		if (settings.enabled && live) {
			const before = currentProviderId("fetchProvider");
			if (before !== PROXY_PROVIDER_ID) {
				previousFetchProvider = String(before ?? "").trim() || "http";
				await setProvider("fetchProvider", PROXY_PROVIDER_ID).catch((error) =>
					logger?.warn?.("clash-proxy: could not point web_fetch at the proxy: %s", String(error?.message ?? error))
				);
			}
		} else if (previousFetchProvider !== null && currentProviderId("fetchProvider") === PROXY_PROVIDER_ID) {
			await setProvider("fetchProvider", previousFetchProvider).catch(() => {});
			previousFetchProvider = null;
		}
		// web_search: only when the user put the search channel in scope.
		if (searchProviderRegistered) {
			if (settings.enabled && live && settings.scopes.search) {
				const before = currentProviderId("searchProvider");
				if (before !== SEARCH_PROVIDER_ID) {
					const candidate = String(before ?? "").trim();
					if (candidate.length > 0 && ctx.web.searchProviders?.get(candidate) !== undefined) {
						previousSearchProvider = candidate;
						await setProvider("searchProvider", SEARCH_PROVIDER_ID).catch((error) =>
							logger?.warn?.("clash-proxy: could not point web_search at the proxy: %s", String(error?.message ?? error))
						);
					} else {
						logger?.warn?.("clash-proxy: search channel needs a concrete base search provider; left as %s", candidate || "(unset)");
					}
				}
			} else if (previousSearchProvider !== null && currentProviderId("searchProvider") === SEARCH_PROVIDER_ID) {
				await setProvider("searchProvider", previousSearchProvider).catch(() => {});
				previousSearchProvider = null;
			}
			// A static config may already name us, so no "before" value was ever
			// recorded. The registry still asks available() about us, and a null
			// delegate makes the whole web_search channel fail with "registered but
			// unavailable" — adopt a sibling provider in that case, even when the
			// search scope is off (availability is not scope-dependent).
			if (previousSearchProvider === null && currentProviderId("searchProvider") === SEARCH_PROVIDER_ID) {
				const fallback = firstForeignSearchProvider();
				if (fallback !== null) {
					previousSearchProvider = fallback;
					logger?.info?.(`clash-proxy: adopted ${fallback} as the web_search delegate`);
					boot(`search delegate adopted: ${fallback}`);
				}
			}
		}
	};

	// --- node:http(s) tunnel ------------------------------------------------
	let disposeTunnel = null;
	try {
		disposeTunnel = installNodeTunnel((host) => controller.decideTunnel(host));
		boot("node http(s) tunnel installed");
	} catch (error) {
		boot(`tunnel install failed: ${error?.stack ?? error}`);
	}

	// --- panel route --------------------------------------------------------
	ctx.inject(["webServer"], (sctx) => {
		sctx.effect(() => {
			const dispose = sctx.webServer.register(createPanelRoute(controller));
			boot(`panel route registered at ${PANEL_PREFIX}/`);
			return () => dispose?.();
		}, "clash-proxy: panel route");
	});

	// --- tools --------------------------------------------------------------
	ctx.inject(["tools"], (sctx) => {
		boot("tools service injected");
		sctx.effect(() => {
			const disposers = [];

			disposers.push(
				sctx.tools.register(
					defineTool({
						name: "proxy_control",
						description:
							"Control the agent's own on-demand proxy (rule-splitting: Chinese sites direct, everything else through a subscription node). " +
							"Actions: `on`/`off` flip the user-owned master switch, `status` reports the live state including the current node, " +
							"`refresh` re-downloads the subscription, `connectivity` probes reachability direct vs proxied, " +
							"`bandwidth` measures throughput of the current node (or `node`), `select` picks a node, " +
							"`env` prints shell exports for processes outside this one. It never touches the system proxy.",
						parameters: {
							action: {
								type: "string",
								enum: ["on", "off", "status", "refresh", "connectivity", "bandwidth", "select", "env"],
								description: "What to do."
							},
							node: { type: "string", description: "Only for `select` / `bandwidth`: node name (omit for the current node)." },
							subscriptionUrl: { type: "string", description: "Only for `refresh`: override the configured subscription URL." }
						},
						async execute(args) {
							const action = String(args?.action ?? "status");
							if (action === "on") return { content: `proxy: on —${describe(await controller.setEnabled(true).then(() => manager.status()))}` };
							if (action === "off") return { content: `proxy: off —${describe(await controller.setEnabled(false).then(() => manager.status()))}` };
							if (action === "refresh") {
								const result = await controller.refreshSubscription(args?.subscriptionUrl);
								return { content: `subscription refreshed via ${result.via} (${result.bytes} bytes) —${describe(result.status)}` };
							}
							if (action === "connectivity") {
								const result = await controller.testConnectivity();
								const line = (label, probe) =>
									probe === null ? `${label}: off` : `${label}: ${probe.ok ? `${probe.status} in ${probe.ms}ms` : `failed (${probe.error ?? probe.status})`}`;
								return {
									content: [
										`connectivity @ ${new Date(result.at).toISOString()}`,
										line("direct", result.direct),
										line("proxy ", result.proxy)
									].join("\n")
								};
							}
							if (action === "bandwidth") {
								const result = await controller.testBandwidth(args?.node ?? null);
								return {
									content: result.ok
										? `${args?.node ?? "current node"}: ${result.mbps.toFixed(2)} Mbps (${(result.bytes / 1e6).toFixed(1)} MB in ${(result.ms / 1000).toFixed(1)}s, ttfb ${result.ttfbMs}ms)`
										: `bandwidth test failed: ${result.error ?? result.status}`
								};
							}
							if (action === "select") {
								const name = String(args?.node ?? "").trim();
								if (name.length === 0) throw new Error("proxy_control select: `node` is required");
								const state = await controller.selectNode(name);
								return { content: `node: ${state.nodes.current ?? "(none)"} —${describe(manager.status())}` };
							}
							if (action === "env") {
								const env = controller.proxyEnv();
								if (env.powershell.length === 0) return { content: "proxy is off; switch it on to get proxy environment variables" };
								return { content: [`# PowerShell`, ...env.powershell, ``, `# cmd`, ...env.cmd, ``, `# bash`, ...env.bash].join("\n") };
							}
							const state = controller.state();
							const channels = Object.entries(state.modes)
								.map(([channel, mode]) => `${channel}=${mode}${state.scopes[channel] ? "" : "(out)"}`)
								.join(" ");
							return {
								content: [
									`proxy: ${state.enabled ? "on" : "off"} —${describe(state.engine)}`,
									`channels: ${channels} scripts=${state.scopes.scripts ? "on" : "off"} browser=${state.scopes.browser ? "on" : "off"}`,
									`camouflage: ${state.spoof.enabled ? `on (${state.spoof.timezone}, ${state.spoof.locale}, webrtc=${state.spoof.webrtc}, dns=${state.spoof.dns})` : "off"}`,
									`panel: ${PANEL_PREFIX}/ (sidebar →代理面板)`
								].join("\n")
							};
						},
						finalizeContent(exec, result) {
							return typeof result?.content === "string" ? [{ type: "text", text: result.content }] : undefined;
						}
					})
				)
			);

			disposers.push(
				sctx.tools.register(
					defineTool({
						name: "proxy_fetch",
						description:
							"Fetch a URL through the agent's rule-splitting proxy (Chinese sites direct, everything else via the subscription node) and return the body text. " +
							"Use it for pages that time out from a direct connection. Works even when the proxy is switched off (then it is a plain direct fetch).",
						parameters: {
							url: { type: "string", description: "Absolute http(s) URL to fetch." },
							maxChars: { type: "number", description: "Truncate the returned body to this many characters (default 20000)." }
						},
						async execute(args) {
							const url = String(args?.url ?? "").trim();
							if (!/^https?:\/\//i.test(url)) throw new Error("proxy_fetch: `url` must be an absolute http(s) URL");
							const limit = Math.max(500, Math.min(200000, Number(args?.maxChars ?? 20000)));
							if (!controller.settings.enabled) await controller.setEnabled(true);
							const response = await fetchProvider.fetch({ url });
							const body = String(response?.body?.content ?? "");
							const clipped = body.length > limit ? `${body.slice(0, limit)}\n\n[—truncated ${body.length - limit} chars …]` : body;
							return { content: `HTTP ${response?.statusCode} ${url} (${body.length} chars)\n\n${clipped}` };
						},
						finalizeContent(exec, result) {
							return typeof result?.content === "string" ? [{ type: "text", text: result.content }] : undefined;
						}
					})
				)
			);

			boot(`tools registered: ${disposers.length}`);
			return () => {
				for (const dispose of disposers) dispose?.();
			};
		}, "clash-proxy: tools");
	});

	// --- boot ---------------------------------------------------------------
	await controller.init().catch((error) => boot(`controller init failed: ${error?.stack ?? error}`));

	// Startup reconcile. A static cordis.patch.yml may already name us (nothing to
	// remember), and sibling plugins such as free-search register their provider
	// ("ddg") later than we do — retry briefly instead of staying unavailable.
	void (async () => {
		for (let attempt = 0; attempt < 20 && !searchProvider.available(); attempt += 1) {
			await reconcile().catch((error) => boot(`startup reconcile failed: ${error?.message ?? error}`));
			if (searchProvider.available()) break;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		if (!searchProviderRegistered) return;
		if (searchProvider.available()) boot(`search delegate ready: ${previousSearchProvider}`);
		else logger?.warn?.("clash-proxy: web_search has no delegate after startup reconcile either");
	})();

	ctx.effect(
		() => () => {
			disposeTunnel?.();
			void manager.stop().catch(() => {});
		},
		"clash-proxy: shutdown"
	);
}

export { apply, resolveConfig, SEARCH_PROVIDER_ID };
