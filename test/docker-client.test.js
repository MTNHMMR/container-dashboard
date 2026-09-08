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

async function withFakeDaemon(handler, run) {
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
  const result = await withFakeDaemon(
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
  const result = await withFakeDaemon(
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

test("getJson rejects with a timeout error when the daemon accepts but never responds", async (t) => {
  const result = await withFakeDaemon(
    () => { /* accept the request, never write a response */ },
    async (socketPath) => {
      const client = createDockerClient({ socketPath, timeoutMs: 150 });
      const started = Date.now();
      return client.getJson("/info").then(
        () => ({ threw: false }),
        (err) => ({ threw: true, message: err.message, elapsed: Date.now() - started })
      );
    }
  );
  if (result?.skipped) return t.skip(result.reason);
  assert.equal(result.threw, true);
  assert.match(result.message, /timed out/);
  assert.ok(result.elapsed < 5000, `expected a bounded wait, got ${result.elapsed}ms`);
});

test("listContainers requests all containers", async (t) => {
  const result = await withFakeDaemon(
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
