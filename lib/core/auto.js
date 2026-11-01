// Auto mode: decide per destination host whether a request should go through the
// subscription node, based on a cheap direct-connection probe.
//
// The probe is a plain TCP connect to the target's port (80/443). It answers the
// only question the decision needs — "can this machine reach the host directly,
// and how slowly?" — without sending any HTTP bytes, so it never looks like
// traffic to the destination and costs one SYN.
//
// Decisions are cached per host, and the last N of them are kept for the panel so
// the user can see *why* a request was proxied (the point of "自动思考后自主选择").
import net from "node:net";

/** Ring buffer of recent decisions, newest first. */
export class DecisionLog {
	#entries = [];
	#limit;

	constructor(limit = 60) {
		this.#limit = limit;
	}

	push(entry) {
		this.#entries.unshift({ ...entry, at: Date.now() });
		if (this.#entries.length > this.#limit) this.#entries.length = this.#limit;
	}

	list() {
		return this.#entries.slice();
	}

	clear() {
		this.#entries = [];
	}
}

/** One TCP connect probe. Resolves to milliseconds, or null when it failed/timed out. */
export function probeTcp(host, port, timeoutMs = 1200) {
	return new Promise((resolve) => {
		const started = Date.now();
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		const socket = net.connect({ host, port });
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(Date.now() - started));
		socket.once("timeout", () => done(null));
		socket.once("error", () => done(null));
	});
}

/** Target port for a host: the URL's own port when given, else the scheme default. */
export function targetPort(url) {
	try {
		const parsed = typeof url === "string" ? new URL(url) : url;
		if (parsed.port.length > 0) return Number(parsed.port);
		return parsed.protocol === "http:" ? 80 : 443;
	} catch {
		return 443;
	}
}

/**
 * Per-host direct-reachability cache with the auto policy on top.
 *
 * Policy (`mode`):
 * - `on`   always proxy
 * - `off`  never proxy
 * - `auto` probe the host; proxy when the direct path fails or is slower than
 *          `directThresholdMs`
 */
export class AutoDecider {
	#cache = new Map();
	#inflight = new Set();
	#log;
	#options;

	constructor(options = {}) {
		this.#options = options;
		this.#log = options.log ?? new DecisionLog();
	}

	get log() {
		return this.#log;
	}

	/** Drop the cache (master switch toggled, node changed, settings edited). */
	reset() {
		this.#cache.clear();
	}

	/** Cached verdict for a host, or `undefined` when nothing is known yet. */
	peek(host) {
		const cached = this.#cache.get(host);
		if (cached === undefined) return undefined;
		if (Date.now() - cached.at >= this.#cacheSeconds() * 1000) return undefined;
		return cached.value;
	}

	/**
	 * Start a probe without waiting for it, so a later synchronous decision has a
	 * real measurement to read. Never throws.
	 */
	kick(url, mode = "auto") {
		const host = (() => {
			try {
				return new URL(url).hostname;
			} catch {
				return "";
			}
		})();
		if (host.length === 0 || this.peek(host) !== undefined) return;
		if (this.#inflight.has(host)) return;
		this.#inflight.add(host);
		void this.decide(url, mode)
			.catch(() => {})
			.finally(() => this.#inflight.delete(host));
	}

	#cacheSeconds() {
		return Math.max(30, Number(this.#options.cacheSeconds?.() ?? 600));
	}

	#threshold() {
		return Math.max(100, Number(this.#options.directThresholdMs?.() ?? 1500));
	}

	#timeout() {
		return Math.max(200, Number(this.#options.probeTimeoutMs?.() ?? 1200));
	}

	/**
	 * Decide for one URL.
	 * @param url - the absolute URL about to be fetched.
	 * @param mode - "on" | "off" | "auto"
	 * @returns `{ useProxy, reason, host, directMs }`
	 */
	async decide(url, mode) {
		let host;
		try {
			host = new URL(url).hostname;
		} catch {
			return { useProxy: false, reason: "unparsable url", host: "", directMs: null };
		}
		if (mode === "off") return { useProxy: false, reason: "mode=off", host, directMs: null };
		if (mode === "on") return { useProxy: true, reason: "mode=on", host, directMs: null };
		if (isLoopback(host)) return { useProxy: false, reason: "loopback", host, directMs: null };

		const cached = this.#cache.get(host);
		const now = Date.now();
		if (cached !== undefined && now - cached.at < this.#cacheSeconds() * 1000) {
			return { ...cached.value, host, cached: true };
		}

		const directMs = await probeTcp(host, targetPort(url), this.#timeout());
		const threshold = this.#threshold();
		let value;
		if (directMs === null) value = { useProxy: true, reason: `direct unreachable within ${this.#timeout()}ms`, directMs: null };
		else if (directMs > threshold) value = { useProxy: true, reason: `direct ${directMs}ms > ${threshold}ms`, directMs };
		else value = { useProxy: false, reason: `direct ${directMs}ms ≤ ${threshold}ms`, directMs };

		this.#cache.set(host, { at: now, value });
		this.#log.push({ host, action: value.useProxy ? "proxy" : "direct", reason: value.reason, directMs: value.directMs, mode });
		return { ...value, host };
	}
}

/** True for loopback/link-local/unroutable literal hosts that must never be proxied. */
export function isLoopback(host) {
	const value = String(host ?? "").toLowerCase();
	if (value === "localhost" || value === "::1" || value === "0.0.0.0") return true;
	if (value.startsWith("127.")) return true;
	if (value.startsWith("::ffff:127.")) return true;
	return false;
}
