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

test("a running container with no healthcheck reads 'no check' on a neutral dot, not green", () => {
  const h = healthDot(null, "running");
  assert.ok(h.includes("no check"));
  assert.ok(h.includes("dot-idle"));
  assert.ok(!h.includes("dot-ok"));
});

test("endpoints render as compact :port chips that still link to the full url", () => {
  const html = rowHtml({
    name: "adg",
    image: "x",
    state: "running",
    health: "healthy",
    restartCount: 0,
    uptimeSecs: 1,
    cpuPct: null,
    memUsedBytes: null,
    endpoints: ["http://192.168.1.235:53", "http://192.168.1.235:3000"],
  });
  assert.ok(html.includes('class="chip"'));
  assert.ok(html.includes(">:53</a>"));
  assert.ok(html.includes(">:3000</a>"));
  assert.ok(html.includes('href="http://192.168.1.235:53"'));
  assert.ok(!html.includes(">192.168.1.235:53<"), "the host should not be repeated in the visible chip text");
});

test("an unhealthy running container gets row-bad; high lifetime restarts get row-warn", () => {
  const base = {
    name: "x", image: "x", state: "running", health: "healthy",
    restartCount: 0, uptimeSecs: 1, cpuPct: null, memUsedBytes: null, endpoints: [],
  };
  assert.ok(rowHtml({ ...base, health: "unhealthy" }).startsWith('<tr class="row-bad">'));
  assert.ok(rowHtml({ ...base, restartCount: 9 }).startsWith('<tr class="row-warn">'));
  assert.ok(rowHtml(base).startsWith("<tr>"), "a healthy, low-restart container has no row class");
  assert.ok(
    rowHtml({ ...base, state: "exited", health: null, restartCount: 12 }).startsWith("<tr>"),
    "an exited container is not flagged as a live problem",
  );
});
