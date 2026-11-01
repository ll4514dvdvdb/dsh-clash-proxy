// Route *other* plugins' HTTP traffic through the local rule proxy.
//
// The web_fetch tool reaches the network through `ctx.web`'s fetch provider, which
// this plugin owns — but a good part of the ecosystem talks to `node:https`
// directly (dsh-free-search's engines, updaters, MCP bridges). Those callers have
// no seam, so the only honest lever is the module itself.
//
// `installNodeTunnel` wraps `http.request` / `https.request` and, per request,
// either leaves the call untouched or swaps in an agent that opens a CONNECT
// tunnel to 127.0.0.1:<proxyPort>. The rule engine then makes the real decision
// (Chinese destinations still go direct inside the proxy), so this stays a
// transport substitution and never a global redirect: loopback, the decision's
// own control plane, and every `direct` verdict are left alone.
//
// Synchronous by necessity — `request()` must return a ClientRequest immediately,
// so the decision comes from the (synchronous) cache/rules view, never a probe.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

/** Open a CONNECT tunnel to the local proxy and hand back the raw socket. */
function connectTunnel(proxyPort, host, port, callback) {
	const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
	let buffer = Buffer.alloc(0);
	let settled = false;
	const finish = (error, result) => {
		if (settled) return;
		settled = true;
		socket.off("data", onData);
		socket.off("error", onError);
		socket.setTimeout(0);
		if (error) {
			socket.destroy();
			callback(error);
			return;
		}
		callback(null, result);
	};
	const onData = (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		const end = buffer.indexOf("\r\n\r\n");
		if (end === -1) return;
		const statusLine = buffer.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
		const code = Number(/^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine)?.[1] ?? 0);
		if (code !== 200) {
			finish(new Error(`clash-proxy tunnel refused ${host}:${port} (${statusLine || "no response"})`));
			return;
		}
		const rest = buffer.subarray(end + 4);
		if (rest.length > 0) socket.unshift(rest);
		finish(null, socket);
	};
	const onError = (error) => finish(error);
	socket.setTimeout(20000, () => finish(new Error(`clash-proxy tunnel timeout for ${host}:${port}`)));
	socket.on("data", onData);
	socket.once("error", onError);
	socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
}

/** Plain-HTTP agent: the tunnel is transparent, node writes the request into it. */
class HttpTunnelAgent extends http.Agent {
	constructor(proxyPort) {
		super({ keepAlive: false });
		this.proxyPort = proxyPort;
	}

	createConnection(options, callback) {
		connectTunnel(this.proxyPort, options.host, Number(options.port) || 80, callback);
	}
}

/** HTTPS agent: tunnel first, then run TLS over the tunnel socket. */
class HttpsTunnelAgent extends https.Agent {
	constructor(proxyPort) {
		super({ keepAlive: false });
		this.proxyPort = proxyPort;
	}

	createConnection(options, callback) {
		connectTunnel(this.proxyPort, options.host, Number(options.port) || 443, (error, raw) => {
			if (error) {
				callback(error);
				return;
			}
			const socket = tls.connect({
				socket: raw,
				servername: options.servername ?? options.host,
				rejectUnauthorized: options.rejectUnauthorized !== false,
				ALPNProtocols: options.ALPNProtocols
			});
			let done = false;
			socket.once("secureConnect", () => {
				if (done) return;
				done = true;
				callback(null, socket);
			});
			socket.once("error", (tlsError) => {
				if (done) return;
				done = true;
				callback(tlsError);
			});
		});
	}
}

/** First argument of `request()` can be a string, a URL, or an options object. */
function normalize(options) {
	if (typeof options === "string") {
		try {
			const url = new URL(options);
			return {
				options: {
					protocol: url.protocol,
					hostname: url.hostname,
					port: url.port,
					path: `${url.pathname}${url.search}`,
					auth: url.username.length > 0 ? `${url.username}:${url.password}` : undefined
				},
				fromUrl: true
			};
		} catch {
			return { options: null, fromUrl: false };
		}
	}
	if (options instanceof URL) return { options: null, fromUrl: false };
	return { options: options ?? {}, fromUrl: false };
}

/**
 * Install the wrappers.
 * @param decide - `(host) => boolean`: true means "send this host through the proxy".
 * @returns dispose()
 */
export function installNodeTunnel(decide) {
	const originalHttp = http.request;
	const originalHttps = https.request;
	let httpAgent = null;
	let httpsAgent = null;
	let httpAgentPort = 0;
	let httpsAgentPort = 0;

	const patch = (mod, original, secure) => {
		const wrapped = function request(options, ...rest) {
			const { options: parsed, fromUrl } = normalize(options);
			const host = String(parsed?.hostname ?? parsed?.host ?? "").replace(/:\d+$/, "");
			if (parsed !== null && host.length > 0) {
				let decision;
				try {
					decision = decide(host);
				} catch {
					decision = null;
				}
				if (decision !== null && typeof decision === "object" && decision.useProxy) {
					const proxyPort = Number(decision.port ?? 0);
					if (proxyPort > 0) {
						const next = fromUrl ? { ...parsed } : { ...options };
						if (secure) {
							if (httpsAgent === null || httpsAgentPort !== proxyPort) {
								httpsAgent?.destroy?.();
								httpsAgent = new HttpsTunnelAgent(proxyPort);
								httpsAgentPort = proxyPort;
							}
							next.agent = httpsAgent;
						} else {
							if (httpAgent === null || httpAgentPort !== proxyPort) {
								httpAgent?.destroy?.();
								httpAgent = new HttpTunnelAgent(proxyPort);
								httpAgentPort = proxyPort;
							}
							next.agent = httpAgent;
						}
						return original.call(mod, next, ...rest);
					}
				}
			}
			return original.call(mod, options, ...rest);
		};
		return wrapped;
	};

	http.request = patch(http, originalHttp, false);
	https.request = patch(https, originalHttps, true);

	return () => {
		http.request = originalHttp;
		https.request = originalHttps;
		httpAgent?.destroy?.();
		httpsAgent?.destroy?.();
		httpAgent = null;
		httpsAgent = null;
	};
}

/** Environment lines for shells that start *outside* this process (scripts, apps). */
export function proxyEnvLines(port, { shell = "powershell" } = {}) {
	if (!(port > 0)) return [];
	const url = `http://127.0.0.1:${port}`;
	const noProxy = "127.0.0.1,localhost,::1";
	if (shell === "cmd") {
		return [`set HTTP_PROXY=${url}`, `set HTTPS_PROXY=${url}`, `set ALL_PROXY=${url}`, `set NO_PROXY=${noProxy}`];
	}
	if (shell === "bash") {
		return [`export http_proxy=${url}`, `export https_proxy=${url}`, `export all_proxy=${url}`, `export no_proxy=${noProxy}`];
	}
	return [
		`$env:HTTP_PROXY = "${url}"`,
		`$env:HTTPS_PROXY = "${url}"`,
		`$env:ALL_PROXY = "${url}"`,
		`$env:NO_PROXY = "${noProxy}"`
	];
}
