// Route *other* plugins' HTTP traffic through the local rule proxy.
//
// The web_fetch tool reaches the network through `ctx.web`'s fetch provider, which
// this plugin owns — but a good part of the ecosystem talks to `node:https`
// directly (dsh-free-search's engines, updaters, MCP bridges). Those callers have
// no seam, so the only honest lever is the module itself.
//
// `installNodeTunnel` wraps `http.request` / `https.request` and, per request,
// either leaves the call untouched or swaps in an agent that opens a CONNECT
// tunnel to 127.0.0.1:<proxyPort>. The rule engine then makes the real decision
// (Chinese destinations still go direct inside the proxy), so this stays a
// transport substitution and never a global redirect: loopback, the decision's
// own control plane, and every `direct` verdict are left alone.
//
// Synchronous by necessity — `request()` must return a ClientRequest immediately,
// so the decision comes from the (synchronous) cache/rules view, never a probe.
//
// Composition rules (this is a shared global; other plugins wrap it too):
// - install once, per process: a second install joins the existing one;
// - dispose only puts back what we replaced, and only if our wrapper is still
//   the one in place; if someone wrapped us later we go inert instead of
//   ripping their wrapper off the module;
// - a caller-supplied `agent` always wins — we do not replace it, because doing
//   so would silently drop its TLS options/pooling;
// - a CONNECT failure surfaces as a request error; it never falls back to a
//   silent direct connection.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

/** Hard cap on the CONNECT response head we are willing to buffer. */
const MAX_HEADER_BYTES = 16 * 1024;
/** TCP + CONNECT handshake budget. */
const CONNECT_TIMEOUT_MS = 20_000;
/** TLS handshake budget on top of an established tunnel. */
const TLS_TIMEOUT_MS = 15_000;

const REGISTRY_KEY = Symbol.for("dsh-clash-proxy.tunnel-registry");

/** TLS settings a caller may set on `https.request` that must survive the tunnel. */
const TLS_OPTION_KEYS = [
	"ca",
	"cert",
	"key",
	"pfx",
	"passphrase",
	"ciphers",
	"sigalgs",
	"minVersion",
	"maxVersion",
	"secureOptions",
	"secureProtocol",
	"checkServerIdentity",
	"ALPNProtocols",
	"session",
	"ecdhCurve",
	"dhparam",
	"honorCipherOrder",
	"crl",
	"requestOCSP",
	"rejectUnauthorized"
];

const LOOPBACK_NAMES = new Set(["localhost", "::1", "0.0.0.0", "::"]);

/** Loopback / local destinations must never be sent through the tunnel. */
export function isLoopbackHost(host) {
	const name = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (name.length === 0) return false;
	if (LOOPBACK_NAMES.has(name)) return true;
	if (name.startsWith("127.")) return true;
	if (name.startsWith("::ffff:127.")) return true;
	return false;
}

function hostOf(options) {
	let host = String(options?.hostname ?? options?.host ?? "").trim();
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end === -1 ? host : host.slice(1, end);
	}
	return host.replace(/:\d+$/, "");
}

function formatTarget(host, port) {
	const bare = String(host).replace(/^\[|\]$/g, "");
	return net.isIP(bare) === 6 ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/** Open a CONNECT tunnel to the local proxy and hand back the raw socket. */
export function connectTunnel(proxyPort, host, port, callback, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
	const target = formatTarget(host, port);
	const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
	let buffer = Buffer.alloc(0);
	let settled = false;

	const cleanup = () => {
		socket.off("data", onData);
		socket.off("error", onError);
		socket.off("close", onClose);
		socket.off("timeout", onTimeout);
	};
	const finish = (error, result) => {
		if (settled) return;
		settled = true;
		cleanup();
		socket.setTimeout(0);
		if (error) {
			socket.destroy();
			callback(error);
			return;
		}
		callback(null, result);
		// The socket was paused so the proxy's early bytes could be unshifted safely.
		// Resume on the next macrotask: the consumer attached its listeners while the
		// promise/microtask chain ran, and buffered data is not lost in the meantime.
		setImmediate(() => {
			if (!result.destroyed) result.resume();
		});
	};
	const onData = (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		const end = buffer.indexOf("\r\n\r\n");
		if (end === -1) {
			if (buffer.length > MAX_HEADER_BYTES) finish(new Error(`clash-proxy tunnel response head too large for ${target}`));
			return;
		}
		const statusLine = buffer.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
		const code = Number(/^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine)?.[1] ?? 0);
		if (code < 200 || code > 299) {
			finish(new Error(`clash-proxy tunnel refused ${target} (${statusLine || "no response"})`));
			return;
		}
		// The proxy may have pushed bytes that belong to the tunnel (e.g. an early
		// banner); they must go back into the socket before the caller reads it.
		// Pause first: with no 'data' listener the flushed buffer would be emitted
		// into the void, and the caller would miss those bytes.
		const rest = buffer.subarray(end + 4);
		socket.pause();
		if (rest.length > 0) socket.unshift(rest);
		finish(null, socket);
	};
	const onError = (error) => finish(error);
	const onClose = () => finish(new Error(`clash-proxy tunnel to ${target} closed before the CONNECT reply`));
	const onTimeout = () => finish(new Error(`clash-proxy tunnel timeout for ${target}`));

	socket.setTimeout(timeoutMs);
	socket.on("data", onData);
	socket.once("error", onError);
	socket.once("close", onClose);
	socket.on("timeout", onTimeout);
	socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
}

/** Plain-HTTP agent: the tunnel is transparent, node writes the request into it. */
class HttpTunnelAgent extends http.Agent {
	constructor(proxyPort) {
		super({ keepAlive: false });
		this.proxyPort = proxyPort;
	}

	createConnection(options, callback) {
		const host = hostOf(options);
		if (host.length === 0) {
			callback(new Error("clash-proxy tunnel: request has no host"));
			return;
		}
		connectTunnel(this.proxyPort, host, Number(options.port) || 80, callback);
	}
}

function pickTlsOptions(options) {
	const picked = {};
	for (const key of TLS_OPTION_KEYS) {
		if (options[key] !== undefined) picked[key] = options[key];
	}
	return picked;
}

function sniName(options) {
	if (typeof options.servername === "string" && options.servername.length > 0) return options.servername;
	const host = hostOf(options);
	return net.isIP(host) === 0 ? host : undefined;
}

/** HTTPS agent: tunnel first, then run TLS over the tunnel socket. */
export class HttpsTunnelAgent extends https.Agent {
	constructor(proxyPort, { tlsTimeoutMs = TLS_TIMEOUT_MS } = {}) {
		super({ keepAlive: false });
		this.proxyPort = proxyPort;
		this.tlsTimeoutMs = tlsTimeoutMs;
	}

	createConnection(options, callback) {
		const host = hostOf(options);
		if (host.length === 0) {
			callback(new Error("clash-proxy tunnel: request has no host"));
			return;
		}
		connectTunnel(this.proxyPort, host, Number(options.port) || 443, (error, raw) => {
			if (error) {
				callback(error);
				return;
			}
			let socket;
			try {
				socket = tls.connect({
					...pickTlsOptions(options),
					socket: raw,
					servername: sniName(options)
				});
			} catch (tlsError) {
				raw.destroy();
				callback(tlsError);
				return;
			}
			let done = false;
			let timer = null;
			const settle = (tlsError) => {
				if (done) return;
				done = true;
				if (timer !== null) clearTimeout(timer);
				socket.off("error", onError);
				if (tlsError) {
					raw.destroy();
					socket.destroy();
					callback(tlsError);
					return;
				}
				callback(null, socket);
			};
			const onError = (tlsError) => settle(tlsError);
			timer = setTimeout(() => {
				settle(new Error(`clash-proxy TLS handshake timeout for ${formatTarget(host, Number(options.port) || 443)}`));
			}, this.tlsTimeoutMs);
			timer.unref?.();
			socket.once("secureConnect", () => settle(null));
			socket.once("error", onError);
		});
	}
}

function isOptionsObject(value) {
	return value !== null && typeof value === "object" && !(value instanceof URL) && !Array.isArray(value) && !(value instanceof Function);
}

/** `request(url[, options][, callback])` / `request(options[, callback])` → one shape. */
function planCall(input, rest) {
	let options;
	let explicitAgent = false;
	let callbackArgs = rest;
	if (typeof input === "string" || input instanceof URL) {
		const url = input instanceof URL ? input : new URL(input);
		options = {
			protocol: url.protocol,
			hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
			port: url.port,
			path: `${url.pathname}${url.search}`,
			auth: url.username.length > 0 ? `${url.username}:${url.password}` : undefined
		};
		if (rest.length > 0 && isOptionsObject(rest[0])) {
			const extra = rest[0];
			explicitAgent = extra.agent !== undefined;
			options = { ...options, ...extra };
			callbackArgs = rest.slice(1);
		}
	} else if (isOptionsObject(input)) {
		options = input;
		explicitAgent = input.agent !== undefined;
	} else {
		return null;
	}
	return { options, host: hostOf(options), explicitAgent, callbackArgs };
}

function tunnelAgent(state, secure, port) {
	const slot = secure ? "https" : "http";
	const cached = state.agents[slot].get(port);
	if (cached !== undefined) return cached;
	// Ports change when the user flips the master switch. Never destroy the old
	// agent here: a request that is already in flight owns its socket, and
	// keepAlive is off, so evicted agents drain and die on their own.
	if (state.agents[slot].size >= 8) {
		const oldest = state.agents[slot].keys().next().value;
		state.agents[slot].delete(oldest);
	}
	const agent = secure ? new HttpsTunnelAgent(port) : new HttpTunnelAgent(port);
	state.agents[slot].set(port, agent);
	return agent;
}

function destroyAgents(state) {
	for (const slot of ["http", "https"]) {
		for (const agent of state.agents[slot].values()) agent.destroy?.();
		state.agents[slot].clear();
	}
}

function makeWrapper(state, mod, previous, secure) {
	return function request(input, ...rest) {
		// Disposed: pass straight through the wrapper we replaced.
		if (!state.active) return previous.call(mod, input, ...rest);
		let call;
		try {
			call = planCall(input, rest);
		} catch {
			// A malformed URL string is Node's error to raise, not ours.
			return previous.call(mod, input, ...rest);
		}
		if (call === null || call.host.length === 0 || call.explicitAgent || isLoopbackHost(call.host)) {
			return previous.call(mod, input, ...rest);
		}
		let decision = null;
		try {
			decision = state.decide(call.host);
		} catch {
			decision = null;
		}
		const proxyPort = Number(decision?.port ?? 0);
		if (decision?.useProxy !== true || !(proxyPort > 0 && proxyPort < 65536)) return previous.call(mod, input, ...rest);
		const options = { ...call.options, agent: tunnelAgent(state, secure, proxyPort) };
		return previous.call(mod, options, ...call.callbackArgs);
	};
}

function createDisposer(state) {
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		state.refs -= 1;
		if (state.refs > 0) return;
		state.active = false;
		// Only put back the function we found — if another plugin wrapped us after
		// this install, their wrapper stays in place and now delegates to our inert
		// pass-through, so their behaviour is preserved.
		if (http.request === state.wrappers.http) http.request = state.previous.http;
		if (https.request === state.wrappers.https) https.request = state.previous.https;
		destroyAgents(state);
		if (globalThis[REGISTRY_KEY] === state) delete globalThis[REGISTRY_KEY];
	};
}

/**
 * Install the wrappers.
 * @param decide - `(host) => {useProxy?: boolean, port?: number} | null`.
 * @returns dispose()
 */
export function installNodeTunnel(decide) {
	const existing = globalThis[REGISTRY_KEY];
	if (existing !== undefined && existing !== null && existing.active && http.request === existing.wrappers.http && https.request === existing.wrappers.https) {
		existing.refs += 1;
		existing.decide = decide;
		return createDisposer(existing);
	}
	if (existing !== undefined && existing !== null) existing.active = false;

	const state = {
		active: true,
		refs: 1,
		decide,
		previous: { http: http.request, https: https.request },
		wrappers: {},
		/** port → agent; keepAlive is off, so stale ports drain by themselves. */
		agents: { http: new Map(), https: new Map() }
	};
	state.wrappers.http = makeWrapper(state, http, state.previous.http, false);
	state.wrappers.https = makeWrapper(state, https, state.previous.https, true);
	http.request = state.wrappers.http;
	https.request = state.wrappers.https;
	globalThis[REGISTRY_KEY] = state;
	return createDisposer(state);
}

/** True when the wrappers installed by this module are the ones currently in place. */
export function isNodeTunnelInstalled() {
	const state = globalThis[REGISTRY_KEY];
	return state !== undefined && state !== null && state.active && http.request === state.wrappers.http && https.request === state.wrappers.https;
}

/** Environment lines for shells that start *outside* this process (scripts, apps). */
export function proxyEnvLines(port, { shell = "powershell" } = {}) {
	if (!(port > 0)) return [];
	const url = `http://127.0.0.1:${port}`;
	const noProxy = "127.0.0.1,localhost,::1";
	if (shell === "cmd") {
		return [`set HTTP_PROXY=${url}`, `set HTTPS_PROXY=${url}`, `set ALL_PROXY=${url}`, `set NO_PROXY=${noProxy}`];
	}
	if (shell === "bash") {
		return [`export http_proxy=${url}`, `export https_proxy=${url}`, `export all_proxy=${url}`, `export no_proxy=${noProxy}`];
	}
	return [
		`$env:HTTP_PROXY = "${url}"`,
		`$env:HTTPS_PROXY = "${url}"`,
		`$env:ALL_PROXY = "${url}"`,
		`$env:NO_PROXY = "${noProxy}"`
	];
}
