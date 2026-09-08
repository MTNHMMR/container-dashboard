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

// Note: the "GET / serves the dashboard HTML" test lives in Task 6, because it
// depends on public/index.html, which Task 6 creates. Keep server.test.js to the
// two API assertions here so this task commits with a fully-passing suite.
