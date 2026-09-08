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
