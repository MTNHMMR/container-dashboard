import test from "node:test";
import assert from "node:assert/strict";
import { rowHtml, healthDot } from "../public/rows.js";

test("rowHtml escapes a hostile name and drops a javascript: endpoint", () => {
  const html = rowHtml({
    name: "<img src=x onerror=alert(1)>",
    image: "x",
    state: "running",
    health: null,
    restartCount: 0,
    uptimeSecs: 1,
    cpuPct: null,
    memUsedBytes: null,
    endpoints: ["javascript:alert(1)", "http://homelab:8080"],
  });

  assert.ok(!html.includes("<img"), "raw <img must not survive into the markup");
  assert.ok(!/href="javascript:/.test(html), "javascript: must never appear as an href");
  assert.ok(!/href='javascript:/.test(html), "javascript: must never appear as an href");
  assert.ok(html.includes('href="http://homelab:8080"'), "the safe http endpoint should be linked");
});

test("rowHtml renders a benign container normally", () => {
  const html = rowHtml({
    name: "web",
    image: "nginx:1.27",
    state: "running",
    health: "healthy",
    restartCount: 2,
    uptimeSecs: 3600,
    cpuPct: 1.5,
    memUsedBytes: null,
    endpoints: ["http://homelab:8080"],
  });

  assert.ok(html.startsWith("<tr>"));
  assert.ok(html.includes("<td>web</td>"));
  assert.ok(html.includes("nginx:1.27"));
  assert.ok(html.includes("<td>2</td>"), "restartCount renders through esc() as a plain number");
  assert.ok(html.includes('href="http://homelab:8080"'));
});

test("healthDot reflects state and health without leaking markup", () => {
  assert.ok(healthDot("healthy", "running").includes("healthy"));
  assert.equal(healthDot(null, "<b>exited</b>").includes("<b>exited</b>"), false);
});
