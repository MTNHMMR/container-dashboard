# Container Dashboard — Design (v1)

**Date:** 2026-09-08
**Origin computer:** HomeLab
**Repo:** `A:\Project\container-dashboard` → GitHub `container-dashboard`
**Owner:** lordkay@gmail.com
**Status:** Design approved, pending implementation plan

## Purpose

A live, always-on web dashboard for the Docker containers running on the
HomeLab host — the container-world equivalent of the SEMO Web Co "VPS Status"
page. Shows host-level Docker health plus a per-container table, auto-refreshing
every 30 seconds.

A separate failover/health-history page (the analog of the SEMO "Failover
status" page) is explicitly **out of scope** and will be its own project.

## Scope (v1)

In:

- Host cards: running/stopped container count, total CPU %, total memory used,
  Docker disk usage, engine uptime (derived from the earliest `StartedAt` among
  running containers when the API exposes no direct value)
- Docker engine info panel: version, OS, arch, total containers/images, storage
  driver
- Per-container rows: name, state, health, uptime, restart count, image,
  published ports, live CPU %, live memory
- Published endpoints: clickable links built from each container's port mappings
- Auto-refresh every 30s; stale-data badge on collection failure

Out:

- Log viewing
- Historical charts / sparklines
- Image update-available checks
- Authentication
- Failover / uptime-history page (separate project)

## Architecture

A single small Node app (Express, no heavier framework) running as its own
container on HomeLab. It reads the Docker Engine API through the mounted socket,
polls every 30s, caches the latest result in memory, and serves:

- `GET /` — dashboard HTML/CSS/JS (dark theme matching the SEMO pages)
- `GET /api/status` — JSON snapshot the page fetches on its 30s refresh

Socket mount:

- Linux host: `/var/run/docker.sock:/var/run/docker.sock:ro`
- Windows host: `//./pipe/docker_engine` mapped via compose

Read-only socket access. No database. No auth in v1.

## Components

| Unit | Purpose | Depends on |
|---|---|---|
| `docker-client.js` | Thin wrapper over the Docker socket. One function per endpoint: `listContainers()`, `containerStats(id)`, `df()`, `info()`, `version()`. Returns plain objects, no formatting. | `dockerode` or raw HTTP over socket |
| `collector.js` | Calls the client, computes derived values (CPU % from stats deltas, mem used, uptime from `State.StartedAt`, running/stopped counts, endpoint URLs from port maps). Produces one `Snapshot`. | `docker-client.js` |
| `poller.js` | Runs `collector` every 30s; holds latest `Snapshot` + `lastUpdated` + `lastError` in memory. | `collector.js` |
| `server.js` | Express. `/` serves static assets; `/api/status` returns `poller.getSnapshot()`. | `poller.js` |
| `public/` | `index.html`, `style.css`, `app.js` — renders the snapshot, re-fetches `/api/status` every 30s, shows a stale badge when `lastError` is set. | none (vanilla JS) |

## Data model — `Snapshot`

The single shared interface between collector, poller, server, and page:

```
{
  host: {
    dockerVersion, os, arch,
    containersRunning, containersStopped,
    imagesCount, storageDriver,
    diskUsedBytes, diskTotalBytes,
    totalCpuPct, totalMemUsedBytes, memLimitBytes,
    engineUptime
  },
  containers: [
    {
      id, name, image, state, health,
      startedAt, uptimeSecs, restartCount,
      ports: [ { ip, privatePort, publicPort, type } ],
      endpoints: [ "http://HOST:3000" ],
      cpuPct, memUsedBytes, memPct
    }
  ],
  lastUpdated,
  lastError
}
```

`HOST` in endpoint URLs comes from config env var `DASHBOARD_HOST`
(default `localhost`) so links resolve from wherever the page is viewed.

## Configuration (env vars)

- `DASHBOARD_HOST` — hostname/IP used to build container endpoint links. Default `localhost`.
- `PORT` — port the dashboard listens on. Default `9000`.
- `POLL_INTERVAL_MS` — collection interval. Default `30000`.

## Data flow

1. `poller` fires on an interval → calls `collector.collect()`.
2. `collector` calls `docker-client` for `info`, `version`, `df`, `listContainers`,
   and `containerStats` per running container.
3. `collector` computes derived fields and returns a `Snapshot`.
4. `poller` stores it as the current snapshot with `lastUpdated = now`,
   clears `lastError` on success.
5. Browser loads `/`, then every 30s fetches `/api/status` and re-renders.

## Error handling

- Socket unreachable / API error → keep serving the **last good snapshot**, set
  `lastError`; page shows an amber "Data stale — last updated HH:MM" badge.
- A single container's stats call failing → that row shows `—` for CPU/mem; the
  rest of the dashboard is unaffected.
- First-ever poll fails (no prior snapshot) → page renders with a clear
  "Cannot reach Docker" message instead of blank cards.

## Testing

- Unit tests (`node:test`) for `collector.js` against **recorded Docker API
  fixtures**: CPU % math, uptime derivation, endpoint-URL building, running/
  stopped counts, missing-stats fallback.
- One integration test that boots `server.js` against a mock `docker-client` and
  asserts `/api/status` returns a well-formed `Snapshot`.
- No live Docker daemon required in CI.

## Deployment

- `Dockerfile` (node:24-slim base) and `docker-compose.yml` with the socket
  mount and env vars.
- GitHub Actions workflow on push to `main`: run tests, build the image, publish
  to GitHub Container Registry (`ghcr.io`).
- On HomeLab: `docker compose pull && docker compose up -d` (or build locally
  from the repo) when an update is wanted.

## Known follow-ups (not v1)

- Failover / uptime-history page (separate project)
- Log tailing per container
- Historical CPU/mem sparklines
- Image update-available badges
- Optional auth if exposed beyond the LAN
