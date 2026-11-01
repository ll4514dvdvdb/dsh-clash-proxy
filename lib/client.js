// Client bundle: a sidebar entry and the main page it opens.
//
// The page itself is a same-origin iframe (`/clash-proxy-panel/`, served by this
// plugin's `webServer` route). That keeps the panel a normal HTML/JS app — no React
// toolkit to match, no second port, no CORS, no token in a URL — while the sidebar
// entry and the panel slot are still registered the way the GUI expects.
//
// Loaded through `window.__ModuleLoader__.load({...})`, the same envelope every
// client bundle uses; `react` is a platform seed, so `require` works here.
window.__ModuleLoader__.load({
	id: "dsh-clash-proxy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		const NS = "clash-proxy";
		const PANEL_ID = "clash-proxy";
		const PANEL_PATH = "/clash-proxy-panel/";

		const messages = {
			zh: { title: "代理面板", page: "代理" },
			en: { title: "Proxy panel", page: "Proxy" }
		};

		/** Sidebar entry: a small globe crossed by a route. */
		function ProxyIcon({ size }) {
			const dimension = typeof size === "number" ? size : 18;
			return h(
				"svg",
				{
					width: dimension,
					height: dimension,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.7,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("circle", { cx: 12, cy: 12, r: 9 }),
				h("path", { d: "M3 12h18" }),
				h("path", { d: "M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z" }),
				h("circle", { cx: 12, cy: 12, r: 1.4, fill: "currentColor", stroke: "none" })
			);
		}

		/** The main page: the panel's own document, embedded. */
		function ProxyPanelPage() {
			return h("div", { style: { width: "100%", height: "100%", minHeight: 0, display: "flex" } },
				h("iframe", {
					src: PANEL_PATH,
					title: "clash-proxy panel",
					style: { flex: "1 1 auto", width: "100%", height: "100%", border: 0, background: "transparent" }
				})
			);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.locale.register(NS, messages);
			const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : (key) => messages.zh[key] ?? key;

			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, inject: () => ({}) }, ProxyPanelPage)
			);
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 30, locale: NS, label: () => t("title") }, ProxyIcon)
			);
			// Same seat the GUI uses for 对话 / 轨迹 / 上下文 / 编队: the page also gets its own
			// tab in that row (order 40 puts it after 编队, before the overflow menu).
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register({ name: "conversation.view", id: PANEL_ID, order: 40, locale: NS, label: () => t("page") }, ProxyPanelPage)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
