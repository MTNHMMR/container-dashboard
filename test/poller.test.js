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

test("overlapping ticks don't stack: a slow in-flight tick blocks a concurrent one", async () => {
  let calls = 0;
  const gates = [];
  const poller = createPoller({
    collectFn: () => {
      calls += 1;
      return new Promise((resolve) => gates.push(resolve));
    },
    intervalMs: 10_000,
    logger: silent,
  });

  const p1 = poller._tickOnceForTest(); // collect #1 starts, stays pending
  assert.equal(calls, 1);

  const p2 = poller._tickOnceForTest(); // interval "fires again" while #1 in flight
  await p2;
  assert.equal(calls, 1, "the concurrent tick must not start a second collect");

  gates[0](okSnap(1)); // let the slow first collect finish
  await p1;
  assert.equal(poller.getSnapshot().lastUpdated, "t1");

  const p3 = poller._tickOnceForTest(); // a fresh, non-overlapping tick runs normally
  assert.equal(calls, 2);
  gates[1](okSnap(2));
  await p3;
  assert.equal(poller.getSnapshot().lastUpdated, "t2", "the newer result wins, not clobbered by the stale one");

  poller.stop();
});

test("start() twice without stop() does not leak a second interval", async () => {
  let calls = 0;
  const poller = createPoller({
    collectFn: async () => okSnap(++calls),
    intervalMs: 10_000,
    logger: silent,
  });
  await poller.start();
  await poller.start(); // second call hits the `if (timer) return` guard
  assert.equal(calls, 1, "the second start() is a no-op and does not stack another interval");
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
