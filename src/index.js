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
    await new Promise((resolve) => {
      server.close(resolve);
      // Keep-alive clients (e.g. a browser polling /api/status) would otherwise
      // hold the connection open and prevent server.close() from ever resolving.
      server.closeAllConnections();
    });
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
