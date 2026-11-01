// A browser instance this plugin owns, so "proxy + camouflage" is actually true.
//
// dsh-reef launches its Chromium with no proxy, no locale and no timezone hook, and
// has no seam to inject any of them (see browser.mjs:launchPersistentContext). So
// the panel drives its own profile instead: Playwright's persistent context takes
// `proxy`, `locale`, `timezoneId`, `userAgent` and `extraHTTPHeaders` directly, and
// `addInitScript` covers the surfaces those options cannot reach (WebRTC leaking the
// real interface, `navigator.webdriver`, `navigator.languages`).
//
// playwright-core is already in the profile (dsh-reef depends on it); we resolve it
// by walking up from this file so both an npm install and a workspace symlink work.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/** Find a loadable playwright-core, or null. */
function loadPlaywright() {
	const seen = new Set();
	let directory = HERE;
	for (let depth = 0; depth < 8; depth += 1) {
		const candidates = [join(directory, "node_modules", "playwright-core"), join(directory, "playwright-core")];
		for (const candidate of candidates) {
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			if (!existsSync(join(candidate, "package.json"))) continue;
			try {
				return require(candidate);
			} catch {
				// keep walking
			}
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	try {
		return require("playwright-core");
	} catch {
		return null;
	}
}

/** Script that runs before every page: closes the gaps the launch options leave. */
function initScript(spoof) {
	const languages = String(spoof.acceptLanguage ?? "en-US,en;q=0.9")
		.split(",")
		.map((part) => part.split(";")[0].trim())
		.filter((part) => part.length > 0);
	const webrtc = String(spoof.webrtc ?? "strip");
	return `(() => {
	const languages = ${JSON.stringify(languages)};
	Object.defineProperty(navigator, "languages", { get: () => languages.slice() });
	Object.defineProperty(navigator, "language", { get: () => languages[0] ?? "en-US" });
	${spoof.hideWebdriver === false ? "" : `Object.defineProperty(navigator, "webdriver", { get: () => false });`}
	${
		webrtc === "disabled"
			? `try { window.RTCPeerConnection = undefined; window.webkitRTCPeerConnection = undefined; } catch (e) {}`
			: webrtc === "strip"
				? `(() => {
		const Native = window.RTCPeerConnection;
		if (!Native) return;
		const rewrite = (description) => {
			if (!description || typeof description.sdp !== "string") return description;
			const sdp = description.sdp.replace(/^(a=candidate:.+ typ )host.*$/gim, "").replace(/^(a=candidate:.+ typ )srflx.*$/gim, "");
			try { return { type: description.type, sdp }; } catch (e) { return description; }
		};
		const Patched = function (...args) {
			const peer = new Native(...args);
			const original = peer.setLocalDescription.bind(peer);
			peer.setLocalDescription = (description) => original(rewrite(description));
			return peer;
		};
		Patched.prototype = Native.prototype;
		Object.setPrototypeOf(Patched, Native);
		window.RTCPeerConnection = Patched;
	})();`
				: ""
	}
})();`;
}

export class BrowserSession {
	#status = { running: false, channel: null, url: null, error: null, startedAt: null, ip: null, timezone: null };
	#context = null;
	#page = null;
	#playwright = undefined;

	constructor(options) {
		this.options = options;
	}

	get status() {
		return { ...this.#status };
	}

	#pw() {
		if (this.#playwright === undefined) this.#playwright = loadPlaywright();
		return this.#playwright;
	}

	/**
	 * Launch (or reuse) the panel browser.
	 * @param options.proxyPort - local proxy port; 0 launches without a proxy.
	 * @param options.spoof - camouflage settings.
	 * @param options.profile - browser settings (channel, headless, userDataDir).
	 * @param options.urls - pages opened on start.
	 */
	async open(options) {
		const { proxyPort = 0, spoof = {}, profile = {}, urls = ["https://ipinfo.io/json"] } = options ?? {};
		if (this.#context !== null) {
			for (const url of urls) await this.navigate(url);
			return this.status;
		}
		const playwright = this.#pw();
		if (playwright === null) throw new Error("playwright-core is not resolvable from this plugin; install it in the profile (dsh-reef already ships it)");
		const userDataDir = String(profile.userDataDir ?? "").trim() || join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "clash-proxy", "browser-profile");
		const launch = {
			headless: profile.headless === true,
			userDataDir,
			args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
			ignoreDefaultArgs: ["--enable-automation"],
			locale: String(spoof.locale ?? "en-US"),
			timezoneId: String(spoof.timezone ?? "America/New_York"),
			extraHTTPHeaders: {
				"accept-language": String(spoof.acceptLanguage ?? "en-US,en;q=0.9")
			}
		};
		const userAgent = String(spoof.userAgent ?? "").trim();
		if (userAgent.length > 0) launch.userAgent = userAgent;
		if (proxyPort > 0) launch.proxy = { server: `http://127.0.0.1:${proxyPort}` };

		const channels = [];
		const configured = String(profile.channel ?? "").trim();
		if (configured.length > 0 && configured !== "auto") channels.push({ channel: configured });
		for (const channel of ["msedge", "chrome"]) if (!channels.some((entry) => entry.channel === channel)) channels.push({ channel });
		channels.push({});

		let lastError = null;
		for (const candidate of channels) {
			try {
				const context = await playwright.chromium.launchPersistentContext(userDataDir, { ...launch, ...candidate });
				await context.addInitScript(initScript(spoof));
				this.#context = context;
				this.#status = { running: true, channel: candidate.channel ?? "bundled", url: null, error: null, startedAt: Date.now(), ip: null, timezone: null };
				const pages = context.pages();
				this.#page = pages[0] ?? (await context.newPage());
				this.#status.url = this.#page.url();
				for (const url of urls) await this.navigate(url);
				await this.#refreshFacts();
				return this.status;
			} catch (error) {
				lastError = error;
			}
		}
		this.#status = { running: false, channel: null, url: null, error: lastError instanceof Error ? lastError.message : String(lastError), startedAt: null, ip: null, timezone: null };
		throw new Error(`could not launch a browser for the proxy panel: ${this.#status.error}`);
	}

	/** Open a URL in the panel browser (starts it when needed). */
	async navigate(url, options) {
		if (this.#context === null) return (await this.open({ ...options, urls: [url] }));
		if (this.#page === null || this.#page.isClosed()) this.#page = await this.#context.newPage();
		await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
		this.#status.url = url;
		await this.#refreshFacts();
		return this.status;
	}

	/** Read what the page thinks its timezone/language/IP are (proof the camouflage held). */
	async #refreshFacts() {
		if (this.#page === null) return;
		try {
			const facts = await this.#page.evaluate(async () => {
				const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
				let ip = null;
				try {
					const response = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
					ip = (await response.json()).ip ?? null;
				} catch {
					ip = null;
				}
				return { timezone, ip, language: navigator.language, languages: navigator.languages.slice(0, 3), webdriver: navigator.webdriver };
			});
			this.#status = { ...this.#status, ...facts, url: this.#page.url() };
		} catch {
			// A page that refuses evaluate still leaves the launch facts standing.
		}
	}

	async close() {
		const context = this.#context;
		this.#context = null;
		this.#page = null;
		if (context !== null) await context.close().catch(() => {});
		this.#status = { running: false, channel: null, url: null, error: null, startedAt: null, ip: null, timezone: null };
		return this.status;
	}
}
