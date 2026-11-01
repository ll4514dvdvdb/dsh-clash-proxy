// Panel client: talks to the same-origin JSON API under /clash-proxy-panel/api/.
//
// Deliberately dependency-free and small: the page must work inside the GUI's
// iframe where only the plugin's own route is reachable.
(() => {
	const API = "/clash-proxy-panel/api/";
	const $ = (selector) => document.querySelector(selector);
	const $$ = (selector) => [...document.querySelectorAll(selector)];

	let state = null;
	let toastTimer = 0;

	function toast(message, bad = false) {
		const node = $("#toast");
		node.textContent = message;
		node.classList.toggle("bad", bad);
		node.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
	}

	async function api(path, body) {
		const response = await fetch(API + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { "x-clash-proxy": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			cache: "no-store"
		});
		const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
		if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`);
		return payload;
	}

	function applyState(next) {
		if (next === undefined || next === null) return;
		state = next;
		render();
	}

	function bytes(value) {
		if (value === null || value === undefined) return "—";
		if (value > 1e6) return `${(value / 1e6).toFixed(1)} MB`;
		if (value > 1e3) return `${(value / 1e3).toFixed(1)} KB`;
		return `${value} B`;
	}

	function rate(value) {
		if (!(value > 0)) return "0 B/s";
		if (value > 1e6) return `${(value / 1e6).toFixed(2)} MB/s`;
		if (value > 1e3) return `${(value / 1e3).toFixed(1)} KB/s`;
		return `${Math.round(value)} B/s`;
	}

	function render() {
		if (state === null) return;
		const engine = state.engine ?? {};
		const running = engine.state === "running" && engine.port > 0;

		// master switch
		const toggle = $("#master-switch");
		toggle.setAttribute("aria-pressed", state.enabled ? "true" : "false");
		$("#master-label").textContent = state.enabled ? "代理已开启" : "代理已关闭";

		const pill = $("#state-pill");
		pill.className = `pill ${running ? "ok" : state.enabled ? "bad" : ""}`;
		pill.textContent = state.enabled ? (running ? `运行中 · :${engine.port}` : "已开启但未运行") : "已关闭";

		$("#engine-line").textContent = engine.error
			? `引擎错误：${engine.error}`
			: `节点 ${engine.nodeCount ?? 0} 个 · 当前 ${state.nodes?.current ?? "—"} · 版本 ${state.version}`;

		// channels
		for (const [channel, mode] of Object.entries(state.modes ?? {})) {
			const select = $(`[data-mode="${channel}"]`);
			if (select) select.value = mode;
		}
		for (const [channel, value] of Object.entries(state.scopes ?? {})) {
			const box = $(`[data-scope="${channel}"]`);
			if (box) box.checked = value === true;
		}

		$("#busy-hint").textContent = state.busy?.bandwidth ? "带宽测试进行中…" : state.busy?.connectivity ? "连通性测试中…" : "";

		// engine facts
		const facts = [
			["引擎", engine.state ?? "—"],
			["本地端口", engine.port || "—"],
			["节点数", engine.nodeCount ?? 0],
			["当前节点", state.nodes?.current ?? "—"],
			["订阅更新", engine.lastSubscriptionUpdate ? new Date(engine.lastSubscriptionUpdate).toLocaleString() : "—"],
			["流量", `${rate(lastTraffic?.upRate ?? 0)} ↑ / ${rate(lastTraffic?.downRate ?? 0)} ↓`]
		];
		$("#engine-facts").innerHTML = facts.map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(String(value))}</dd>`).join("");

		// env
		const env = state.env ?? { powershell: [] };
		$("#env-text").textContent =
			(env.powershell ?? []).length > 0
				? ["# PowerShell", ...env.powershell, "", "# cmd", ...(env.cmd ?? []), "", "# bash", ...(env.bash ?? [])].join("\n")
				: "代理未启动 — 没有可用的代理端口";

		renderNodes();
		renderDecisions();
		renderSpoof();
	}

	let lastTraffic = null;

	function renderNodes() {
		const nodes = state?.nodes?.nodes ?? [];
		const body = $("#node-rows");
		if (nodes.length === 0) {
			body.innerHTML = `<tr><td colspan="5" class="muted">没有节点 — 先刷新订阅</td></tr>`;
			return;
		}
		body.innerHTML = nodes
			.map((node) => {
				const delay = node.delay === null || node.delay === undefined ? "—" : `${node.delay} ms`;
				const mbps = node.mbps === null || node.mbps === undefined ? "—" : `${node.mbps.toFixed(2)} Mbps`;
				return `<tr class="${node.current ? "current" : ""}">
					<td>${escapeHtml(node.name)}</td>
					<td><span class="tag">${escapeHtml(node.type ?? "")}</span></td>
					<td>${delay}</td>
					<td>${mbps}</td>
					<td>
						<button class="link" data-node-select="${escapeAttr(node.name)}">${node.selected ? "已选" : "选用"}</button>
						<button class="link" data-node-latency="${escapeAttr(node.name)}">延迟</button>
						<button class="link" data-node-bandwidth="${escapeAttr(node.name)}">带宽</button>
					</td>
				</tr>`;
			})
			.join("");
	}

	function renderDecisions() {
		const rows = state?.decisions ?? [];
		$("#decision-rows").innerHTML =
			rows.length === 0
				? `<tr><td colspan="5" class="muted">暂无</td></tr>`
				: rows
						.map(
							(entry) => `<tr>
						<td>${new Date(entry.at).toLocaleTimeString()}</td>
						<td class="host">${escapeHtml(entry.host)}</td>
						<td><span class="tag ${entry.action}">${escapeHtml(entry.action)}</span></td>
						<td>${escapeHtml(entry.reason ?? "")}</td>
						<td>${escapeHtml(entry.mode ?? "")}</td>
					</tr>`
						)
						.join("");
	}

	function renderSpoof() {
		const spoof = state?.spoof ?? {};
		$("#spoof-enabled").checked = spoof.enabled === true;
		const select = $("#spoof-ua");
		const presets = state?.uaPresets ?? [];
		if (select.options.length !== presets.length) {
			select.innerHTML = presets.map((name) => `<option value="${name}">${name}</option>`).join("");
		}
		select.value = spoof.uaPreset ?? presets[0] ?? "";
		$("#spoof-ua-custom").value = spoof.userAgent ?? "";
		$("#spoof-lang").value = spoof.acceptLanguage ?? "";
		$("#spoof-tz").value = spoof.timezone ?? "";
		$("#spoof-locale").value = spoof.locale ?? "";
		$("#spoof-webrtc").value = spoof.webrtc === "disabled" ? "disabled" : spoof.webrtc === "strip" ? "strip" : "off";
		$("#spoof-hints").checked = spoof.clientHints !== false;
		$("#spoof-webdriver").checked = spoof.hideWebdriver !== false;
		const browser = state?.browser ?? {};
		$("#browser-result").textContent = browser.running
			? [
					`浏览器运行中（${browser.channel ?? "?"}）`,
					browser.url ? `页面：${browser.url}` : null,
					browser.ip ? `出口 IP：${browser.ip}` : null,
					browser.timezone ? `页面时区：${browser.timezone}` : null,
					browser.language ? `语言：${browser.language}` : null,
					browser.webdriver === false ? "navigator.webdriver = false" : browser.webdriver === true ? "navigator.webdriver = true（伪装未生效）" : null
				]
					.filter(Boolean)
					.join("\n")
			: browser.error
				? `启动失败：${browser.error}`
				: "浏览器未启动";
	}

	function escapeHtml(value) {
		return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
	}

	function escapeAttr(value) {
		return escapeHtml(value);
	}

	async function guard(work) {
		try {
			await work();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), true);
		}
	}

	// ---- events ------------------------------------------------------------
	$("#master-switch").addEventListener("click", () =>
		guard(async () => {
			const payload = await api("toggle", { enabled: !(state?.enabled === true) });
			applyState(payload.state);
			toast(payload.state?.enabled ? "代理已开启" : "代理已关闭");
		})
	);

	document.addEventListener("change", (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const modeChannel = target.getAttribute("data-mode");
		if (modeChannel) {
			guard(async () => applyState((await api("mode", { channel: modeChannel, mode: target.value })).state));
			return;
		}
		const scopeChannel = target.getAttribute("data-scope");
		if (scopeChannel) {
			guard(async () => applyState((await api("scope", { channel: scopeChannel, value: target.checked })).state));
		}
	});

	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target.closest("button") : null;
		if (target === null) return;
		const select = target.getAttribute("data-node-select");
		if (select !== null) {
			guard(async () => {
				applyState((await api("node", { name: select })).state);
				toast(`已选节点：${select}`);
			});
			return;
		}
		const latency = target.getAttribute("data-node-latency");
		if (latency !== null) {
			guard(async () => {
				target.disabled = true;
				try {
					const payload = await api("test/latency", { name: latency });
					const value = payload.result?.results?.[latency];
					$("#test-result").textContent = `${latency}: ${value === null || value === undefined ? "不可用" : `${value} ms`}`;
					applyState(payload.state);
				} finally {
					target.disabled = false;
				}
			});
			return;
		}
		const bandwidth = target.getAttribute("data-node-bandwidth");
		if (bandwidth !== null) {
			guard(async () => {
				target.disabled = true;
				$("#test-result").textContent = `正在通过 ${bandwidth} 下载测试数据…`;
				try {
					const payload = await api("test/bandwidth", { name: bandwidth });
					const result = payload.result ?? {};
					$("#test-result").textContent = result.ok
						? `${bandwidth}\n${result.mbps.toFixed(2)} Mbps · ${(result.bytes / 1e6).toFixed(1)} MB / ${(result.ms / 1000).toFixed(1)}s · ttfb ${result.ttfbMs}ms`
						: `${bandwidth} 测试失败：${result.error ?? result.status}`;
					applyState(payload.state);
				} finally {
					target.disabled = false;
				}
			});
			return;
		}
		const act = target.getAttribute("data-act");
		if (act === null) return;
		if (act === "connectivity") {
			guard(async () => {
				target.disabled = true;
				$("#test-result").textContent = "正在探测直连与代理…";
				try {
					const payload = await api("test/connectivity", {});
					const result = payload.result ?? {};
					const line = (label, probe) =>
						probe === null
							? `${label}: 未启用`
							: probe.ok
								? `${label}: HTTP ${probe.status} · ${probe.ms} ms · ${probe.via}`
								: `${label}: 失败（${probe.error ?? probe.status}）`;
					$("#test-result").textContent = [line("直连", result.direct), line("代理", result.proxy)].join("\n");
					applyState(payload.state);
				} finally {
					target.disabled = false;
				}
			});
			return;
		}
		if (act === "latency-all") {
			guard(async () => {
				target.disabled = true;
				$("#test-result").textContent = "正在测试全部节点延迟…";
				try {
					const payload = await api("test/latency", { name: "all" });
					const results = payload.result?.results ?? {};
					$("#test-result").textContent = Object.entries(results)
						.map(([name, value]) => `${value === null ? "✗" : "✓"} ${name}: ${value === null ? "不可用" : `${value} ms`}`)
						.join("\n");
					applyState(payload.state);
				} finally {
					target.disabled = false;
				}
			});
			return;
		}
		if (act === "bandwidth") {
			guard(async () => {
				target.disabled = true;
				$("#test-result").textContent = "正在测当前节点的下行带宽…";
				try {
					const payload = await api("test/bandwidth", { name: null });
					const result = payload.result ?? {};
					$("#test-result").textContent = result.ok
						? `下行 ${result.mbps.toFixed(2)} Mbps · ${(result.bytes / 1e6).toFixed(1)} MB / ${(result.ms / 1000).toFixed(1)}s · ttfb ${result.ttfbMs}ms`
						: `测试失败：${result.error ?? result.status}`;
					applyState(payload.state);
				} finally {
					target.disabled = false;
				}
			});
			return;
		}
		if (act === "refresh") {
			guard(async () => {
				target.disabled = true;
				$("#test-result").textContent = "正在下载订阅…";
				try {
					const payload = await api("subscription/refresh", { url: $("#sub-url").value.trim() || undefined });
					$("#test-result").textContent = `订阅已更新（${payload.result.bytes} 字节，via ${payload.result.via}）`;
					applyState(payload.state);
				} finally {
					target.disabled = false;
				}
			});
			return;
		}
		if (act === "save-spoof") {
			guard(async () => {
				const patch = {
					spoof: {
						enabled: $("#spoof-enabled").checked,
						uaPreset: $("#spoof-ua").value,
						userAgent: $("#spoof-ua-custom").value.trim(),
						acceptLanguage: $("#spoof-lang").value.trim() || "en-US,en;q=0.9",
						timezone: $("#spoof-tz").value.trim() || "America/New_York",
						locale: $("#spoof-locale").value.trim() || "en-US",
						webrtc: $("#spoof-webrtc").value,
						dns: $("#spoof-dns").value,
						clientHints: $("#spoof-hints").checked,
						hideWebdriver: $("#spoof-webdriver").checked
					}
				};
				applyState((await api("settings", { patch })).state);
				toast("伪装设置已保存");
			});
			return;
		}
		if (act === "browser-open") {
			guard(async () => {
				target.disabled = true;
				$("#browser-result").textContent = "正在启动浏览器…";
				try {
					const payload = await api("browser", { action: "open", url: "https://ipinfo.io/json" });
					applyState(payload.state);
					toast("浏览器已启动");
				} finally {
					target.disabled = false;
				}
			});
			return;
		}
		if (act === "browser-close") {
			guard(async () => {
				const payload = await api("browser", { action: "close" });
				applyState(payload.state);
				toast("浏览器已关闭");
			});
			return;
		}
		if (act === "clear-decisions") {
			guard(async () => {
				applyState((await api("decisions/clear", {})).state);
				toast("决策日志已清空");
			});
		}
	});

	// ---- live refresh ------------------------------------------------------
	async function refreshTraffic() {
		if (document.hidden) return;
		try {
			lastTraffic = await api("traffic");
			const facts = $("#engine-facts");
			if (state !== null && facts.children.length > 0) {
				// only the traffic row needs the frequent update
				const values = facts.querySelectorAll("dd");
				const last = values[values.length - 1];
				if (last) last.textContent = `${rate(lastTraffic.upRate)} ↑ / ${rate(lastTraffic.downRate)} ↓`;
			}
		} catch {
			// traffic is a nicety; a failed poll must not spam the page
		}
	}

	async function refreshState() {
		if (document.hidden) return;
		try {
			applyState(await api("state"));
		} catch (error) {
			$("#engine-line").textContent = `无法连接面板接口：${error instanceof Error ? error.message : error}`;
		}
	}

	refreshState();
	refreshTraffic();
	setInterval(refreshTraffic, 2500);
	setInterval(refreshState, 10000);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) refreshState();
	});
})();
