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
