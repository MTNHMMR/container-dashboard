import http from "node:http";

function getJson(socketPath, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: apiPath, method: "GET", headers: { Host: "docker" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Docker API ${apiPath} -> HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : null);
          } catch (err) {
            reject(new Error(`Docker API ${apiPath} -> invalid JSON: ${err.message}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(new Error(`Docker API ${apiPath} -> ${err.message}`)));
    req.end();
  });
}

export function createDockerClient({ socketPath }) {
  const call = (p) => getJson(socketPath, p);
  return {
    getJson: call,
    info: () => call("/info"),
    df: () => call("/system/df"),
    listContainers: () => call("/containers/json?all=true"),
    inspect: (id) => call(`/containers/${id}/json`),
    stats: (id) => call(`/containers/${id}/stats?stream=false`),
  };
}
