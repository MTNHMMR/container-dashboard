import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSnapshot, collect } from "../src/collector.js";

const fx = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url))));

const NOW = new Date("2026-09-08T12:34:04.000Z");

function inputs() {
  const inspects = new Map([
    ["aaaa111111111111111111111111111111111111111111111111111111111111", fx("inspect-wall-display")],
    ["bbbb222222222222222222222222222222222222222222222222222222222222", fx("inspect-adguardhome")],
    ["cccc333333333333333333333333333333333333333333333333333333333333", fx("inspect-portainer")],
  ]);
  const stats = new Map([
    ["aaaa111111111111111111111111111111111111111111111111111111111111", fx("stats-wall-display")],
    ["cccc333333333333333333333333333333333333333333333333333333333333", fx("stats-portainer")],
  ]);
  return {
    info: fx("info"),
    df: fx("df"),
    containers: fx("containers"),
    inspects,
    stats,
    now: NOW,
    dashboardHost: "homelab",
  };
}

test("host block is derived from /info and /system/df", () => {
  const s = buildSnapshot(inputs());
  assert.equal(s.host.dockerVersion, "27.1.1");
  assert.equal(s.host.os, "Docker Desktop");
  assert.equal(s.host.arch, "x86_64");
  assert.equal(s.host.containersRunning, 3);
  assert.equal(s.host.containersStopped, 2);
  assert.equal(s.host.imagesCount, 12);
  assert.equal(s.host.storageDriver, "overlay2");
  assert.equal(s.host.memLimitBytes, 8203526144);
  assert.equal(s.host.diskTotalBytes, null);
  // 1680000000 images + (22000000+15000000+0) containers + 90000000 volumes + 5000000 buildcache
  assert.equal(s.host.diskUsedBytes, 1680000000 + 37000000 + 90000000 + 5000000);
});

test("engine uptime is now minus the earliest running StartedAt", () => {
  const s = buildSnapshot(inputs());
  // earliest StartedAt is portainer 12:20:00 -> 14m 4s = 844s
  assert.equal(s.host.engineUptimeSecs, 844);
});

test("per-container CPU % uses the Docker formula", () => {
  const s = buildSnapshot(inputs());
  const wd = s.containers.find((c) => c.name === "wall-display");
  // cpuDelta 20,000,000 / systemDelta 100,000,000 * 4 * 100 = 80
  assert.equal(Math.round(wd.cpuPct), 80);
});

test("per-container memory subtracts cache", () => {
  const s = buildSnapshot(inputs());
  const wd = s.containers.find((c) => c.name === "wall-display");
  assert.equal(wd.memUsedBytes, 100000000); // 120,000,000 - 20,000,000
  assert.equal(Math.round(wd.memPct * 100) / 100, Math.round((100000000 / 8203526144) * 10000) / 100);
});

test("host totalCpuPct is the sum of container CPU over NCPU", () => {
  const s = buildSnapshot(inputs());
  // wall-display 80 + portainer 0 = 80, / 4 = 20
  assert.equal(Math.round(s.host.totalCpuPct), 20);
  assert.equal(s.host.totalMemUsedBytes, 100000000 + 60000000);
});

test("endpoints are built from tcp published ports, de-duped and sorted", () => {
  const s = buildSnapshot(inputs());
  const adg = s.containers.find((c) => c.name === "adguardhome");
  assert.deepEqual(adg.endpoints, [
    "http://homelab:53",
    "http://homelab:853",
    "http://homelab:3000",
  ]);
  const port = s.containers.find((c) => c.name === "portainer");
  assert.deepEqual(port.endpoints, ["http://homelab:8000", "http://homelab:9443"]);
});

test("a running container with no stats entry yields null cpu/mem, not a throw", () => {
  const i = inputs();
  i.stats.delete("bbbb222222222222222222222222222222222222222222222222222222222222");
  const s = buildSnapshot(i);
  const adg = s.containers.find((c) => c.name === "adguardhome");
  assert.equal(adg.cpuPct, null);
  assert.equal(adg.memUsedBytes, null);
  assert.equal(adg.memPct, null);
});

test("health is passed through or null when absent", () => {
  const s = buildSnapshot(inputs());
  assert.equal(s.containers.find((c) => c.name === "wall-display").health, "healthy");
  assert.equal(s.containers.find((c) => c.name === "adguardhome").health, "starting");
  assert.equal(s.containers.find((c) => c.name === "portainer").health, null);
});

test("restart count comes from inspect", () => {
  const s = buildSnapshot(inputs());
  assert.equal(s.containers.find((c) => c.name === "portainer").restartCount, 2);
});

test("containers are sorted running-first then by name; ids are shortened", () => {
  const s = buildSnapshot(inputs());
  assert.deepEqual(
    s.containers.map((c) => c.name),
    ["adguardhome", "portainer", "wall-display", "ollama"]
  );
  assert.equal(s.containers[0].id.length, 12);
});

test("an exited container has null uptime and no stats", () => {
  const s = buildSnapshot(inputs());
  const ol = s.containers.find((c) => c.name === "ollama");
  assert.equal(ol.state, "exited");
  assert.equal(ol.uptimeSecs, null);
  assert.equal(ol.cpuPct, null);
  assert.equal(ol.endpoints.length, 0);
});

test("lastUpdated equals now and lastError is null", () => {
  const s = buildSnapshot(inputs());
  assert.equal(s.lastUpdated, NOW.toISOString());
  assert.equal(s.lastError, null);
});

test("collect() orchestrates client calls and returns a snapshot", async () => {
  const containers = fx("containers");
  const inspectById = {
    aaaa111111111111111111111111111111111111111111111111111111111111: fx("inspect-wall-display"),
    bbbb222222222222222222222222222222222222222222222222222222222222: fx("inspect-adguardhome"),
    cccc333333333333333333333333333333333333333333333333333333333333: fx("inspect-portainer"),
    dddd444444444444444444444444444444444444444444444444444444444444: {
      Id: "dddd444444444444444444444444444444444444444444444444444444444444",
      RestartCount: 1,
      State: { Status: "exited", StartedAt: "0001-01-01T00:00:00Z" },
      Config: { Image: "ollama/ollama" },
    },
  };
  const statsById = {
    aaaa111111111111111111111111111111111111111111111111111111111111: fx("stats-wall-display"),
    bbbb222222222222222222222222222222222222222222222222222222222222: fx("stats-wall-display"),
    cccc333333333333333333333333333333333333333333333333333333333333: fx("stats-portainer"),
  };
  const client = {
    info: async () => fx("info"),
    df: async () => fx("df"),
    listContainers: async () => containers,
    inspect: async (id) => inspectById[id],
    stats: async (id) => statsById[id],
  };
  const s = await collect(client, { dashboardHost: "homelab" }, NOW);
  assert.equal(s.host.dockerVersion, "27.1.1");
  assert.equal(s.containers.length, 4);
  assert.equal(s.lastError, null);
});

test("collect() tolerates a failing stats call for one container", async () => {
  const containers = fx("containers").filter((c) => c.State === "running");
  const client = {
    info: async () => fx("info"),
    df: async () => fx("df"),
    listContainers: async () => containers,
    inspect: async (id) =>
      ({
        aaaa111111111111111111111111111111111111111111111111111111111111: fx("inspect-wall-display"),
        bbbb222222222222222222222222222222222222222222222222222222222222: fx("inspect-adguardhome"),
        cccc333333333333333333333333333333333333333333333333333333333333: fx("inspect-portainer"),
      })[id],
    stats: async (id) => {
      if (id.startsWith("bbbb")) throw new Error("stats stream closed");
      return id.startsWith("aaaa") ? fx("stats-wall-display") : fx("stats-portainer");
    },
  };
  const s = await collect(client, { dashboardHost: "homelab" }, NOW);
  assert.equal(s.containers.find((c) => c.name === "adguardhome").cpuPct, null);
  assert.equal(Math.round(s.containers.find((c) => c.name === "wall-display").cpuPct), 80);
});
