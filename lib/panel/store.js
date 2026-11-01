// Persisted panel settings: one small JSON file next to the subscription cache.
//
// These knobs are deliberately *not* part of the plugin's schemastery Config: they
// are runtime preferences the page edits on every click, and routing each of those
// through the harness settings document would rebuild the web service on every
// toggle. File-backed keeps the panel instant and the plugin's config stable.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** User-agent presets offered by the spoofing page. */
export const UA_PRESETS = {
	chrome_win:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	chrome_mac:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	safari_mac:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
	edge_win:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
	firefox_win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
	android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
	ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1"
};

/** Defaults: everything off until the user switches it on. */
export function defaultSettings() {
	return {
		/** Master switch the user owns; nothing is proxied while false. */
		enabled: false,
		/** Per-channel policy: off | on | auto. */
		modes: { web: "auto", search: "auto" },
		/** Per-channel participation, so a channel can be excluded while the master is on. */
		scopes: { web: true, search: false, scripts: false, browser: true },
		/** Auto-mode probe behaviour. */
		auto: { directThresholdMs: 1500, probeTimeoutMs: 1200, cacheSeconds: 600 },
		/** Fingerprint / locale camouflage. */
		spoof: {
			enabled: false,
			uaPreset: "chrome_win",
			userAgent: "",
			acceptLanguage: "en-US,en;q=0.9",
			locale: "en-US",
			timezone: "America/New_York",
			webrtc: "strip",
			dns: "remote",
			clientHints: true,
			hideWebdriver: true
		},
		/** Browser instance the panel launches itself (it owns the proxy + camouflage). */
		browser: { channel: "msedge", headless: false, userDataDir: "" },
		/** Speed-test targets: tried in order, sampled for `budgetMs` each. */
		speed: {
			downloadUrls: [
				"https://speed.cloudflare.com/__down?bytes=20971520",
				"https://proof.ovh.net/files/10Mb.dat",
				"https://ash-speed.hetzner.com/100MB.bin"
			],
			budgetMs: 8000,
			connectTimeoutMs: 6000
		}
	};
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursive merge of a patch onto a base (arrays and scalars replace). */
export function mergeSettings(base, patch) {
	const out = { ...base };
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeSettings(out[key], value);
		else if (value !== undefined) out[key] = value;
	}
	return out;
}

/** The subset of settings that goes to the page (no secrets here, so everything). */
export class PanelStore {
	#path;
	#value = defaultSettings();
	#loaded = false;

	constructor(options) {
		this.#path = options.path ?? join(process.cwd(), "clash-proxy-panel.json");
	}

	get path() {
		return this.#path;
	}

	get value() {
		return this.#value;
	}

	async load() {
		if (this.#loaded) return this.#value;
		this.#loaded = true;
		try {
			const raw = await readFile(this.#path, "utf8");
			this.#value = mergeSettings(defaultSettings(), JSON.parse(raw));
		} catch {
			// First run (or an unreadable file): defaults are the answer.
		}
		return this.#value;
	}

	/** Merge a patch, persist atomically, return the new value. */
	async patch(patch) {
		await this.load();
		this.#value = mergeSettings(this.#value, patch ?? {});
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.#value, null, "\t")}\n`);
		await rename(temporary, this.#path);
		return this.#value;
	}
}
