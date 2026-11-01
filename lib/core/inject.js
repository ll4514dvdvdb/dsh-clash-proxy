import { createServer } from "node:net";
import { ProxyAgent } from "undici";

/**
 * Harness-scoped proxy injection.
 *
 * Two channels, both confined to the DSH process tree:
 * - Environment variables: every process DSH spawns afterwards (pwsh/terminal
 *   tools, background jobs, workflow workers, subagents) inherits them, so
 *   `curl`, `npm`, `git`, and Node child scripts route through the core.
 * - The global fetch dispatcher: DSH's own in-process `fetch` (web search,
 *   LLM, MCP) honors the environment through undici's EnvHttpProxyAgent.
 * Nothing outside this process tree is touched: no system proxy, no TUN.
 */

/** Proxy-related environment keys we set and restore. */
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];

/** Loopback entries always exempt from the proxy, whatever the user config says. */
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1,<local>";

/** Env snapshot so teardown can restore exactly what it found. */
function snapshotEnv() {
	const saved = {};
	for (const key of PROXY_ENV_KEYS) saved[key] = process.env[key];
	return saved;
}

/** Strip proxy variables from an env object (used for the mihomo child process). */
export function withoutProxyEnv(env) {
	const cleaned = { ...env };
	for (const key of PROXY_ENV_KEYS) delete cleaned[key];
	return cleaned;
}

/** Build the NO_PROXY value: user list plus mandatory loopback entries. */
export function composeNoProxy(userValue) {
	const parts = [LOOPBACK_NO_PROXY];
	if (userValue !== void 0 && userValue.length > 0) parts.push(userValue);
	return [...new Set(parts.join(",").split(",").map((part) => part.trim()).filter(Boolean))].join(",");
}

/**
 * Point the current process's proxy environment at the local core.
 * @param port - the core's mixed (HTTP+SOCKS) port.
 * @param noProxyUser - the configured NO_PROXY value.
 * @returns a disposer restoring the previous environment.
 */
export function injectEnvironment(port, noProxyUser) {
	const saved = snapshotEnv();
	const target = `http://127.0.0.1:${port}`;
	const noProxy = composeNoProxy(noProxyUser);
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
		process.env[key] = target;
	}
	process.env.NO_PROXY = noProxy;
	process.env.no_proxy = noProxy;
	return () => {
		for (const key of PROXY_ENV_KEYS) {
			if (saved[key] === void 0) delete process.env[key];
			else process.env[key] = saved[key];
		}
	};
}

/** Build a hostname predicate from a NO_PROXY list (exact, `.suffix`, `<local>`). */
export function buildNoProxyMatcher(noProxyValue) {
	const entries = composeNoProxy(noProxyValue).split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
	const exact = new Set();
	const suffixes = [];
	for (const entry of entries) {
		if (entry === "*") return () => true;
		if (entry.startsWith(".")) suffixes.push(entry);
		else exact.add(entry);
	}
	return (hostname) => {
		const host = String(hostname ?? "").toLowerCase();
		if (host.length === 0 || host === "localhost") return true;
		if (!host.includes(".")) return true; // <local>
		if (host === "127.0.0.1" || host === "::1" || host.startsWith("[")) return true;
		if (exact.has(host)) return true;
		return suffixes.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
	};
}

/**
 * Make DSH's own `fetch` calls honor the injected proxy environment.
 *
 * Two strategies, newest runtime first:
 * - Node ≤ 23 exposes `node:undici`; installing its EnvHttpProxyAgent as the
 *   global dispatcher redirects the built-in fetch without patching call
 *   sites (NO_PROXY honored by the agent itself).
 * - Node ≥ 24 removed `node:undici`, so the fallback wraps `globalThis.fetch`
 *   and picks a dispatcher per request (proxy vs plain) using the NO_PROXY
 *   matcher. Callers that pass their own `dispatcher` keep it.
 *
 * Construction happens AFTER {@link injectEnvironment} so the proxy target is
 * the harness-scoped variable rather than any pre-existing ambient one.
 * @returns an async disposer restoring the previous state, or `undefined`
 * when the runtime exposes no workable path (env-only degradation).
 */
export async function installFetchDispatcher() {
	try {
		const builtin = await import("node:undici");
		if (typeof builtin.setGlobalDispatcher === "function" && typeof builtin.getGlobalDispatcher === "function") {
			if (typeof builtin.EnvHttpProxyAgent === "function") {
				const previous = builtin.getGlobalDispatcher();
				builtin.setGlobalDispatcher(new builtin.EnvHttpProxyAgent());
				return async () => {
					builtin.setGlobalDispatcher(previous);
				};
			}
			if (typeof builtin.ProxyAgent === "function") {
				const target = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
				if (target !== void 0 && target.length > 0) {
					const previous = builtin.getGlobalDispatcher();
					builtin.setGlobalDispatcher(new builtin.ProxyAgent(target));
					return async () => {
						builtin.setGlobalDispatcher(previous);
					};
				}
			}
		}
	} catch {
		// node:undici absent (Node ≥ 24) — fall through to the wrapper.
	}
	return wrapFetch();
}

/** Wrap globalThis.fetch with per-call proxy selection. */
function wrapFetch() {
	const original = globalThis.fetch;
	if (typeof original !== "function") return undefined;
	const target = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
	if (target === void 0 || target.length === 0) return undefined;
	const proxyAgent = new ProxyAgent(target);
	const matchesNoProxy = buildNoProxyMatcher(process.env.NO_PROXY);
	const wrapped = function fetch(input, init) {
		let href = "";
		if (typeof input === "string") href = input;
		else if (typeof input === "object" && input !== null && typeof input.url === "string") href = input.url;
		let host = "";
		try {
			host = new URL(href, "http://placeholder.invalid").hostname;
		} catch {
			// Unparseable URL: keep the native path.
		}
		const provided = typeof init === "object" && init !== null ? init.dispatcher : undefined;
		// NO_PROXY hosts (loopback etc.) keep the native fetch path — no
		// dispatcher injection — so bypassed traffic never touches undici's
		// npm dispatchers. Callers that pass their own dispatcher keep it.
		const dispatcher = provided ?? (matchesNoProxy(host) ? undefined : proxyAgent);
		if (dispatcher === undefined) {
			if (init === undefined || init === null) return original.call(globalThis, input);
			return original.call(globalThis, input, init);
		}
		return original.call(globalThis, input, init === undefined || init === null ? { dispatcher } : { ...init, dispatcher });
	};
	globalThis.fetch = wrapped;
	return () => {
		if (globalThis.fetch === wrapped) globalThis.fetch = original;
	};
}

/**
 * Control-plane note: the plugin's own management traffic (binary download,
 * subscription fetch, controller API) uses the plain built-in fetch — the
 * runtime's own undici copy — which behaves well on every network. The npm
 * undici dispatchers above are used ONLY for the proxy path, whose target is
 * always the local core (loopback), where they are reliable.
 */

/** Pick one free loopback TCP port. */
export function pickFreePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}
