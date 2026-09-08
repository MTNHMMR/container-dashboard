# Container Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live web dashboard that shows the health of every Docker container on the HomeLab host, refreshing every 30 seconds.

**Architecture:** One Node/Express service, running as its own container, talks to the Docker Engine API over the mounted Unix socket. A background poller collects a full snapshot every 30 s and holds it in memory. The browser loads a dark single-page dashboard and re-fetches `GET /api/status` on the same cadence. No database, no auth.

**Tech Stack:** Node.js 24 (ESM), Express 4, Node's built-in `node:test` + `node:assert`, the built-in `http` module with `socketPath` for Docker API calls (no Docker client library), vanilla browser JS with no build step.

## Global Constraints

- **Node.js:** target Node 24 (`node:24-slim` base image). Use ESM (`"type": "module"`). `node --test` is the test runner — no Jest/Mocha/Vitest.
- **Runtime dependencies:** `express` only. No `dockerode`, no `axios`, no `node-fetch` (Node 24 has global `fetch`). Dev dependencies: none beyond Node built-ins.
- **Docker access is read-only.** Only ever issue `GET` requests to the Docker API. Never `POST`/`DELETE`/`start`/`stop`/`exec`.
- **No secrets in the image or repo.** All configuration via environment variables with safe defaults.
- **Config env vars and defaults (exact):**
  - `PORT` = `9000`
  - `DASHBOARD_HOST` = `localhost` (used only to build container endpoint links)
  - `POLL_INTERVAL_MS` = `30000`
  - `DOCKER_SOCKET` = `/var/run/docker.sock`
- **Snapshot is the single shared interface** between collector, poller, server, and page. Its shape is defined in Task 3 and must not drift.
- **Frontend:** one `index.html` + `style.css` + `app.js` + `format.js`, served statically. No bundler, no external fonts or images, no CDN. ES modules via `<script type="module">`.
- **Dark theme** modelled on the SEMO Web Co "VPS Status" page: dark blue-grey canvas, raised stat cards, cyan section eyebrow labels, green status dots.
- **Commit after every task** (each task's final step). Use Conventional Commits (`feat:`, `test:`, `chore:`, `docs:`, `ci:`).
- **Design doc:** `docs/superpowers/specs/2026-09-08-container-dashboard-design.md` — this plan implements it.

---

## File Structure

```
A:/Project/container-dashboard/
├── package.json                     # ESM, express dep, test/start scripts
├── .gitignore                       # (exists) node_modules, .env, *.log
├── .dockerignore                    # keep image lean
├── src/
│   ├── config.js                    # read + validate env vars -> config object
│   ├── docker-client.js             # thin GET-only wrapper over the Docker socket
│   ├── collector.js                 # buildSnapshot() pure fn + collect() orchestrator
│   ├── poller.js                    # createPoller(): interval, in-memory snapshot, serve-stale
│   ├── server.js                    # createApp(): Express app, /, /api/status, /api/health
│   └── index.js                     # entrypoint: wire everything, listen, graceful shutdown
├── public/
│   ├── index.html                   # dashboard markup shell
│   ├── style.css                    # dark theme
│   ├── format.js                    # pure formatting helpers (shared: browser + tests)
│   └── app.js                       # fetch /api/status, render, 30s refresh, stale badge
├── test/
│   ├── fixtures/
│   │   ├── info.json
│   │   ├── df.json
│   │   ├── containers.json
│   │   ├── inspect-wall-display.json
│   │   ├── inspect-portainer.json
│   │   ├── inspect-adguardhome.json
│   │   ├── stats-wall-display.json
│   │   └── stats-portainer.json
│   ├── config.test.js
│   ├── docker-client.test.js
│   ├── collector.test.js
│   ├── poller.test.js
│   ├── server.test.js
│   └── format.test.js
├── Dockerfile
├── docker-compose.yml
├── .github/workflows/ci.yml
└── README.md
```

**Responsibilities:**

| File | One job |
| --- | --- |
| `src/config.js` | Turn `process.env` into a validated, typed config object. Pure apart from reading `process.env`. |
| `src/docker-client.js` | Issue GET requests to the Docker socket and JSON-parse the response. Knows nothing about snapshots. |
| `src/collector.js` | `buildSnapshot(raw)` — pure transform of raw Docker JSON into a `Snapshot`. `collect(client, config, now)` — thin orchestrator that gathers the raw inputs and calls `buildSnapshot`. |
| `src/poller.js` | Run `collect` on an interval, keep the latest good `Snapshot`, expose `getSnapshot()`, serve stale data with `lastError` set on failure. |
| `src/server.js` | Express wiring only: static `public/`, `GET /api/status`, `GET /api/health`. |
| `src/index.js` | Compose config + client + poller + server, start listening, stop cleanly on `SIGTERM`/`SIGINT`. |
| `public/format.js` | `fmtBytes`, `fmtDuration`, `fmtPct`, `fmtRelTime` — used by `app.js` and unit-tested in Node. |
| `public/app.js` | DOM rendering + polling loop. No business logic beyond display. |

---

## Notes on Docker API endpoints used

All over `http://localhost` bound to `config.dockerSocket` via `http.request({ socketPath })`.

- `GET /info` → `ServerVersion`, `OperatingSystem`, `Architecture`, `Containers`, `ContainersRunning`, `ContainersStopped`, `Images`, `Driver`, `NCPU`, `MemTotal`.
- `GET /system/df` → `LayersSize`, `Images[]` (each `Size`/`SharedSize`), `Containers[]` (`SizeRw`), `Volumes[]` (`UsageData.Size`). We report **total reclaimable + active image/container/volume bytes** as `diskUsedBytes`. The Docker API exposes no filesystem total, so `diskTotalBytes` is always `null` and the UI shows the used figure without a percentage.
- `GET /containers/json?all=true` → array with `Id`, `Names`, `Image`, `State` (`running`/`exited`/…), `Status`, `Ports[]` (`IP`, `PrivatePort`, `PublicPort`, `Type`), `Created`.
- `GET /containers/{id}/json` (inspect) → `State.StartedAt`, `State.Health.Status` (may be absent), `RestartCount`, `Config.Image`.
- `GET /containers/{id}/stats?stream=false` → single reading with `cpu_stats` + `precpu_stats` + `memory_stats`. Used for live CPU %/memory. Only called for containers whose `State` is `running`.

**Engine uptime:** the API has no direct value; derive it as `now - min(StartedAt across running containers)`. `null` when nothing is running.

**CPU % per container** (standard Docker formula):
```
cpuDelta    = cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage
systemDelta = cpu_stats.system_cpu_usage      - precpu_stats.system_cpu_usage
onlineCPUs  = cpu_stats.online_cpus || (cpu_stats.cpu_usage.percpu_usage?.length ?? 1)
cpuPct      = systemDelta > 0 && cpuDelta > 0
              ? (cpuDelta / systemDelta) * onlineCPUs * 100
              : 0
```

**Memory used per container:** `memory_stats.usage - (memory_stats.stats.cache ?? 0)`; `memPct = memUsedBytes / memory_stats.limit * 100`.

**Host CPU %:** `totalCpuPct = sum(container.cpuPct) / info.NCPU` (percentage of total host capacity).
**Host memory used:** `totalMemUsedBytes = sum(container.memUsedBytes)`; `memLimitBytes = info.MemTotal`.

**Endpoints per container:** for each port with a truthy `PublicPort` and `Type === "tcp"`, emit `http://${config.dashboardHost}:${PublicPort}`, de-duplicated, sorted ascending. (Scheme is always `http` — we cannot detect TLS; note this in the README.)

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`
- Create: `src/config.js`
- Create: `.dockerignore`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadConfig(env = process.env) -> { port: number, dashboardHost: string, pollIntervalMs: number, dockerSocket: string }`
  - Exported from `src/config.js` as a named export `loadConfig`.
  - Invalid numeric env vars (`PORT`, `POLL_INTERVAL_MS`) throw `Error` with a message naming the offending variable. Missing vars fall back to the documented defaults.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "container-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.21.2"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: creates `node_modules/` and `package-lock.json`, no errors.

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
npm-debug.log
.git
.github
docs
test
*.md
.env
```

- [ ] **Step 4: Write the failing test** — `test/config.test.js`

```js
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
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 6: Implement `src/config.js`**

```js
function parsePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

export function loadConfig(env = process.env) {
  return {
    port: env.PORT === undefined ? 9000 : parsePositiveInt(env.PORT, "PORT"),
    dashboardHost: env.DASHBOARD_HOST || "localhost",
    pollIntervalMs:
      env.POLL_INTERVAL_MS === undefined
        ? 30000
        : parsePositiveInt(env.POLL_INTERVAL_MS, "POLL_INTERVAL_MS"),
    dockerSocket: env.DOCKER_SOCKET || "/var/run/docker.sock",
  };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .dockerignore src/config.js test/config.test.js
git commit -m "feat: project scaffold and env configuration"
```

---

### Task 2: Docker socket client

**Files:**
- Create: `src/docker-client.js`
- Test: `test/docker-client.test.js`

**Interfaces:**
- Consumes: `config.dockerSocket` (string) from Task 1.
- Produces — `createDockerClient({ socketPath }) -> client` where `client` has:
  - `getJson(path: string) -> Promise<any>` — low-level GET returning parsed JSON; rejects `Error` (message includes status code) on non-2xx.
  - `info() -> Promise<object>` — `GET /info`
  - `df() -> Promise<object>` — `GET /system/df`
  - `listContainers() -> Promise<object[]>` — `GET /containers/json?all=true`
  - `inspect(id: string) -> Promise<object>` — `GET /containers/{id}/json`
  - `stats(id: string) -> Promise<object>` — `GET /containers/{id}/stats?stream=false`

- [ ] **Step 1: Write the failing test** — `test/docker-client.test.js`

Uses a throwaway HTTP server bound to a Unix socket in `os.tmpdir()` to stand in for the Docker daemon. (CI runs on Linux; this is fine there. On a Windows dev box this test is skipped automatically because `http.Server.listen(socketPath)` throws — the test guards for that.)

```js
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDockerClient } from "../src/docker-client.js";

function tempSock() {
  return path.join(os.tmpdir(), `dc-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

async function withФakeDaemon(handler, run) {
  const socketPath = tempSock();
  const server = http.createServer(handler);
  let listened = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { listened = true; resolve(); });
    });
  } catch (err) {
    return { skipped: true, reason: String(err) };
  }
  try {
    return await run(socketPath);
  } finally {
    server.close();
    if (listened) fs.rmSync(socketPath, { force: true });
  }
}

test("getJson parses a JSON body from the socket", async (t) => {
  const result = await withФakeDaemon(
    (req, res) => {
      assert.equal(req.url, "/info");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ServerVersion: "27.1.1" }));
    },
    async (socketPath) => {
      const client = createDockerClient({ socketPath });
      return client.info();
    }
  );
  if (result?.skipped) return t.skip(result.reason);
  assert.equal(result.ServerVersion, "27.1.1");
});

test("getJson rejects on a non-2xx response", async (t) => {
  const result = await withФakeDaemon(
    (req, res) => { res.statusCode = 500; res.end("boom"); },
    async (socketPath) => {
      const client = createDockerClient({ socketPath });
      return client.getJson("/info").then(
        () => ({ threw: false }),
        (err) => ({ threw: true, message: err.message })
      );
    }
  );
  if (result?.skipped) return t.skip(result.reason);
  assert.equal(result.threw, true);
  assert.match(result.message, /500/);
});

test("listContainers requests all containers", async (t) => {
  const result = await withФakeDaemon(
    (req, res) => {
      assert.equal(req.url, "/containers/json?all=true");
      res.setHeader("content-type", "application/json");
      res.end("[]");
    },
    async (socketPath) => createDockerClient({ socketPath }).listContainers()
  );
  if (result?.skipped) return t.skip(result.reason);
  assert.deepEqual(result, []);
});
```

> Note: rename the helper `withFakeDaemon` (ASCII) when implementing — the Cyrillic letters above are a copy artifact. Keep it ASCII in the real file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/docker-client.test.js`
Expected: FAIL — `Cannot find module '../src/docker-client.js'`.

- [ ] **Step 3: Implement `src/docker-client.js`**

```js
import http from "node:http";

function getJson(socketPath, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: apiPath, method: "GET", headers: { Host: "docker" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Docker API ${apiPath} -> HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : null);
          } catch (err) {
            reject(new Error(`Docker API ${apiPath} -> invalid JSON: ${err.message}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(new Error(`Docker API ${apiPath} -> ${err.message}`)));
    req.end();
  });
}

export function createDockerClient({ socketPath }) {
  const call = (p) => getJson(socketPath, p);
  return {
    getJson: call,
    info: () => call("/info"),
    df: () => call("/system/df"),
    listContainers: () => call("/containers/json?all=true"),
    inspect: (id) => call(`/containers/${id}/json`),
    stats: (id) => call(`/containers/${id}/stats?stream=false`),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/docker-client.test.js`
Expected: PASS (3 tests; each may report as skipped on a non-Linux dev box — that is acceptable, CI is the gate).

- [ ] **Step 5: Commit**

```bash
git add src/docker-client.js test/docker-client.test.js
git commit -m "feat: GET-only Docker socket client"
```

---

### Task 3: Collector — `buildSnapshot` and `collect`

**Files:**
- Create: `src/collector.js`
- Create: `test/fixtures/info.json`
- Create: `test/fixtures/df.json`
- Create: `test/fixtures/containers.json`
- Create: `test/fixtures/inspect-wall-display.json`
- Create: `test/fixtures/inspect-portainer.json`
- Create: `test/fixtures/inspect-adguardhome.json`
- Create: `test/fixtures/stats-wall-display.json`
- Create: `test/fixtures/stats-portainer.json`
- Test: `test/collector.test.js`

**Interfaces:**
- Consumes: the `client` from Task 2, `config` from Task 1.
- Produces:
  - `buildSnapshot({ info, df, containers, inspects, stats, now, dashboardHost }) -> Snapshot`
    - `inspects: Map<string, object>` keyed by full container id
    - `stats: Map<string, object>` keyed by full container id (running only; may be missing an entry)
    - `now: Date`
  - `collect(client, config, now = new Date()) -> Promise<Snapshot>` — calls `info`/`df`/`listContainers`, then `inspect` for every container and `stats` for every running one (via `Promise.allSettled`; a failed `stats` call just means no live CPU/mem for that row), then returns `buildSnapshot(...)`.
  - **`Snapshot` shape (frozen contract):**

```
Snapshot = {
  host: {
    dockerVersion: string,
    os: string,
    arch: string,
    containersRunning: number,
    containersStopped: number,
    imagesCount: number,
    storageDriver: string,
    diskUsedBytes: number,
    diskTotalBytes: number | null,   // always null (Docker API has no fs total)
    totalCpuPct: number,             // 0..100-ish, share of whole host
    totalMemUsedBytes: number,
    memLimitBytes: number,
    engineUptimeSecs: number | null
  },
  containers: [
    {
      id: string,                    // short id, 12 chars
      name: string,                  // leading slash stripped
      image: string,
      state: string,                 // "running" | "exited" | ...
      health: string | null,         // "healthy" | "unhealthy" | "starting" | null
      startedAt: string | null,      // ISO string
      uptimeSecs: number | null,
      restartCount: number,
      ports: [ { ip: string|null, privatePort: number, publicPort: number|null, type: string } ],
      endpoints: string[],           // ["http://HOST:8080"]
      cpuPct: number | null,         // null when stats unavailable
      memUsedBytes: number | null,
      memPct: number | null
    }
  ],
  lastUpdated: string,               // ISO string == now
  lastError: null                    // buildSnapshot always sets null; poller overwrites on failure
}
```

  - `containers` is sorted: running first, then by name ascending.

- [ ] **Step 1: Create the fixtures**

Create `test/fixtures/info.json`:

```json
{
  "ServerVersion": "27.1.1",
  "OperatingSystem": "Docker Desktop",
  "Architecture": "x86_64",
  "Containers": 5,
  "ContainersRunning": 3,
  "ContainersStopped": 2,
  "Images": 12,
  "Driver": "overlay2",
  "NCPU": 4,
  "MemTotal": 8203526144
}
```

Create `test/fixtures/df.json`:

```json
{
  "LayersSize": 1680000000,
  "Images": [{ "Size": 1680000000, "SharedSize": 400000000 }],
  "Containers": [{ "SizeRw": 22000000 }, { "SizeRw": 15000000 }, { "SizeRw": 0 }],
  "Volumes": [{ "UsageData": { "Size": 90000000 } }],
  "BuildCache": [{ "Size": 5000000 }]
}
```

Create `test/fixtures/containers.json` (from `GET /containers/json?all=true`):

```json
[
  {
    "Id": "aaaa111111111111111111111111111111111111111111111111111111111111",
    "Names": ["/wall-display"],
    "Image": "wall-display:latest",
    "State": "running",
    "Status": "Up 11 minutes (healthy)",
    "Created": 1757310000,
    "Ports": [
      { "IP": "0.0.0.0", "PrivatePort": 8080, "PublicPort": 8080, "Type": "tcp" },
      { "IP": "::", "PrivatePort": 8080, "PublicPort": 8080, "Type": "tcp" }
    ]
  },
  {
    "Id": "bbbb222222222222222222222222222222222222222222222222222222222222",
    "Names": ["/adguardhome"],
    "Image": "adguard/adguardhome",
    "State": "running",
    "Status": "Up 11 minutes",
    "Created": 1757309000,
    "Ports": [
      { "IP": "0.0.0.0", "PrivatePort": 53, "PublicPort": 53, "Type": "tcp" },
      { "IP": "0.0.0.0", "PrivatePort": 53, "PublicPort": 53, "Type": "udp" },
      { "IP": "0.0.0.0", "PrivatePort": 3000, "PublicPort": 3000, "Type": "tcp" },
      { "IP": "0.0.0.0", "PrivatePort": 853, "PublicPort": 853, "Type": "tcp" }
    ]
  },
  {
    "Id": "cccc333333333333333333333333333333333333333333333333333333333333",
    "Names": ["/portainer"],
    "Image": "portainer/portainer-ce:latest",
    "State": "running",
    "Status": "Up 11 minutes",
    "Created": 1757308000,
    "Ports": [
      { "IP": "0.0.0.0", "PrivatePort": 9443, "PublicPort": 9443, "Type": "tcp" },
      { "IP": "0.0.0.0", "PrivatePort": 8000, "PublicPort": 8000, "Type": "tcp" },
      { "PrivatePort": 9000, "Type": "tcp" }
    ]
  },
  {
    "Id": "dddd444444444444444444444444444444444444444444444444444444444444",
    "Names": ["/ollama"],
    "Image": "ollama/ollama",
    "State": "exited",
    "Status": "Exited (255) 15 hours ago",
    "Created": 1757200000,
    "Ports": []
  }
]
```

Create `test/fixtures/inspect-wall-display.json`:

```json
{
  "Id": "aaaa111111111111111111111111111111111111111111111111111111111111",
  "Name": "/wall-display",
  "RestartCount": 0,
  "State": {
    "Status": "running",
    "StartedAt": "2026-09-08T12:23:04.000000000Z",
    "Health": { "Status": "healthy" }
  },
  "Config": { "Image": "wall-display:latest" }
}
```

Create `test/fixtures/inspect-portainer.json`:

```json
{
  "Id": "cccc333333333333333333333333333333333333333333333333333333333333",
  "Name": "/portainer",
  "RestartCount": 2,
  "State": {
    "Status": "running",
    "StartedAt": "2026-09-08T12:20:00.000000000Z"
  },
  "Config": { "Image": "portainer/portainer-ce:latest" }
}
```

Create `test/fixtures/inspect-adguardhome.json`:

```json
{
  "Id": "bbbb222222222222222222222222222222222222222222222222222222222222",
  "Name": "/adguardhome",
  "RestartCount": 0,
  "State": {
    "Status": "running",
    "StartedAt": "2026-09-08T12:22:00.000000000Z",
    "Health": { "Status": "starting" }
  },
  "Config": { "Image": "adguard/adguardhome" }
}
```

Create `test/fixtures/stats-wall-display.json` (shape from `GET /containers/{id}/stats?stream=false`):

```json
{
  "cpu_stats": {
    "cpu_usage": { "total_usage": 220000000, "percpu_usage": [1, 1, 1, 1] },
    "system_cpu_usage": 8000000000,
    "online_cpus": 4
  },
  "precpu_stats": {
    "cpu_usage": { "total_usage": 200000000 },
    "system_cpu_usage": 7900000000,
    "online_cpus": 4
  },
  "memory_stats": { "usage": 120000000, "limit": 8203526144, "stats": { "cache": 20000000 } }
}
```

Create `test/fixtures/stats-portainer.json`:

```json
{
  "cpu_stats": {
    "cpu_usage": { "total_usage": 500000000, "percpu_usage": [1, 1, 1, 1] },
    "system_cpu_usage": 8000000000,
    "online_cpus": 4
  },
  "precpu_stats": {
    "cpu_usage": { "total_usage": 500000000 },
    "system_cpu_usage": 8000000000,
    "online_cpus": 4
  },
  "memory_stats": { "usage": 60000000, "limit": 8203526144, "stats": {} }
}
```

- [ ] **Step 2: Write the failing test** — `test/collector.test.js`

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/collector.test.js`
Expected: FAIL — `Cannot find module '../src/collector.js'`.

- [ ] **Step 4: Implement `src/collector.js`**

```js
const SECOND = 1000;

function shortId(id) {
  return String(id).slice(0, 12);
}

function stripName(names) {
  const n = Array.isArray(names) ? names[0] : names;
  return String(n || "").replace(/^\//, "");
}

function cpuPctFromStats(st) {
  if (!st || !st.cpu_stats || !st.precpu_stats) return null;
  const cpuDelta =
    (st.cpu_stats.cpu_usage?.total_usage ?? 0) - (st.precpu_stats.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (st.cpu_stats.system_cpu_usage ?? 0) - (st.precpu_stats.system_cpu_usage ?? 0);
  const onlineCPUs =
    st.cpu_stats.online_cpus || st.cpu_stats.cpu_usage?.percpu_usage?.length || 1;
  if (systemDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * onlineCPUs * 100;
}

function memFromStats(st) {
  if (!st || !st.memory_stats || typeof st.memory_stats.usage !== "number") {
    return { memUsedBytes: null, memPct: null };
  }
  const cache = st.memory_stats.stats?.cache ?? 0;
  const used = st.memory_stats.usage - cache;
  const limit = st.memory_stats.limit || 0;
  return { memUsedBytes: used, memPct: limit > 0 ? (used / limit) * 100 : null };
}

function diskUsed(df) {
  const images = (df.Images || []).reduce((a, i) => a + (i.Size || 0), 0);
  const containers = (df.Containers || []).reduce((a, c) => a + (c.SizeRw || 0), 0);
  const volumes = (df.Volumes || []).reduce((a, v) => a + (v.UsageData?.Size || 0), 0);
  const buildCache = (df.BuildCache || []).reduce((a, b) => a + (b.Size || 0), 0);
  return images + containers + volumes + buildCache;
}

function endpointsFor(ports, host) {
  const seen = new Set();
  for (const p of ports || []) {
    if (p.Type === "tcp" && p.PublicPort) seen.add(p.PublicPort);
  }
  return [...seen].sort((a, b) => a - b).map((port) => `http://${host}:${port}`);
}

function normalizePorts(ports) {
  return (ports || []).map((p) => ({
    ip: p.IP ?? null,
    privatePort: p.PrivatePort,
    publicPort: p.PublicPort ?? null,
    type: p.Type,
  }));
}

export function buildSnapshot({ info, df, containers, inspects, stats, now, dashboardHost }) {
  const nowMs = now.getTime();
  let earliestStart = null;

  const rows = containers.map((c) => {
    const insp = inspects.get(c.Id) || {};
    const st = stats.get(c.Id) || null;
    const running = (c.State || insp.State?.Status) === "running";
    const startedAtRaw = insp.State?.StartedAt || null;
    const startedMs = startedAtRaw ? Date.parse(startedAtRaw) : NaN;
    const validStart = running && Number.isFinite(startedMs) && startedMs > 0;
    if (validStart && (earliestStart === null || startedMs < earliestStart)) {
      earliestStart = startedMs;
    }
    const { memUsedBytes, memPct } = running ? memFromStats(st) : { memUsedBytes: null, memPct: null };
    return {
      id: shortId(c.Id),
      name: stripName(c.Names),
      image: c.Image || insp.Config?.Image || "",
      state: c.State || insp.State?.Status || "unknown",
      health: insp.State?.Health?.Status ?? null,
      startedAt: validStart ? new Date(startedMs).toISOString() : null,
      uptimeSecs: validStart ? Math.floor((nowMs - startedMs) / SECOND) : null,
      restartCount: insp.RestartCount ?? 0,
      ports: normalizePorts(c.Ports),
      endpoints: running ? endpointsFor(c.Ports, dashboardHost) : [],
      cpuPct: running ? cpuPctFromStats(st) : null,
      memUsedBytes,
      memPct,
    };
  });

  rows.sort((a, b) => {
    const ar = a.state === "running" ? 0 : 1;
    const br = b.state === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });

  const totalCpuPct =
    rows.reduce((a, r) => a + (r.cpuPct || 0), 0) / (info.NCPU || 1);
  const totalMemUsedBytes = rows.reduce((a, r) => a + (r.memUsedBytes || 0), 0);

  return {
    host: {
      dockerVersion: info.ServerVersion || "unknown",
      os: info.OperatingSystem || "unknown",
      arch: info.Architecture || "unknown",
      containersRunning: info.ContainersRunning ?? rows.filter((r) => r.state === "running").length,
      containersStopped: info.ContainersStopped ?? rows.filter((r) => r.state !== "running").length,
      imagesCount: info.Images ?? 0,
      storageDriver: info.Driver || "unknown",
      diskUsedBytes: diskUsed(df),
      diskTotalBytes: null,
      totalCpuPct,
      totalMemUsedBytes,
      memLimitBytes: info.MemTotal ?? 0,
      engineUptimeSecs: earliestStart === null ? null : Math.floor((nowMs - earliestStart) / SECOND),
    },
    containers: rows,
    lastUpdated: now.toISOString(),
    lastError: null,
  };
}

export async function collect(client, config, now = new Date()) {
  const [info, df, containers] = await Promise.all([
    client.info(),
    client.df(),
    client.listContainers(),
  ]);

  const inspects = new Map();
  const stats = new Map();

  const inspectResults = await Promise.allSettled(
    containers.map((c) => client.inspect(c.Id).then((r) => [c.Id, r]))
  );
  for (const r of inspectResults) {
    if (r.status === "fulfilled" && r.value) inspects.set(r.value[0], r.value[1]);
  }

  const runningIds = containers
    .filter((c) => (c.State || inspects.get(c.Id)?.State?.Status) === "running")
    .map((c) => c.Id);
  const statResults = await Promise.allSettled(
    runningIds.map((id) => client.stats(id).then((r) => [id, r]))
  );
  for (const r of statResults) {
    if (r.status === "fulfilled" && r.value) stats.set(r.value[0], r.value[1]);
  }

  return buildSnapshot({
    info,
    df,
    containers,
    inspects,
    stats,
    now,
    dashboardHost: config.dashboardHost,
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/collector.test.js`
Expected: PASS — all tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS — config, docker-client (or skipped), collector.

- [ ] **Step 7: Commit**

```bash
git add src/collector.js test/collector.test.js test/fixtures
git commit -m "feat: collector builds the container snapshot from Docker API data"
```

---

### Task 4: Poller — interval collection with serve-stale

**Files:**
- Create: `src/poller.js`
- Test: `test/poller.test.js`

**Interfaces:**
- Consumes: `collect` (from Task 3) — but injected as a function so it can be faked.
- Produces — `createPoller({ collectFn, intervalMs, logger = console }) -> poller` where `poller` has:
  - `start() -> Promise<void>` — runs one collection immediately (awaited), then schedules the rest on `intervalMs` (`setInterval`, `unref()`'d).
  - `stop() -> void` — clears the interval.
  - `getSnapshot() -> Snapshot | { host: null, containers: [], lastUpdated: null, lastError: string }` — returns the last good snapshot; on a never-succeeded start, returns the empty-with-error object.
  - Behaviour: on a successful `collectFn`, store it as the current snapshot. On a throw: keep the previous snapshot but set `.lastError` to the error message and update nothing else; if there is no previous snapshot, `getSnapshot()` returns the empty-with-error object with `lastError`.

- [ ] **Step 1: Write the failing test** — `test/poller.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "../src/poller.js";

const okSnap = (n) => ({
  host: { dockerVersion: "27" },
  containers: [],
  lastUpdated: `t${n}`,
  lastError: null,
});

const silent = { log() {}, warn() {}, error() {} };

test("start() runs one collection immediately", async () => {
  let calls = 0;
  const poller = createPoller({
    collectFn: async () => okSnap(++calls),
    intervalMs: 10_000,
    logger: silent,
  });
  await poller.start();
  assert.equal(poller.getSnapshot().lastUpdated, "t1");
  poller.stop();
});

test("before any success, getSnapshot returns an empty snapshot with lastError", async () => {
  const poller = createPoller({
    collectFn: async () => { throw new Error("docker down"); },
    intervalMs: 10_000,
    logger: silent,
  });
  await poller.start();
  const s = poller.getSnapshot();
  assert.equal(s.host, null);
  assert.deepEqual(s.containers, []);
  assert.match(s.lastError, /docker down/);
  poller.stop();
});

test("a later failure keeps the last good snapshot but sets lastError", async () => {
  let mode = "ok";
  const poller = createPoller({
    collectFn: async () => {
      if (mode === "boom") throw new Error("transient");
      return okSnap(1);
    },
    intervalMs: 10_000,
    logger: silent,
  });
  await poller.start();
  assert.equal(poller.getSnapshot().lastError, null);

  mode = "boom";
  await poller._tickOnceForTest();
  const s = poller.getSnapshot();
  assert.equal(s.lastUpdated, "t1"); // unchanged
  assert.match(s.lastError, /transient/);

  poller.stop();
});

test("recovery clears lastError", async () => {
  let mode = "boom";
  const poller = createPoller({
    collectFn: async () => {
      if (mode === "boom") throw new Error("transient");
      return okSnap(2);
    },
    intervalMs: 10_000,
    logger: silent,
  });
  await poller.start();
  assert.match(poller.getSnapshot().lastError, /transient/);
  mode = "ok";
  await poller._tickOnceForTest();
  const s = poller.getSnapshot();
  assert.equal(s.lastUpdated, "t2");
  assert.equal(s.lastError, null);
  poller.stop();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/poller.test.js`
Expected: FAIL — `Cannot find module '../src/poller.js'`.

- [ ] **Step 3: Implement `src/poller.js`**

```js
export function createPoller({ collectFn, intervalMs, logger = console }) {
  let current = null; // last good Snapshot
  let lastError = null;
  let timer = null;

  async function tick() {
    try {
      const snap = await collectFn();
      current = snap;
      lastError = null;
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      logger.error(`[poller] collection failed: ${lastError}`);
    }
  }

  return {
    async start() {
      await tick();
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    getSnapshot() {
      if (current) {
        return { ...current, lastError };
      }
      return { host: null, containers: [], lastUpdated: null, lastError: lastError ?? "no data yet" };
    },
    // test seam: run exactly one collection cycle
    _tickOnceForTest: tick,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/poller.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/poller.js test/poller.test.js
git commit -m "feat: poller with in-memory snapshot and serve-stale-on-error"
```

---

### Task 5: HTTP server — `/api/status`, `/api/health`, static dashboard

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: an object shaped like the poller (`{ getSnapshot() }`) and a `publicDir` absolute path.
- Produces — `createApp({ poller, publicDir }) -> express.Application` with:
  - `GET /api/status` → `200 application/json`, body is `poller.getSnapshot()`. Adds header `Cache-Control: no-store`.
  - `GET /api/health` → `200 application/json` `{ status: "ok" }` always (liveness only; does not depend on Docker).
  - `GET /` and other paths → static files from `publicDir` (`express.static`), so `/` serves `index.html`.

- [ ] **Step 1: Write the failing test** — `test/server.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.js";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

function start(poller) {
  const app = createApp({ poller, publicDir });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test("GET /api/status returns the poller snapshot as JSON with no-store", async () => {
  const snap = { host: { dockerVersion: "27" }, containers: [], lastUpdated: "t1", lastError: null };
  const { server, base } = await start({ getSnapshot: () => snap });
  try {
    const res = await fetch(`${base}/api/status`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), snap);
  } finally {
    server.close();
  }
});

test("GET /api/health is ok regardless of Docker", async () => {
  const { server, base } = await start({
    getSnapshot: () => { throw new Error("should not be called"); },
  });
  try {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  } finally {
    server.close();
  }
});

test("GET / serves the dashboard HTML", async () => {
  const { server, base } = await start({ getSnapshot: () => ({}) });
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const html = await res.text();
    assert.match(html, /Container Dashboard/i);
  } finally {
    server.close();
  }
});
```

> `GET /` depends on `public/index.html` existing. It is created in Task 6. If executing strictly in order, this third assertion will fail until Task 6 — that is expected; run this test again at the end of Task 6. The first two assertions pass now.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — `Cannot find module '../src/server.js'`.

- [ ] **Step 3: Implement `src/server.js`**

```js
import express from "express";

export function createApp({ poller, publicDir }) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(poller.getSnapshot());
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(express.static(publicDir, { extensions: ["html"] }));

  return app;
}
```

- [ ] **Step 4: Run the test**

Run: `node --test test/server.test.js`
Expected: first two tests PASS; the `GET /` test FAILS with a 404 until Task 6 adds `public/index.html`. Note it and continue.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: express app with /api/status, /api/health and static dashboard"
```

---

### Task 6: Frontend — formatters, markup, dark theme, polling

**Files:**
- Create: `public/format.js`
- Create: `public/index.html`
- Create: `public/style.css`
- Create: `public/app.js`
- Test: `test/format.test.js`

**Interfaces:**
- Consumes: `GET /api/status` returning a `Snapshot` (Task 3 shape); `GET /api/health` unused by the page.
- Produces (`public/format.js`, all pure, all named exports):
  - `fmtBytes(n: number | null) -> string` — `null` → `"—"`; else binary units (`"1.1 GiB"`, `"120 MiB"`, `"0 B"`), 1 decimal for GiB/MiB, none for B/KiB.
  - `fmtDuration(secs: number | null) -> string` — `null` → `"—"`; else compact (`"11d 10h"`, `"9m"`, `"45s"`), at most two units.
  - `fmtPct(n: number | null) -> string` — `null` → `"—"`; else `n.toFixed(1) + "%"`.
  - `fmtRelTime(iso: string | null, now = new Date()) -> string` — `null` → `"never"`; else `"12s ago"`, `"3m ago"`, `"2h ago"`.

- [ ] **Step 1: Write the failing test** — `test/format.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { fmtBytes, fmtDuration, fmtPct, fmtRelTime } from "../public/format.js";

test("fmtBytes", () => {
  assert.equal(fmtBytes(null), "—");
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2 KiB");
  assert.equal(fmtBytes(120 * 1024 * 1024), "120.0 MiB");
  assert.equal(fmtBytes(1.1 * 1024 * 1024 * 1024), "1.1 GiB");
});

test("fmtDuration", () => {
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(45), "45s");
  assert.equal(fmtDuration(9 * 60), "9m");
  assert.equal(fmtDuration(9 * 60 + 30), "9m 30s");
  assert.equal(fmtDuration(11 * 86400 + 10 * 3600), "11d 10h");
});

test("fmtPct", () => {
  assert.equal(fmtPct(null), "—");
  assert.equal(fmtPct(19.34), "19.3%");
  assert.equal(fmtPct(0), "0.0%");
});

test("fmtRelTime", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  assert.equal(fmtRelTime(null, now), "never");
  assert.equal(fmtRelTime("2026-09-08T11:59:48Z", now), "12s ago");
  assert.equal(fmtRelTime("2026-09-08T11:57:00Z", now), "3m ago");
  assert.equal(fmtRelTime("2026-09-08T10:00:00Z", now), "2h ago");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/format.test.js`
Expected: FAIL — `Cannot find module '../public/format.js'`.

- [ ] **Step 3: Implement `public/format.js`**

```js
export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const kib = n / 1024;
  if (kib < 1024) return `${Math.round(kib)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}

export function fmtDuration(secs) {
  if (secs === null || secs === undefined || Number.isNaN(secs)) return "—";
  const s = Math.floor(secs);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d && m) parts.push(`${m}m`);
  if (!d && !h && sec) parts.push(`${sec}s`);
  if (parts.length === 0) parts.push("0s");
  return parts.slice(0, 2).join(" ");
}

export function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

export function fmtRelTime(iso, now = new Date()) {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never";
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/format.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Container Dashboard</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <header class="page-head">
      <p class="eyebrow">Container Dashboard</p>
      <h1 id="host-title">HomeLab Docker</h1>
      <p id="host-sub" class="sub"></p>
      <p id="freshness" class="badge badge-live">Live · refreshes every 30 s</p>
    </header>

    <section class="cards" id="host-cards" aria-label="Host summary"></section>

    <section class="panel">
      <h2 class="eyebrow">Containers</h2>
      <div class="table-wrap">
        <table id="container-table">
          <thead>
            <tr>
              <th>Name</th><th>State</th><th>Health</th><th>Uptime</th>
              <th>Restarts</th><th>CPU</th><th>Memory</th><th>Image</th><th>Endpoints</th>
            </tr>
          </thead>
          <tbody id="container-rows"></tbody>
        </table>
      </div>
    </section>

    <footer id="foot" class="foot"></footer>

    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `public/style.css`**

Dark theme, SEMO-style. Tokens up top; no external assets.

```css
:root {
  --bg: #0c1116;
  --surface: #141b23;
  --surface-2: #1b2530;
  --line: #26313d;
  --text: #e8edf2;
  --dim: #93a1b0;
  --eyebrow: #4cc2d6;
  --accent: #4d9de0;
  --ok: #43c777;
  --warn: #e6a53d;
  --bad: #e0555b;
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  padding: 32px clamp(16px, 4vw, 56px);
  font-variant-numeric: tabular-nums;
}
.eyebrow {
  color: var(--eyebrow);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 12px;
  font-weight: 700;
  margin: 0 0 6px;
}
.page-head { margin-bottom: 28px; }
.page-head h1 { margin: 0 0 4px; font-size: 30px; }
.sub { color: var(--dim); margin: 0 0 12px; }
.badge {
  display: inline-block;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--dim);
}
.badge-live { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.badge-stale { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
.badge-down { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
  margin-bottom: 28px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
}
.card .k { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
.card .v { font-size: 24px; font-weight: 700; margin-top: 6px; }
.card .note { color: var(--dim); font-size: 12px; margin-top: 4px; }

.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px;
}
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--dim); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
tbody tr:last-child td { border-bottom: none; }

.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.dot-ok { background: var(--ok); }
.dot-warn { background: var(--warn); }
.dot-bad { background: var(--bad); }
.dot-idle { background: var(--dim); }

.state-running { color: var(--ok); }
.state-other { color: var(--dim); }

td.endpoints a { color: var(--accent); text-decoration: none; margin-right: 10px; }
td.endpoints a:hover { text-decoration: underline; }

.foot { color: var(--dim); font-size: 12px; margin-top: 20px; }
```

- [ ] **Step 7: Create `public/app.js`**

```js
import { fmtBytes, fmtDuration, fmtPct, fmtRelTime } from "/format.js";

const REFRESH_MS = 30_000;
const $ = (id) => document.getElementById(id);

function card(k, v, note) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="k"></div><div class="v"></div><div class="note"></div>`;
  el.querySelector(".k").textContent = k;
  el.querySelector(".v").textContent = v;
  el.querySelector(".note").textContent = note || "";
  return el;
}

function healthDot(health, state) {
  if (state !== "running") return `<span class="dot dot-idle"></span>${state}`;
  if (health === "healthy") return `<span class="dot dot-ok"></span>healthy`;
  if (health === "unhealthy") return `<span class="dot dot-bad"></span>unhealthy`;
  if (health === "starting") return `<span class="dot dot-warn"></span>starting`;
  return `<span class="dot dot-ok"></span>—`;
}

function renderHost(host) {
  const cards = $("host-cards");
  cards.replaceChildren();
  if (!host) return;
  cards.append(
    card("Containers", `${host.containersRunning} up`, `${host.containersStopped} stopped`),
    card("CPU", fmtPct(host.totalCpuPct), `${host.arch} · ${host.containersRunning} running`),
    card("Memory", fmtBytes(host.totalMemUsedBytes), `of ${fmtBytes(host.memLimitBytes)}`),
    card("Docker disk", fmtBytes(host.diskUsedBytes), "images + containers + volumes"),
    card("Engine uptime", fmtDuration(host.engineUptimeSecs), `Docker ${host.dockerVersion}`),
  );
  $("host-sub").textContent = `${host.os} · ${host.arch} · storage: ${host.storageDriver}`;
}

function renderRows(containers) {
  const tbody = $("container-rows");
  tbody.replaceChildren();
  for (const c of containers || []) {
    const tr = document.createElement("tr");
    const endpoints = (c.endpoints || [])
      .map((u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${u.replace(/^https?:\/\//, "")}</a>`)
      .join("");
    tr.innerHTML = `
      <td>${c.name}</td>
      <td class="${c.state === "running" ? "state-running" : "state-other"}">${c.state}</td>
      <td>${healthDot(c.health, c.state)}</td>
      <td>${fmtDuration(c.uptimeSecs)}</td>
      <td>${c.restartCount}</td>
      <td>${fmtPct(c.cpuPct)}</td>
      <td>${c.memUsedBytes === null ? "—" : fmtBytes(c.memUsedBytes)}</td>
      <td>${c.image}</td>
      <td class="endpoints">${endpoints || "<span class=\\"state-other\\">—</span>"}</td>`;
    tbody.append(tr);
  }
}

function renderFreshness(snap) {
  const b = $("freshness");
  if (!snap.host && snap.lastError) {
    b.className = "badge badge-down";
    b.textContent = `Cannot reach Docker — ${snap.lastError}`;
    return;
  }
  if (snap.lastError) {
    b.className = "badge badge-stale";
    b.textContent = `Data stale — last updated ${fmtRelTime(snap.lastUpdated)} (${snap.lastError})`;
    return;
  }
  b.className = "badge badge-live";
  b.textContent = `Live · updated ${fmtRelTime(snap.lastUpdated)} · refreshes every 30 s`;
}

async function tick() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const snap = await res.json();
    renderHost(snap.host);
    renderRows(snap.containers);
    renderFreshness(snap);
    $("foot").textContent = `${(snap.containers || []).length} containers · snapshot ${snap.lastUpdated ?? "—"}`;
  } catch (err) {
    const b = $("freshness");
    b.className = "badge badge-down";
    b.textContent = `Dashboard cannot reach its own API — ${err.message}`;
  }
}

tick();
setInterval(tick, REFRESH_MS);
```

- [ ] **Step 8: Re-run the server test now that `public/` exists**

Run: `node --test test/server.test.js`
Expected: PASS — all 3 tests (the `GET /` test now finds `index.html`).

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS — config, docker-client (or skipped), collector, poller, server, format.

- [ ] **Step 10: Commit**

```bash
git add public test/format.test.js
git commit -m "feat: dark dashboard page with 30s polling and stale/down states"
```

---

### Task 7: Entrypoint and graceful shutdown

**Files:**
- Create: `src/index.js`
- Test: `test/index.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `createDockerClient` (Task 2), `collect` (Task 3), `createPoller` (Task 4), `createApp` (Task 5).
- Produces — `startServer({ env = process.env } = {}) -> Promise<{ server, poller, close() }>`:
  - builds config, client, a poller whose `collectFn` is `() => collect(client, config)`, starts the poller, creates the app, listens on `config.port`.
  - `close()` stops the poller and closes the HTTP server (returns a promise).
  - When run as the main module (`import.meta.url` is the process entry), it calls `startServer()` and wires `SIGTERM`/`SIGINT` to `close()` then `process.exit(0)`. It logs the listening URL.

- [ ] **Step 1: Write the failing test** — `test/index.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/index.js";

test("startServer boots on an ephemeral port and serves /api/health", async () => {
  const { server, close } = await startServer({
    env: { PORT: "0", DOCKER_SOCKET: "/nonexistent/docker.sock", POLL_INTERVAL_MS: "60000" },
  });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.deepEqual(await res.json(), { status: "ok" });
  } finally {
    await close();
  }
});

test("with Docker unreachable, /api/status reports down rather than crashing", async () => {
  const { server, close } = await startServer({
    env: { PORT: "0", DOCKER_SOCKET: "/nonexistent/docker.sock", POLL_INTERVAL_MS: "60000" },
  });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);
    const snap = await res.json();
    assert.equal(snap.host, null);
    assert.ok(snap.lastError, "expected a lastError message");
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/index.test.js`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement `src/index.js`**

```js
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { createDockerClient } from "./docker-client.js";
import { collect } from "./collector.js";
import { createPoller } from "./poller.js";
import { createApp } from "./server.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export async function startServer({ env = process.env } = {}) {
  const config = loadConfig(env);
  const client = createDockerClient({ socketPath: config.dockerSocket });
  const poller = createPoller({
    collectFn: () => collect(client, config),
    intervalMs: config.pollIntervalMs,
  });
  await poller.start();

  const app = createApp({ poller, publicDir });
  const server = await new Promise((resolve) => {
    const s = app.listen(config.port, () => resolve(s));
  });

  async function close() {
    poller.stop();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, poller, close };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer()
    .then(({ server, close }) => {
      const { port } = server.address();
      console.log(`[container-dashboard] listening on http://0.0.0.0:${port}`);
      for (const sig of ["SIGTERM", "SIGINT"]) {
        process.on(sig, () => {
          console.log(`[container-dashboard] ${sig} received, shutting down`);
          close().then(() => process.exit(0));
        });
      }
    })
    .catch((err) => {
      console.error(`[container-dashboard] failed to start: ${err.stack || err}`);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/index.test.js`
Expected: PASS — 2 tests. (The poller's first `collect` fails against the fake socket path; the poller swallows it and `getSnapshot()` returns the empty-with-error object. No unhandled rejection.)

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS across all test files.

- [ ] **Step 6: Manual smoke test against real Docker (only on a machine with Docker)**

Run: `DASHBOARD_HOST=localhost npm start`
Then open `http://localhost:9000`. Expected: host cards populate, the container table lists `wall-display`, `adguardhome`, `portainer` (running) and any stopped ones, endpoint links render for published ports, the badge says "Live". Stop with Ctrl-C; expect the "shutting down" log line.

- [ ] **Step 7: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: entrypoint wiring with graceful shutdown"
```

---

### Task 8: Container image, compose file, README

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: `npm start` (Task 1 script), `PORT`/`DASHBOARD_HOST`/`POLL_INTERVAL_MS`/`DOCKER_SOCKET` (Task 1).
- Produces: a runnable image; `docker compose config` validates.

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
EXPOSE 9000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  container-dashboard:
    build: .
    image: ghcr.io/mtnhmmr/container-dashboard:latest
    container_name: container-dashboard
    restart: unless-stopped
    ports:
      - "9000:9000"
    environment:
      PORT: "9000"
      DASHBOARD_HOST: "${DASHBOARD_HOST:-localhost}"
      POLL_INTERVAL_MS: "30000"
      DOCKER_SOCKET: "/var/run/docker.sock"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

- [ ] **Step 3: Validate the compose file**

Run: `docker compose config`
Expected: prints the resolved config with no error. (Skip if Docker is not installed on this machine; CI covers the build.)

- [ ] **Step 4: Build the image locally (only where Docker is available)**

Run: `docker build -t container-dashboard:dev .`
Expected: build succeeds through all stages.

- [ ] **Step 5: Create `README.md`**

````markdown
# Container Dashboard

Live dashboard for the Docker containers on a single host — the container-world
equivalent of a VPS status page. One small Node/Express service reads the Docker
Engine API over the mounted socket, polls every 30 seconds, and serves a dark
dashboard that refreshes on the same cadence.

**Origin computer:** HomeLab.

## Run locally

```bash
npm install
npm start
# open http://localhost:9000
```

Requires Node 24+ and a reachable Docker socket at `/var/run/docker.sock`
(override with `DOCKER_SOCKET`).

## Configuration

| Env var            | Default                   | Purpose                                            |
| ------------------ | ------------------------- | ------------------------------------------------- |
| `PORT`             | `9000`                    | Port the dashboard listens on                     |
| `DASHBOARD_HOST`   | `localhost`               | Hostname used to build container endpoint links   |
| `POLL_INTERVAL_MS` | `30000`                   | Docker collection interval                        |
| `DOCKER_SOCKET`    | `/var/run/docker.sock`    | Path to the Docker Engine API socket              |

Endpoint links are always `http://` — the dashboard cannot tell which published
ports terminate TLS. Adjust in the browser if a service is HTTPS-only.

## Deploy on the HomeLab

### Option A — Portainer stack / compose (build on host)

```bash
git clone https://github.com/MTNHMMR/container-dashboard.git
cd container-dashboard
DASHBOARD_HOST=homelab docker compose up -d --build
```

### Option B — pull the CI-built image

The GitHub Actions workflow publishes `ghcr.io/mtnhmmr/container-dashboard:latest`
on every push to `main`. In the Portainer stack, remove the `build: .` line and
keep the `image:` line, then **Pull and redeploy**.

The container mounts the Docker socket **read-only**. It only ever issues `GET`
requests to the Docker API.

## Tests

```bash
npm test
```

`node --test` only. The `docker-client` test binds a throwaway HTTP server to a
Unix socket and is skipped automatically on platforms that disallow that (e.g.
Windows); CI runs on Linux where it executes.

## What it shows

- Host cards: running/stopped counts, host CPU %, memory used, Docker disk usage, engine uptime
- Per container: state, health, uptime, restart count, live CPU %, live memory, image, clickable published endpoints
- An amber "data stale" badge (last good snapshot kept) if a collection cycle fails, or a red "cannot reach Docker" state if it has never succeeded

## Not in v1

Logs, historical charts, image-update checks, authentication, and a
failover/uptime-history page (a separate project).
````

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml README.md
git commit -m "chore: container image, compose file, and README"
```

---

### Task 9: GitHub Actions CI/CD

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm ci`, `npm test`, `Dockerfile`.
- Produces: on push/PR — a test run on Linux; on push to `main` — a multi-stage `docker build` and a push of `ghcr.io/<owner>/container-dashboard:latest` + `:${{ github.sha }}`.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: "npm"
      - run: npm ci
      - run: npm test

  image:
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        run: echo "repo=${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ steps.meta.outputs.repo }}:latest
            ghcr.io/${{ steps.meta.outputs.repo }}:${{ github.sha }}
```

- [ ] **Step 2: Lint the workflow locally (best-effort)**

Run: `node -e "const y=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/npm test/.test(y)) throw new Error('missing test step'); console.log('workflow references npm test')"`
Expected: prints the confirmation line.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: test on PR, build and push image to ghcr on main"
```

- [ ] **Step 4: Push and open a PR (Justin runs this — the tool cannot push)**

```bash
git remote add origin https://github.com/MTNHMMR/container-dashboard.git
git push -u origin main
```

Expected: the `test` job passes on GitHub; on `main`, the `image` job publishes `ghcr.io/mtnhmmr/container-dashboard:latest`.

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
| --- | --- |
| Node/Express app, its own container, socket, 30s poll, in-memory cache | Tasks 4, 5, 7, 8 |
| `GET /` dashboard HTML | Tasks 5, 6 |
| `GET /api/status` JSON snapshot | Task 5 |
| Host cards: running/stopped, total CPU %, total mem, Docker disk, engine uptime | Task 3 (`buildSnapshot`), Task 6 (render) |
| Docker engine info panel (version, OS, arch, counts, storage driver) | Task 3, Task 6 (`host-sub` + cards) |
| Per-container: name, state, health, uptime, restart count, image, ports, CPU %, mem | Task 3, Task 6 |
| Published endpoint links from port maps | Task 3 (`endpointsFor`), Task 6 |
| `DASHBOARD_HOST` env for endpoint host | Tasks 1, 3 |
| `PORT` (9000), `POLL_INTERVAL_MS` (30000), `DOCKER_SOCKET` config | Task 1 |
| Auto-refresh every 30s | Task 6 (`REFRESH_MS`) |
| Stale badge, last-good snapshot kept on error | Task 4 (poller), Task 6 (`renderFreshness`) |
| Single container stats failure → row shows `—`, rest unaffected | Task 3 (`collect` allSettled + `memFromStats`/`cpuPctFromStats` null-guards), tested |
| First-ever poll fails → "Cannot reach Docker" message, not blank | Task 4 (empty-with-error snapshot), Task 6 (`badge-down`), Task 7 test |
| Unit tests for collector with recorded fixtures (CPU math, uptime, endpoint URLs, counts, missing-stats fallback) | Task 3 |
| Integration test booting server against a mock client | Tasks 5, 7 |
| No live Docker in CI | Task 9 (`npm test` only; docker-client test self-skips) |
| Dockerfile + docker-compose with socket mount + env | Task 8 |
| GitHub Actions build/publish on push | Task 9 |
| Out of scope: logs, history, image-update checks, auth, failover page | Not implemented (README "Not in v1") |

No gaps.

**2. Placeholder scan**

No "TBD"/"TODO"/"handle edge cases"/"similar to Task N". Every code step has real code. The two known cross-task ordering notes (server `GET /` test in Task 5 depends on Task 6; push step in Task 9 is Justin's) are called out explicitly, not left implicit.

**3. Type consistency**

- `Snapshot` shape defined once in Task 3, consumed unchanged in Tasks 4 (`getSnapshot` spreads it, adds `lastError`), 5 (serialised as-is), 6 (`renderHost`/`renderRows`/`renderFreshness` read exactly those fields), 7 (asserts `snap.host === null` + `snap.lastError`).
- `engineUptimeSecs` — used consistently (not `engineUptime`); `fmtDuration(host.engineUptimeSecs)` in Task 6 matches.
- `createDockerClient({ socketPath })` — Task 2 defines, Task 7 calls with `{ socketPath: config.dockerSocket }`. Match.
- `createPoller({ collectFn, intervalMs, logger })` — Task 4 defines, Task 7 calls with `collectFn`/`intervalMs`. Match.
- `createApp({ poller, publicDir })` — Task 5 defines, Tasks 5/7 tests and Task 7 call with the same keys. Match.
- `collect(client, config, now)` reads only `config.dashboardHost`; Task 7 passes the full config object — compatible.
- Formatters `fmtBytes/fmtDuration/fmtPct/fmtRelTime` — same names in `public/format.js`, `test/format.test.js`, and `public/app.js` import.

Consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-08-container-dashboard.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
