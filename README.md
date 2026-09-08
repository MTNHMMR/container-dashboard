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
