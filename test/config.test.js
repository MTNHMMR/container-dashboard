import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loadConfig returns documented defaults when env is empty", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.dashboardHost, "localhost");
  assert.equal(cfg.pollIntervalMs, 30000);
  assert.equal(cfg.dockerSocket, "/var/run/docker.sock");
});

test("loadConfig reads overrides from env", () => {
  const cfg = loadConfig({
    PORT: "8080",
    DASHBOARD_HOST: "homelab",
    POLL_INTERVAL_MS: "15000",
    DOCKER_SOCKET: "/tmp/docker.sock",
  });
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.dashboardHost, "homelab");
  assert.equal(cfg.pollIntervalMs, 15000);
  assert.equal(cfg.dockerSocket, "/tmp/docker.sock");
});

test("loadConfig throws on a non-numeric PORT", () => {
  assert.throws(() => loadConfig({ PORT: "not-a-number" }), /PORT/);
});

test("loadConfig throws on a non-positive POLL_INTERVAL_MS", () => {
  assert.throws(() => loadConfig({ POLL_INTERVAL_MS: "0" }), /POLL_INTERVAL_MS/);
});
