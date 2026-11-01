// Connectivity and throughput measurements for the panel.
//
// Three different questions, three different probes — keeping them apart is what
// makes the numbers explainable:
//   * `testLatency`   (manager)   — TCP handshake *through the node's protocol*, per node.
//   * `testConnectivity`          — can this machine reach the agent's test targets at all,
//                                   direct vs. through the proxy (HTTP status + TTFB).
//   * `measureBandwidth`          — how many bytes/second the tunnel actually moves.
import { request, ProxyAgent, Agent } from "undici";

/** Test targets, tried in order; the first that answers decides the verdict. */
const CONNECTIVITY_TARGETS = [
	"https://www.gstatic.com/generate_204",
	"https://api.ipify.org?format=json",
	"https://www.cloudflare.com/cdn-cgi/trace"
];

function dispatcherFor(proxyPort) {
	if (!(proxyPort > 0)) return new Agent({ connections: 4, pipelining: 1 });
	return new ProxyAgent({ uri: `http://127.0.0.1:${proxyPort}`, pipelining: 1 });
}

/**
 * One HTTP probe.
 * @returns `{ ok, status, ms, via, url, error }` — never throws.
 */
export async function probeHttp(url, options = {}) {
	const proxyPort = Number(options.proxyPort ?? 0);
	const timeoutMs = Number(options.timeoutMs ?? 6000);
	const dispatcher = dispatcherFor(proxyPort);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const started = Date.now();
	try {
		const response = await request(url, {
			method: "GET",
			dispatcher,
			signal: controller.signal,
			headers: { "accept-encoding": "identity" }
		});
		const ttfb = Date.now() - started;
		const body = await response.body.text().catch(() => "");
		return {
			ok: response.statusCode >= 200 && response.statusCode < 400,
			status: response.statusCode,
			ms: ttfb,
			via: proxyPort > 0 ? `127.0.0.1:${proxyPort}` : "direct",
			url,
			body: body.slice(0, 400),
			error: null
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			ms: Date.now() - started,
			via: proxyPort > 0 ? `127.0.0.1:${proxyPort}` : "direct",
			url,
			body: "",
			error: error instanceof Error ? error.message : String(error)
		};
	} finally {
		clearTimeout(timer);
		dispatcher.close?.().catch?.(() => {});
	}
}

/**
 * Direct vs. proxied connectivity, both against the same target list.
 * @returns `{ at, direct, proxy }` where each side is a probe result (or null).
 */
export async function testConnectivity(options = {}) {
	const proxyPort = Number(options.proxyPort ?? 0);
	const timeoutMs = Number(options.timeoutMs ?? 6000);
	const run = async (viaPort) => {
		for (const url of CONNECTIVITY_TARGETS) {
			const result = await probeHttp(url, { proxyPort: viaPort, timeoutMs });
			if (result.ok) return result;
			if (url === CONNECTIVITY_TARGETS.at(-1)) return result;
		}
		return null;
	};
	const direct = await run(0);
	const proxy = proxyPort > 0 ? await run(proxyPort) : null;
	return { at: Date.now(), direct, proxy };
}

/**
 * Payload targets for the throughput sample, tried in order until one delivers.
 *
 * `speed.cloudflare.com` is the usual choice, but plenty of share-line nodes cannot
 * reach it while they still tunnel fine, so the list has fallbacks and the sample is
 * a *window*, not a whole file: a truncated transfer still yields a usable rate.
 */
const BANDWIDTH_TARGETS = [
	"https://speed.cloudflare.com/__down?bytes=20971520",
	"https://proof.ovh.net/files/10Mb.dat",
	"https://ash-speed.hetzner.com/100MB.bin",
	"https://releases.ubuntu.com/22.04/ubuntu-22.04.5-desktop-amd64.iso"
];

/** Bytes below this are a handshake or an error page, not a measurement. */
const MIN_SAMPLE_BYTES = 128 * 1024;

/**
 * Download through the local proxy and time it.
 * @param options.urls - payload URLs tried in order (the caller's URL first).
 * @param options.proxyPort - local proxy port; the caller decides which node answers.
 * @param options.budgetMs - sampling window per URL (default 8000).
 * @returns `{ ok, bytes, ms, mbps, ttfbMs, status, url, attempts, error }`
 */
export async function measureBandwidth(options = {}) {
	const proxyPort = Number(options.proxyPort ?? 0);
	const budgetMs = Math.max(1000, Number(options.budgetMs ?? 8000));
	const urls = [...new Set([options.url, ...(options.urls ?? []), ...BANDWIDTH_TARGETS].map((url) => String(url ?? "").trim()).filter(Boolean))];
	const attempts = [];
	let best = null;
	for (const url of urls) {
		const attempt = await sampleBandwidth(url, { proxyPort, budgetMs });
		attempts.push(attempt);
		if (attempt.ok) return { ...attempt, attempts };
		if (best === null || attempt.bytes > best.bytes) best = attempt;
	}
	return {
		ok: false,
		status: best?.status ?? 0,
		bytes: best?.bytes ?? 0,
		ms: best?.ms ?? 0,
		ttfbMs: best?.ttfbMs ?? null,
		mbps: 0,
		url: best?.url ?? null,
		attempts,
		error: best?.error ?? "no payload target answered"
	};
}

/** One sampling window against one URL. Never throws. */
async function sampleBandwidth(url, { proxyPort, budgetMs }) {
	const dispatcher = dispatcherFor(proxyPort);
	const controller = new AbortController();
	const started = Date.now();
	let bytes = 0;
	let ttfbMs = null;
	let status = 0;
	let error = null;
	const timer = setTimeout(() => controller.abort(), budgetMs + 500);
	try {
		const response = await request(url, {
			method: "GET",
			dispatcher,
			signal: controller.signal,
			headers: { "accept-encoding": "identity" }
		});
		status = response.statusCode;
		if (status >= 400) throw new Error(`HTTP ${status}`);
		ttfbMs = Date.now() - started;
		try {
			for await (const chunk of response.body) {
				bytes += chunk.length;
				if (Date.now() - started >= budgetMs) {
					controller.abort();
					break;
				}
			}
		} catch (streamError) {
			// An aborted sample is a finished one: the bytes counted so far are the data.
			if (controller.signal.aborted === false) error = streamError instanceof Error ? streamError.message : String(streamError);
		}
	} catch (caught) {
		error = controller.signal.aborted ? null : caught instanceof Error ? caught.message : String(caught);
	} finally {
		clearTimeout(timer);
		dispatcher.close?.().catch?.(() => {});
	}
	const ms = Math.max(1, Date.now() - started);
	const windowMs = Math.max(1, ms - (ttfbMs ?? 0));
	return {
		ok: bytes >= MIN_SAMPLE_BYTES && (error === null || controller.signal.aborted),
		status,
		bytes,
		ms,
		windowMs,
		ttfbMs,
		mbps: (bytes * 8) / (windowMs / 1000) / 1_000_000,
		url,
		error
	};
}

export { CONNECTIVITY_TARGETS, BANDWIDTH_TARGETS };
