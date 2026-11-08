// In-process test runner: imports each *.test.mjs so `node:test` executes in this
// process (no child processes needed — that matters under restricted sandboxes
// and keeps CI logs in one stream).
import "./rules.test.mjs";
import "./transports.test.mjs";
import "./tunnel.test.mjs";
import "./proxy-server.test.mjs";
import "./panel.test.mjs";
