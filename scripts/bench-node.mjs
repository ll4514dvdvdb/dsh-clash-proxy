// One-off diagnostics: throughput over a node transport (the same path the local
// proxy uses), to tell a slow subscription from a slow relay.
//
//   node scripts/bench-node.mjs [host] [budgetMs] [nameFilter]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { connectThrough } from "../lib/core/transports.js";

const HOST = process.argv[2] ?? "ash-speed.hetzner.com";
const PATH = "/100MB.bin";
const BUDGET = Number(process.argv[3] ?? 8000);
const WANT = process.argv[4] ?? "US";

const docs = yaml.load(readFileSync(join(homedir(), ".dsh", "clash-proxy", "subscription.yaml"), "utf8"));
const proxies = (docs.proxies ?? []).filter((node) => String(node.name).includes(WANT));
if (proxies.length === 0) throw new Error(`no node matching ${WANT}`);
const node = proxies[0];
console.log(`node: ${node.name} type=${node.type}`);

const started = Date.now();
const face = await connectThrough(node, HOST, 443);
const opened = Date.now();
face.write(`GET ${PATH} HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: bench\r\nAccept: */*\r\nConnection: close\r\n\r\n`);

let bytes = 0;
let headersDone = false;
const deadline = opened + BUDGET;
for await (const chunk of face.read) {
	if (!headersDone) {
		const at = chunk.indexOf("\r\n\r\n");
		if (at === -1) continue;
		headersDone = true;
		bytes += chunk.length - (at + 4);
	} else {
		bytes += chunk.length;
	}
	if (Date.now() >= deadline) break;
}
const elapsed = Math.max(1, Date.now() - opened);
console.log(`handshake ${opened - started}ms, ${(bytes / 1024).toFixed(0)} KiB in ${(elapsed / 1000).toFixed(2)}s = ${((bytes * 8) / elapsed / 1000).toFixed(2)} Mbps`);
face.close();
process.exit(0);
