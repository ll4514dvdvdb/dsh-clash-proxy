import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath, domainToASCII } from "node:url";

/**
 * Rule engine: decides `direct` | `proxy` | `reject` per target host.
 *
 * Matching order for a hostname:
 * 1. user extraRules, in order (DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, IP-CIDR)
 * 2. subscription passthrough rules (same types, DIRECT/REJECT only)
 * 3. the embedded CN domain suffix table → direct
 * 4. default → proxy
 *
 * IP literals skip domain rules and use the embedded CN CIDR tables plus any
 * custom IP-CIDR rules, defaulting to proxy.
 * @module dsh-clash-proxy/rules
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "data");

function loadJson(name) {
	return JSON.parse(gunzipSync(readFileSync(join(dataDir, name))).toString("utf8"));
}

// The embedded tables are large — 110k domain suffixes cost roughly 15 MB of
// heap once boxed into a Set, plus a temporary array while JSON.parse runs — and
// they are only needed while a listener is actually up. So they are decoded on
// first use and dropped again by releaseRuleData() when the listener stops,
// which keeps a mounted-but-off plugin at ~0 MB for rule data.
/** @type {Set<string> | null} */
let cnSuffixesCache = null;
/** @type {Array<[number, number]> | null} */
let cnCidrs4Cache = null;
/** @type {Array<{groups: number[], prefix: number}> | null} */
let cnCidrs6Cache = null;

/** Quote a group without going through Number() — keeps "01" invalid. */
const GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
/** Strict dotted quad: no empty octets, no leading zeros, no sign. */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function parseCidr6(cidr) {
	const slash = cidr.indexOf("/");
	if (slash <= 0) return null;
	const groups = ipv6ToGroups(cidr.slice(0, slash));
	const prefix = Number(cidr.slice(slash + 1));
	if (groups === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
	return { groups, prefix };
}

function compareGroups(a, b) {
	for (let i = 0; i < 8; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

function compareCidr6(a, b) {
	return compareGroups(a.groups, b.groups) || a.prefix - b.prefix;
}

/** Embedded domestic domain suffixes (DOMAIN-SUFFIX semantics), lazily decoded. */
function cnSuffixes() {
	return (cnSuffixesCache ??= new Set(loadJson("cn-domains.json.gz")));
}

/** Embedded domestic IPv4 CIDRs [[baseInt, prefixLen], ...] sorted by base. */
function cnCidrs4() {
	return (cnCidrs4Cache ??= loadJson("cn-cidrs.json.gz")
		.filter((row) => Array.isArray(row) && Number.isInteger(row[0]) && row[0] >= 0 && row[0] <= 0xffffffff && Number.isInteger(row[1]) && row[1] >= 0 && row[1] <= 32)
		.sort((a, b) => a[0] - b[0]));
}

/** Embedded domestic IPv6 CIDRs [network(8×u16), prefixLen] sorted. */
function cnCidrs6() {
	return (cnCidrs6Cache ??= loadJson("cn-cidrs6.json.gz")
		.map(parseCidr6)
		.filter((row) => row !== null)
		.sort(compareCidr6));
}

/** Drop the decoded tables — the listener is going away, free the ~15 MB. */
export function releaseRuleData() {
	cnSuffixesCache = null;
	cnCidrs4Cache = null;
	cnCidrs6Cache = null;
}

/** IPv4 dotted string → uint32, or null when the string is not a strict dotted quad. */
export function ipv4ToInt(ip) {
	if (typeof ip !== "string" || !IPV4_RE.test(ip)) return null;
	const parts = ip.split(".").map(Number);
	return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/**
 * IPv6 string → 8×uint16 groups (uncompressed), or null when malformed.
 * Accepts `::` compression, bracketed literals and a trailing dotted-quad
 * (`::ffff:192.0.2.1`); zone ids (`%eth0`) are rejected.
 */
export function ipv6ToGroups(ip) {
	if (typeof ip !== "string") return null;
	let text = ip.trim();
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
	if (text.length === 0 || text.includes("%") || text.includes("/") || text.includes(":::")) return null;

	// A trailing dotted quad counts as the last two groups.
	const lastColon = text.lastIndexOf(":");
	if (lastColon === -1) return null;
	const tail = text.slice(lastColon + 1);
	if (tail.includes(".")) {
		const v4 = ipv4ToInt(tail);
		if (v4 === null) return null;
		text = `${text.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;
	const parseHalf = (half) => {
		if (half.length === 0) return [];
		const groups = half.split(":");
		if (groups.some((group) => !GROUP_RE.test(group))) return null;
		return groups.map((group) => parseInt(group, 16));
	};
	if (halves.length === 1) {
		const groups = parseHalf(text);
		return groups !== null && groups.length === 8 ? groups : null;
	}
	const left = parseHalf(halves[0] ?? "");
	const right = parseHalf(halves[1] ?? "");
	if (left === null || right === null) return null;
	if (left.length + right.length > 7) return null;
	return [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * True when `groups` falls inside `network/prefix`.
 * Bits are compared 16 at a time, so partial groups are handled correctly.
 */
export function cidr6Contains(groups, network, prefix) {
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
	let remaining = prefix;
	for (let i = 0; i < 8 && remaining > 0; i++) {
		const take = Math.min(16, remaining);
		const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
		if ((groups[i] & mask) !== (network[i] & mask)) return false;
		remaining -= take;
	}
	return true;
}

/** True when the IPv4 int falls inside any embedded CN CIDR. */
export function inCnCidr4(ipInt) {
	for (const [base, prefix] of cnCidrs4()) {
		if (base > ipInt) return false; // sorted: no later row can match
		const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
		if ((ipInt & mask) === (base & mask)) return true;
	}
	return false;
}

/**
 * True when the IPv6 groups fall inside any embedded CN CIDR.
 * The table is sorted, so the scan can stop as soon as the next network is
 * already past the candidate — every later entry is further away.
 */
export function inCnCidr6(groups) {
	for (const { groups: network, prefix } of cnCidrs6()) {
		if (compareGroups(network, groups) > 0) return false;
		if (cidr6Contains(groups, network, prefix)) return true;
	}
	return false;
}

const RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "MATCH", "GEOIP"]);

/**
 * Compile a rule line ("TYPE,param[,param],TARGET") into a matcher.
 * Supported types: DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, IP-CIDR, IP-CIDR6,
 * MATCH, GEOIP (CN only). Unknown types yield null; format errors yield
 * `{ error }` so the caller can report them instead of silently dropping.
 */
function compileRule(line) {
	if (typeof line !== "string") return { error: "rule is not a string" };
	const trimmed = line.trim();
	if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
	let parts = trimmed.split(",").map((part) => part.trim());
	// Trailing options such as `no-resolve` are not part of the target.
	while (parts.length > 1 && /^no-resolve$/i.test(parts[parts.length - 1] ?? "")) parts.pop();
	const target = (parts.pop() ?? "").toUpperCase();
	if (target !== "DIRECT" && target !== "PROXY" && target !== "REJECT" && target !== "REJECT-DROP") return { error: `unsupported target "${target || "(empty)"}"` };
	const action = target === "REJECT-DROP" ? "reject" : target.toLowerCase();
	const type = (parts.shift() ?? "").toUpperCase();
	const param = parts.join(",");
	switch (type) {
		case "DOMAIN": {
			const value = param.toLowerCase();
			if (value.length === 0) return { error: "DOMAIN needs a hostname" };
			return { match: (host) => host === value, action };
		}
		case "DOMAIN-SUFFIX": {
			const value = param.toLowerCase();
			if (value.length === 0) return { error: "DOMAIN-SUFFIX needs a suffix" };
			return { match: (host) => host === value || host.endsWith(`.${value}`), action };
		}
		case "DOMAIN-KEYWORD": {
			const value = param.toLowerCase();
			if (value.length === 0) return { error: "DOMAIN-KEYWORD needs a keyword" };
			return { match: (host) => host.includes(value), action };
		}
		case "IP-CIDR": {
			const slash = param.indexOf("/");
			if (slash <= 0) return { error: "IP-CIDR needs a /prefix" };
			const base = ipv4ToInt(param.slice(0, slash));
			const prefix = Number(param.slice(slash + 1));
			if (base === null) return { error: `IP-CIDR has an invalid IPv4 address "${param.slice(0, slash)}"` };
			if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return { error: `IP-CIDR prefix must be 0-32, got "${param.slice(slash + 1)}"` };
			const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
			return { matchIp: (ipInt) => (ipInt & mask) === (base & mask), action };
		}
		case "IP-CIDR6": {
			const slash = param.indexOf("/");
			if (slash <= 0) return { error: "IP-CIDR6 needs a /prefix" };
			const groups = ipv6ToGroups(param.slice(0, slash));
			const prefix = Number(param.slice(slash + 1));
			if (groups === null) return { error: `IP-CIDR6 has an invalid IPv6 address "${param.slice(0, slash)}"` };
			if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return { error: `IP-CIDR6 prefix must be 0-128, got "${param.slice(slash + 1)}"` };
			return { matchIp6: (candidate) => cidr6Contains(candidate, groups, prefix), action };
		}
		case "MATCH":
			return { match: () => true, action };
		case "GEOIP": {
			// The subscription format uses GEOIP,CN,DIRECT to say "domestic → direct".
			if (param.trim().toUpperCase() !== "CN") return { error: `GEOIP only supports CN, got "${param}"` };
			return { matchIp: (ipInt) => inCnCidr4(ipInt), matchIp6: (groups) => inCnCidr6(groups), action };
		}
		default:
			return { error: `unsupported rule type "${type || "(empty)"}"` };
	}
}

/** @typedef {{ruleLines: string[], excludeRules: string[]}} RuleEngineOptions */

export class RuleEngine {
	#hostRules;
	#ipRules;
	#ip6Rules;
	/** @type {Array<{line: string, error: string}>} */
	diagnostics = [];

	/**
	 * @param extraRules - user rule lines, highest priority.
	 * @param excludeRules - subscription rule lines to drop (substring).
	 * @param subscriptionRules - subscription DIRECT/REJECT passthrough lines.
	 */
	constructor({ extraRules = [], excludeRules = [], subscriptionRules = [] } = {}) {
		this.#hostRules = [];
		this.#ipRules = [];
		this.#ip6Rules = [];
		const lines = [
			...extraRules.filter((line) => typeof line === "string").map((line) => ({ line, origin: "user" })),
			...subscriptionRules
				.filter((line) => typeof line === "string" && !excludeRules.some((excluded) => line.includes(excluded)))
				.map((line) => ({ line, origin: "subscription" }))
		];
		for (const { line, origin } of lines) {
			const rule = compileRule(line);
			if (rule === null) continue;
			if (rule.error !== undefined) {
				// Unknown subscription types (RULE-SET, GEOSITE, …) are expected in the wild
				// and are skipped silently; a malformed line of a supported type is not.
				const type = String(line).trim().split(",")[0]?.trim().toUpperCase() ?? "";
				const reportable = origin === "user" || RULE_TYPES.has(type);
				if (reportable && this.diagnostics.length < 100) this.diagnostics.push({ line: String(line), error: rule.error });
				continue;
			}
			if (rule.matchIp !== undefined && rule.matchIp6 !== undefined) {
				// GEOIP,CN: both families.
				this.#ipRules.push({ matchIp: rule.matchIp, action: rule.action });
				this.#ip6Rules.push({ matchIp6: rule.matchIp6, action: rule.action });
			} else if (rule.matchIp !== undefined) this.#ipRules.push(rule);
			else if (rule.matchIp6 !== undefined) this.#ip6Rules.push(rule);
			else this.#hostRules.push(rule);
		}
	}

	/** Decision for a hostname (lowercased). */
	matchHost(host) {
		for (const rule of this.#hostRules) if (rule.match(host)) return rule.action;
		return null;
	}

	/** Decision for an IPv4 int. */
	matchIp(ipInt) {
		for (const rule of this.#ipRules) if (rule.matchIp(ipInt)) return rule.action;
		if (inCnCidr4(ipInt)) return "direct";
		return null;
	}

	/** Decision for IPv6 groups. */
	matchIp6(groups) {
		for (const rule of this.#ip6Rules) if (rule.matchIp6(groups)) return rule.action;
		// IPv4-mapped addresses (::ffff:a.b.c.d) belong to the IPv4 table too.
		if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
			const mapped = ((groups[6] << 16) | groups[7]) >>> 0;
			for (const rule of this.#ipRules) if (rule.matchIp(mapped)) return rule.action;
			if (inCnCidr4(mapped)) return "direct";
		}
		if (inCnCidr6(groups)) return "direct";
		return null;
	}

	/** Normalize a host: lowercase, strip brackets/port, IDN → punycode, drop trailing dot. */
	static normalizeHost(rawHost) {
		let host = String(rawHost ?? "").trim().toLowerCase();
		if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
		if (host.length === 0) return "";
		if (/[^\x00-\x7f]/.test(host)) host = domainToASCII(host) || host;
		while (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
		return host;
	}

	/** Final decision for a raw host string (hostname or IP literal). */
	decide(rawHost) {
		const host = RuleEngine.normalizeHost(rawHost);
		if (host.length === 0) return "proxy";
		const ip4 = ipv4ToInt(host);
		if (ip4 !== null) return this.matchIp(ip4) ?? "proxy";
		const ip6 = ipv6ToGroups(host);
		if (ip6 !== null) return this.matchIp6(ip6) ?? "proxy";
		const ruleAction = this.matchHost(host);
		if (ruleAction !== null) return ruleAction;
		const suffixes = cnSuffixes();
		if (suffixes.has(host) || host === "cn" || host.endsWith(".cn")) return "direct";
		for (let dot = host.indexOf("."); dot !== -1; dot = host.indexOf(".", dot + 1)) {
			if (suffixes.has(host.slice(dot + 1))) return "direct";
		}
		return "proxy";
	}
}
