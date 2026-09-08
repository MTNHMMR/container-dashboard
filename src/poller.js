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
