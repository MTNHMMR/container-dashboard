import express from "express";

export function createApp({ poller, publicDir }) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(poller.getSnapshot());
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(express.static(publicDir, { extensions: ["html"] }));

  return app;
}
