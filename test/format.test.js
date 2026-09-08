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
