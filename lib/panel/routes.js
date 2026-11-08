// HTTP surface of the panel: one `webServer` prefix route that speaks both the
// static page and the JSON API.
//
// Security model (defence in depth, weakest acceptable layer called out):
//  1. loopback Host header only — a remote page cannot reach this route at all;
//  2. per-process random token, injected into the served HTML and required on
//     every API call — a cross-site page cannot read the token (same-origin
//     policy) and cannot set the header without a preflight we never answer;
//  3. `Sec-Fetch-Site` / `Origin` checked when present — rejects cross-site
//     subresource requests even if a token ever leaked into a URL;
//  4. error messages are never echoed raw: only input-validation messages pass,
//     everything else is logged locally under a short reference id.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const PREFIX = "/clash-proxy-panel";
const TOKEN_PLACEHOLDER = "__CLASH_PROXY_TOKEN__";

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

/** Validation error whose text is safe to show to the panel user. */
export class PanelInputError extends Error {
	name = "PanelInputError";
}

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
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(body);
}

function sendText(res, status, text) {
	if (res.headersSent) return;
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(text);
}

function readBody(req, limit = 512 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		req.on("data", (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > limit) {
				// Answer with a 400 instead of killing the socket: destroying the
				// request here would make the client see ECONNRESET rather than
				// the validation error. Remaining bytes are drained and dropped.
				settled = true;
				reject(new PanelInputError("request body too large"));
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new PanelInputError("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

/** Strip anything URL-shaped before a message reaches a log file. */
function redact(text) {
	return String(text).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").replace(/[A-Za-z]:\\[^\s"']*/g, "<path>");
}

/** Compare the presented token without leaking its length/content via timing. */
function tokenMatches(presented, expected) {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Resolve a request pathname to a real file inside web/. Returns null when the
 * path escapes the root (including through a symlink) or is not a file.
 */
async function resolveStatic(relativePath) {
	let relative;
	try {
		relative = decodeURIComponent(relativePath);
	} catch {
		return null;
	}
	if (relative.includes("\0")) return null;
	const root = await fs.realpath(WEB_ROOT);
	const candidate = normalize(join(root, relative));
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
	let real;
	try {
		real = await fs.realpath(candidate);
	} catch {
		return null;
	}
	if (real !== root && !real.startsWith(`${root}${sep}`)) return null;
	try {
		const stat = await fs.stat(real);
		if (!stat.isFile()) return null;
	} catch {
		return null;
	}
	return real;
}

/** Serve one file from web/ (whitelisted, no traversal, no symlink escape). */
async function serveStatic(res, pathname, token) {
	const relative = pathname.slice(PREFIX.length).replace(/^\/+/, "") || "index.html";
	let target = await resolveStatic(relative);
	let fallback = false;
	if (target === null) {
		// Single-page app: unknown extensionless paths fall back to the shell.
		if (extname(relative).length > 0) {
			sendText(res, 404, "not found");
			return;
		}
		target = await resolveStatic("index.html");
		fallback = true;
		if (target === null) {
			sendText(res, 500, "panel shell missing");
			return;
		}
	}
	let body = await fs.readFile(target);
	const extension = extname(target);
	if (extension === ".html") {
		body = Buffer.from(body.toString("utf8").replaceAll(TOKEN_PLACEHOLDER, token), "utf8");
	}
	res.writeHead(200, {
		"content-type": MIME[extension] ?? "application/octet-stream",
		"content-length": body.length,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		// The panel is a same-origin iframe; disallow embedding elsewhere.
		"content-security-policy": "frame-ancestors 'self'",
		...(fallback ? { "x-panel-fallback": "index.html" } : {})
	});
	res.end(body);
}

/**
 * Reject cross-site requests that carry the token. Browser fetches from the
 * DSH page report `same-origin`; non-browser clients (tests, fetch providers)
 * send neither header and are allowed through the token check alone.
 */
function crossSite(req) {
	const site = req.headers["sec-fetch-site"];
	if (typeof site === "string" && site.length > 0) {
		if (site === "same-origin" || site === "none") return false;
		return true;
	}
	const origin = req.headers.origin;
	if (typeof origin === "string" && origin.length > 0) {
		const host = String(req.headers.host ?? "");
		try {
			return new URL(origin).host !== host;
		} catch {
			return true;
		}
	}
	return false;
}

/** Build the route handler. `controller` is the panel brain from controller.js. */
export function createPanelRoute(controller) {
	const token = randomBytes(32).toString("base64url");
	const api = {
		"GET state": async () => controller.state(),

		"POST toggle": async (body) => controller.setEnabled(body.enabled === true),

		"POST settings": async (body) => controller.patchSettings(body.patch ?? {}),

		"POST mode": async (body) => {
			const channel = String(body.channel ?? "");
			const mode = String(body.mode ?? "");
			if (!["web", "search"].includes(channel)) throw new PanelInputError('channel must be "web" or "search"');
			if (!["off", "on", "auto"].includes(mode)) throw new PanelInputError("mode must be off, on or auto");
			return controller.patchSettings({ modes: { [channel]: mode } });
		},

		"POST scope": async (body) => {
			const channel = String(body.channel ?? "");
			if (!["web", "search", "scripts", "browser"].includes(channel)) throw new PanelInputError("unknown scope channel");
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
		const method = (req.method ?? "GET").toUpperCase();
		let url;
		try {
			url = new URL(req.url ?? "/", "http://127.0.0.1");
		} catch {
			sendText(res, 400, "bad request");
			return;
		}
		const path = url.pathname.startsWith(PREFIX) ? url.pathname : PREFIX + url.pathname;
		if (!path.startsWith(`${PREFIX}/api/`)) {
			if (method !== "GET" && method !== "HEAD") {
				sendText(res, 405, "method not allowed");
				return;
			}
			await serveStatic(res, path, token);
			return;
		}
		if (method === "OPTIONS") {
			// No CORS: never answer a preflight, so cross-site JS cannot send the
			// custom header at all.
			sendText(res, 405, "preflight not allowed");
			return;
		}
		if (crossSite(req)) {
			sendJson(res, 403, { ok: false, error: "cross-site request rejected" });
			return;
		}
		if (!tokenMatches(req.headers["x-clash-proxy-token"], token)) {
			sendJson(res, 403, { ok: false, error: "missing or invalid panel token" });
			return;
		}
		const endpoint = path.slice(`${PREFIX}/api/`.length);
		const key = `${method} ${endpoint}`;
		if (!Object.hasOwn(api, key)) {
			sendJson(res, 404, { ok: false, error: `unknown endpoint ${key}` });
			return;
		}
		try {
			const body = key.startsWith("POST ") ? await readBody(req) : {};
			sendJson(res, 200, { ok: true, ...(await api[key](body)) });
		} catch (error) {
			if (error instanceof PanelInputError) {
				sendJson(res, 400, { ok: false, error: error.message });
				return;
			}
			const ref = randomBytes(4).toString("hex");
			// eslint-disable-next-line no-console
			console.error(`[clash-proxy-panel] api ${key} failed (ref ${ref}): ${redact(error instanceof Error ? error.message : error)}`);
			sendJson(res, 500, { ok: false, error: "internal error", ref });
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

export { PREFIX, WEB_ROOT, TOKEN_PLACEHOLDER };
