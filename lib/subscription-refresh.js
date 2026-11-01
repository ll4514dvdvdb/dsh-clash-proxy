// Subscription download for the plugin.
//
// Two wrinkles make the naive `fetch(url)` useless for this provider:
//  1. The subscription host sits behind Cloudflare and silently drops plain
//     HTTP/1.1 requests (TLS succeeds, then nothing). HTTP/2 works.
//  2. Once a given egress IP has pulled the full list, Cloudflare tarpits
//     repeats from the same IP (2s -> 46s -> minutes).
// So: prefer going through our own proxy (the exit node is a different IP, so a
// different rate-limit bucket), and fall back to a direct HTTP/2 request.
import http2 from "node:http2";
import { ProxyAgent, request } from "undici";

const UA = "clash-verge/v1.7.7";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Single HTTP/1.1 download with a hand-rolled redirect follower (undici v7 has no maxRedirections). */
async function downloadHttp11(url, { dispatcher, timeoutMs }) {
	let current = url;
	for (let hop = 0; hop < 5; hop++) {
		const response = await request(current, {
			method: "GET",
			headers: { "user-agent": UA, accept: "*/*", "accept-encoding": "identity" },
			dispatcher,
			headersTimeout: timeoutMs,
			bodyTimeout: timeoutMs
		});
		const location = response.headers?.location;
		if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
			await response.body.dump();
			current = new URL(String(location), current).href;
			continue;
		}
		if (response.statusCode !== 200) {
			await response.body.dump();
			throw new Error(`HTTP ${response.statusCode}`);
		}
		return await response.body.text();
	}
	throw new Error("too many redirects");
}

async function viaProxy(url, proxyPort, timeoutMs) {
	const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${proxyPort}` });
	try {
		const text = await downloadHttp11(url, { dispatcher, timeoutMs });
		if (!text.includes("proxies:")) throw new Error(`unexpected payload (${text.length}B)`);
		return text;
	} finally {
		dispatcher.close().catch(() => {});
	}
}

async function viaHttp2(url, timeoutMs) {
	const target = new URL(url);
	const client = http2.connect(`${target.protocol}//${target.host}`);
	client.setTimeout(timeoutMs);
	try {
		const chunks = [];
		return await new Promise((resolve, reject) => {
			client.on("error", reject);
			client.on("timeout", () => reject(new Error("http2 timeout")));
			const req = client.request({
				":path": `${target.pathname}${target.search}`,
				":method": "GET",
				"user-agent": UA,
				accept: "*/*",
				"accept-encoding": "identity"
			});
			req.on("response", (headers) => {
				if (headers[":status"] !== 200) reject(new Error(`HTTP ${headers[":status"]}`));
			});
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			req.on("error", reject);
			req.end();
		});
	} finally {
		client.close();
	}
}

async function viaDirect(url, timeoutMs) {
	return await downloadHttp11(url, { dispatcher: undefined, timeoutMs });
}

/**
 * Pull a raw Clash-style subscription document.
 * @param {string} url
 * @param {{ proxyPort?: number, timeoutMs?: number, logger?: any }} [options]
 * @returns {Promise<{ raw: string, via: string }>}
 */
export async function fetchSubscriptionRaw(url, { proxyPort = 0, timeoutMs = 60000, logger } = {}) {
	const attempts = [];
	if (proxyPort > 0) attempts.push(["proxy", () => viaProxy(url, proxyPort, timeoutMs)]);
	attempts.push(["http2", () => viaHttp2(url, timeoutMs)]);
	attempts.push(["direct", () => viaDirect(url, timeoutMs)]);

	const failures = [];
	for (const [label, run] of attempts) {
		try {
			const raw = await run();
			if (!raw.includes("proxies:")) throw new Error(`not a subscription (${raw.length}B)`);
			logger?.info?.("clash-proxy: subscription downloaded via %s (%d bytes)", label, raw.length);
			return { raw, via: label };
		} catch (error) {
			failures.push(`${label}: ${error?.message ?? error}`);
			logger?.warn?.("clash-proxy: subscription attempt %s failed: %s", label, String(error?.message ?? error));
		}
	}
	throw new Error(`all subscription transports failed — ${failures.join("; ")}`);
}

export { sleep };
