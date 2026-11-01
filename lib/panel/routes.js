// HTTP surface of the panel: one `webServer` prefix route that speaks both the
// static page and the JSON API.
//
// Same-origin with the DSH GUI means the iframe needs no CORS, no second port and
// no token in the URL. The guard is the loopback rule plus a custom header on the
// API: a cross-site page cannot send `x-clash-proxy` without a preflight this route
// never answers.
import { promises as fs } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const PREFIX = "/clash-proxy-panel";

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
	".woff2": "font/woff2",
	".ico": "image/x-icon"
};

/** Loopback-only: the page is served by the harness on 127.0.0.1. */
function isLoopbackRequest(req) {
	const host = String(req.headers.host ?? "").toLowerCase();
	const name = host.replace(/:\d+$/, "");
	return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

function sendJson(res, status, payload) {
	if (res.headersSent) return;
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}

function sendText(res, status, text) {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	res.end(text);
}

function readBody(req, limit = 512 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve({});
			}
		});
		req.on("error", reject);
	});
}

/** Serve one file from web/ (whitelisted, no traversal). */
async function serveStatic(res, pathname) {
	const relative = pathname.replace(PREFIX, "").replace(/^\/+/, "") || "index.html";
	const target = normalize(join(WEB_ROOT, relative));
	if (!target.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : `${WEB_ROOT}${sep}`) && target !== join(WEB_ROOT, "index.html")) {
		sendText(res, 403, "forbidden");
		return;
	}
	let body;
	try {
		body = await fs.readFile(target);
	} catch {
		// Single-page app: unknown paths fall back to the shell.
		if (extname(relative).length > 0) {
			sendText(res, 404, "not found");
			return;
		}
		body = await fs.readFile(join(WEB_ROOT, "index.html"));
	}
	res.writeHead(200, {
		"content-type": MIME[extname(target)] ?? "application/octet-stream",
		"content-length": body.length,
		"cache-control": "no-store"
	});
	res.end(body);
}

/** Build the route handler. `controller` is the panel brain from controller.js. */
export function createPanelRoute(controller) {
	const api = {
		"GET state": async () => controller.state(),

		"POST toggle": async (body) => controller.setEnabled(body.enabled === true),

		"POST settings": async (body) => controller.patchSettings(body.patch ?? {}),

		"POST mode": async (body) => {
			const channel = String(body.channel ?? "");
			const mode = String(body.mode ?? "");
			if (!["web", "search"].includes(channel)) throw new Error('channel must be "web" or "search"');
			if (!["off", "on", "auto"].includes(mode)) throw new Error('mode must be off, on or auto');
			return controller.patchSettings({ modes: { [channel]: mode } });
		},

		"POST scope": async (body) => {
			const channel = String(body.channel ?? "");
			if (!["web", "search", "scripts", "browser"].includes(channel)) throw new Error("unknown scope channel");
			return controller.patchSettings({ scopes: { [channel]: body.value === true } });
		},

		"POST node": async (body) => controller.selectNode(String(body.name ?? "")),

		"POST test/connectivity": async () => ({ result: await controller.testConnectivity(), state: controller.state() }),

		"POST test/latency": async (body) => ({ result: await controller.testLatency(body.name), state: controller.state() }),

		"POST test/bandwidth": async (body) => ({ result: await controller.testBandwidth(body.name ?? null), state: controller.state() }),

		"POST subscription/refresh": async (body) => ({ result: await controller.refreshSubscription(body.url), state: controller.state() }),

		"POST browser": async (body) => ({ result: await controller.browserAction(String(body.action ?? "status"), body), state: controller.state() }),

		"POST decisions/clear": async () => {
			controller.clearDecisions();
			return { state: controller.state() };
		},

		"GET traffic": async () => controller.manager.traffic()
	};

	async function handle(req, res) {
		if (!isLoopbackRequest(req)) {
			sendText(res, 403, "the proxy panel only answers on the loopback interface");
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname.startsWith(PREFIX) ? url.pathname : PREFIX + url.pathname;
		if (!path.startsWith(`${PREFIX}/api/`)) {
			await serveStatic(res, path);
			return;
		}
		if (req.headers["x-clash-proxy"] === undefined) {
			sendJson(res, 403, { error: "missing x-clash-proxy header" });
			return;
		}
		const endpoint = path.slice(`${PREFIX}/api/`.length);
		const key = `${(req.method ?? "GET").toUpperCase()} ${endpoint}`;
		const handler = api[key];
		if (handler === undefined) {
			sendJson(res, 404, { error: `unknown endpoint ${key}` });
			return;
		}
		try {
			const body = key.startsWith("POST ") ? await readBody(req) : {};
			sendJson(res, 200, { ok: true, ...(await handler(body)) });
		} catch (error) {
			sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	return {
		kind: "prefix",
		// The host matches a prefix table entry by `pathname === path` or
		// `pathname.startsWith(path + "/")`, so the trailing slash must not be part of it.
		path: PREFIX,
		handler: handle
	};
}

export { PREFIX, WEB_ROOT };
