import yaml from "js-yaml";
import { ProxyAgent } from "undici";

/**
 * Clash subscription fetching and parsing.
 *
 * Accepts both a full mihomo config (proxies / proxy-groups / rules) and a
 * bare proxy list, plus the base64-wrapped bodies some providers deliver.
 * Subscription fetches use the built-in fetch by default (no proxy — a
 * chicken-and-egg on first run) and can optionally use a dedicated upstream
 * (`fetchProxyUrl`) via undici's ProxyAgent.
 * @module dsh-clash-proxy/subscription
 */

/** True for localhost/loopback URLs (never route these through a proxy). */
function isLoopback(url) {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

/** Fetch the raw subscription body. */
export async function fetchSubscription(url, fetchProxyUrl, timeoutMs = 30000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const dispatcher = !isLoopback(url) && fetchProxyUrl !== void 0 && fetchProxyUrl.length > 0
		? new ProxyAgent(fetchProxyUrl)
		: undefined;
	try {
		const response = await fetch(url, {
			redirect: "follow",
			...(dispatcher === undefined ? {} : { dispatcher }),
			signal: controller.signal,
			headers: {
				"user-agent": "clash-verge/v2.0.0",
				accept: "text/plain, application/yaml, */*"
			}
		});
		if (!response.ok) throw new Error(`subscription HTTP ${response.status}`);
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

/** True when the body looks like base64 rather than YAML. */
function looksBase64(text) {
	const head = text.trimStart().slice(0, 64);
	return !/^[a-z_][\w-]*\s*:|\s*-\s/m.test(text) && /^[A-Za-z0-9+/=\r\n]+$/.test(head.replace(/\s+/g, ""));
}

/** Parse one subscription body into proxies, groups, and rules. */
export function parseSubscription(raw) {
	let document = null;
	const attempts = [raw];
	if (looksBase64(raw)) attempts.unshift(Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8"));
	for (const candidate of attempts) {
		try {
			document = yaml.load(candidate);
			if (document !== null && typeof document === "object") break;
			document = null;
		} catch {
			// Try the next representation.
		}
	}
	if (document === null) throw new Error("subscription body is neither YAML nor base64-wrapped YAML");

	const payload = Array.isArray(document) ? { proxies: document } : document;
	const rawProxies = Array.isArray(payload?.proxies) ? payload.proxies : [];
	const proxies = rawProxies.filter((proxy) => {
		const name = typeof proxy === "string" ? proxy : proxy?.name;
		if (name === "DIRECT" || name === "REJECT" || name === "REJECT-DROP" || name === "PASS" || name === "COMPATIBLE" || name === "GLOBAL") return false;
		if (typeof name !== "string" || name.length === 0) return false;
		return true;
	});
	const groups = Array.isArray(payload?.["proxy-groups"]) ? payload["proxy-groups"] : [];
	const rules = Array.isArray(payload?.rules) ? payload.rules : [];

	return {
		proxies,
		groups,
		rules,
		names: proxies.map((proxy) => typeof proxy === "string" ? proxy : String(proxy.name)).filter(Boolean)
	};
}

/** Sanitize group objects: drop group members that do not resolve. */
export function sanitizeGroups(groups, names) {
	const known = new Set(names);
	const clean = [];
	for (const group of groups) {
		if (typeof group !== "object" || group === null) continue;
		const members = Array.isArray(group.proxies)
			? group.proxies.filter((member) => known.has(member) || member === "DIRECT" || member === "REJECT")
			: [];
		if (members.length === 0) continue;
		clean.push({ ...group, proxies: members });
	}
	return clean;
}
