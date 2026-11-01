// web_fetch fetch provider backed by the local rule-splitting proxy.
//
// DeepSeek Harness resolves `web.fetch` through a *provider* (`ctx.web.registerFetchProvider`),
// so nothing here touches `globalThis.fetch` or `process.env`: the model API traffic and
// every other caller of undici/fetch inside the host keep their original path.
//
// The provider asks the panel controller whether *this* URL should be tunnelled, which is
// what makes the master switch, the per-channel mode and auto mode all apply to web_fetch.
import { ProxyAgent, request } from "undici";

const PROXY_PROVIDER_ID = "clash-proxy-fetch";

const TEXTUAL = /^(text\/|application\/(xhtml|xml|json|javascript|ecmascript|x-www-form-urlencoded)|image\/svg)/i;

const BASE_HEADERS = {
	"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
	accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
	"accept-encoding": "identity"
};

function kindFor(contentType) {
	if (/html|xml/i.test(contentType)) return "html";
	return "text";
}

function stub(contentType) {
	const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
	return mime.length > 0 ? mime : "unknown";
}

/**
 * @param {object} options
 * @param {(url: string) => Promise<{useProxy: boolean, port?: number, reason?: string, host?: string}>} options.decide
 *        per-URL routing decision from the panel controller
 * @param {() => Record<string, string>} [options.headers]  live camouflage headers (empty when disabled)
 * @param {(decision: object) => void} [options.onDecision] optional observer for the panel's log
 * @param {object} [options.logger]
 */
export function createProxyFetchProvider({ decide, headers, onDecision, logger }) {
	let dispatcher = null;
	let dispatcherPort = 0;

	const dispatcherFor = (proxyPort) => {
		if (dispatcher !== null && dispatcherPort === proxyPort) return dispatcher;
		dispatcher?.close?.().catch?.(() => {});
		dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${proxyPort}`, pipelining: 1 });
		dispatcherPort = proxyPort;
		return dispatcher;
	};

	return {
		id: PROXY_PROVIDER_ID,

		/** Cheap local availability probe; must not perform network I/O. */
		available() {
			return true;
		},

		async fetch(fetchRequest, signal) {
			const url = String(fetchRequest?.url ?? "");
			if (!/^https?:\/\//i.test(url)) throw new Error(`clash-proxy-fetch: unsupported URL "${url.slice(0, 80)}"`);
			const decision = await decide(url);
			onDecision?.(decision);
			const proxyPort = decision.useProxy ? Number(decision.port ?? 0) : 0;
			const base = {
				method: "GET",
				headers: { ...BASE_HEADERS, ...(headers?.() ?? {}) },
				signal
			};
			if (proxyPort > 0) base.dispatcher = dispatcherFor(proxyPort);

			// undici v7 dropped `maxRedirections`; follow redirects by hand.
			let current = url;
			for (let hop = 0; hop < 6; hop++) {
				const response = await request(current, base);
				const location = response.headers?.location;
				if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
					await response.body.dump();
					current = new URL(String(location), current).href;
					continue;
				}
				const contentType = String(response.headers?.["content-type"] ?? "");
				const body = await response.body.text();
				const textual = TEXTUAL.test(contentType) || contentType.length === 0;
				logger?.debug?.(
					"clash-proxy: fetch %s -> %d (%d bytes, %s, via %s)",
					current,
					response.statusCode,
					body.length,
					stub(contentType),
					proxyPort > 0 ? `127.0.0.1:${proxyPort}` : "direct"
				);
				if (!textual) {
					// Binary payloads are out of scope for a text-oriented fetch chain; let the
					// caller see a clear status instead of mojibake.
					return { url: current, statusCode: response.statusCode, body: { kind: "binary", content: "" }, truncated: false };
				}
				return {
					url: current,
					statusCode: response.statusCode,
					body: { kind: kindFor(contentType), content: body },
					truncated: false
				};
			}
			throw new Error(`clash-proxy-fetch: too many redirects for ${url}`);
		},

		dispose() {
			dispatcher?.close?.().catch?.(() => {});
			dispatcher = null;
			dispatcherPort = 0;
		}
	};
}

export { PROXY_PROVIDER_ID, BASE_HEADERS };
