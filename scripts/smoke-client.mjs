// Checks the client bundle the way the GUI loads it: a `__ModuleLoader__` envelope
// whose factory only sees `require("react")` plus the platform seeds.
//
// Run: node scripts/smoke-client.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	Fragment: "Fragment"
};

let loaded = null;
const sandbox = {
	window: {
		__ModuleLoader__: {
			load(definition) {
				loaded = definition;
			}
		}
	},
	console
};

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push([true, name]);
	} catch (error) {
		results.push([false, `${name}: ${error instanceof Error ? error.message : error}`]);
	}
}

await check("registers one definition with a factory", () => {
	assert.ok(loaded, "no __ModuleLoader__.load call");
	assert.equal(loaded.id, "dsh-clash-proxy");
	assert.equal(typeof loaded.factory, "function");
});

const module = loaded.factory((spec) => {
	if (spec === "react") return fakeReact;
	throw new Error(`unexpected require("${spec}") — only platform seeds are allowed`);
});

await check("exports apply + inject", () => {
	assert.equal(typeof module.apply, "function");
	assert.deepEqual([...module.inject], ["slots", "locale"]);
});

const registered = [];
const ctx = {
	locale: {
		register: (ns, messages) => registered.push(["locale", ns, Object.keys(messages)]),
		bind: (ns) => (key) => `${ns}:${key}`
	},
	slots: {
		inject: (seat, work) => {
			registered.push(["inject", seat]);
			return work();
		},
		register: (definition, component) => {
			registered.push(["register", definition.name, definition.id ?? definition.key, typeof component]);
			return () => {};
		}
	}
};

await check("apply registers locale + both seats", async () => {
	await module.apply(ctx);
	const names = registered.map((entry) => entry.slice(0, 3).map(String).join("/"));
	assert.ok(names.some((name) => name.startsWith("locale/clash-proxy")), "locale not registered");
	assert.ok(names.includes("inject/main"), "main seat not injected");
	assert.ok(
		registered.some((entry) => entry[0] === "register" && entry[1] === "main" && entry[2] === "clash-proxy" && entry[3] === "function"),
		`main page not registered: ${names}`
	);
	assert.ok(names.includes("inject/sidebar.panellist"), "sidebar seat not injected");
	assert.ok(
		registered.some((entry) => entry[0] === "register" && entry[1] === "sidebar.panellist" && entry[2] === "clash-proxy"),
		"sidebar entry not registered"
	);
	assert.ok(names.includes("inject/conversation.view"), "conversation view seat not injected");
	assert.ok(
		registered.some((entry) => entry[0] === "register" && entry[1] === "conversation.view" && entry[2] === "clash-proxy"),
		"conversation view tab not registered"
	);
});

await check("page is an iframe onto the panel route", () => {
	const page = registered.find((entry) => entry[0] === "register" && entry[1] === "main");
	assert.equal(page[3], "function");
});

let failures = 0;
for (const [ok, name] of results) {
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures > 0) process.exitCode = 1;
