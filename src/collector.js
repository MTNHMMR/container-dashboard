const SECOND = 1000;

function shortId(id) {
  return String(id).slice(0, 12);
}

function stripName(names) {
  const n = Array.isArray(names) ? names[0] : names;
  return String(n || "").replace(/^\//, "");
}

function cpuPctFromStats(st) {
  if (!st || !st.cpu_stats || !st.precpu_stats) return null;
  const cpuDelta =
    (st.cpu_stats.cpu_usage?.total_usage ?? 0) - (st.precpu_stats.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (st.cpu_stats.system_cpu_usage ?? 0) - (st.precpu_stats.system_cpu_usage ?? 0);
  const onlineCPUs =
    st.cpu_stats.online_cpus || st.cpu_stats.cpu_usage?.percpu_usage?.length || 1;
  if (systemDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * onlineCPUs * 100;
}

function memFromStats(st) {
  if (!st || !st.memory_stats || typeof st.memory_stats.usage !== "number") {
    return { memUsedBytes: null, memPct: null };
  }
  const cache = st.memory_stats.stats?.cache ?? 0;
  const used = st.memory_stats.usage - cache;
  const limit = st.memory_stats.limit || 0;
  return { memUsedBytes: used, memPct: limit > 0 ? (used / limit) * 100 : null };
}

function diskUsed(df) {
  const images = (df.Images || []).reduce((a, i) => a + (i.Size || 0), 0);
  const containers = (df.Containers || []).reduce((a, c) => a + (c.SizeRw || 0), 0);
  const volumes = (df.Volumes || []).reduce((a, v) => a + (v.UsageData?.Size || 0), 0);
  const buildCache = (df.BuildCache || []).reduce((a, b) => a + (b.Size || 0), 0);
  return images + containers + volumes + buildCache;
}

function endpointsFor(ports, host) {
  const seen = new Set();
  for (const p of ports || []) {
    if (p.Type === "tcp" && p.PublicPort) seen.add(p.PublicPort);
  }
  return [...seen].sort((a, b) => a - b).map((port) => `http://${host}:${port}`);
}

function normalizePorts(ports) {
  return (ports || []).map((p) => ({
    ip: p.IP ?? null,
    privatePort: p.PrivatePort,
    publicPort: p.PublicPort ?? null,
    type: p.Type,
  }));
}

export function buildSnapshot({ info, df, containers, inspects, stats, now, dashboardHost }) {
  const nowMs = now.getTime();
  let earliestStart = null;

  const rows = containers.map((c) => {
    const insp = inspects.get(c.Id) || {};
    const st = stats.get(c.Id) || null;
    const running = (c.State || insp.State?.Status) === "running";
    const startedAtRaw = insp.State?.StartedAt || null;
    const startedMs = startedAtRaw ? Date.parse(startedAtRaw) : NaN;
    const validStart = running && Number.isFinite(startedMs) && startedMs > 0;
    if (validStart && (earliestStart === null || startedMs < earliestStart)) {
      earliestStart = startedMs;
    }
    const { memUsedBytes, memPct } = running ? memFromStats(st) : { memUsedBytes: null, memPct: null };
    return {
      id: shortId(c.Id),
      name: stripName(c.Names),
      image: c.Image || insp.Config?.Image || "",
      state: c.State || insp.State?.Status || "unknown",
      health: insp.State?.Health?.Status ?? null,
      startedAt: validStart ? new Date(startedMs).toISOString() : null,
      uptimeSecs: validStart ? Math.floor((nowMs - startedMs) / SECOND) : null,
      restartCount: insp.RestartCount ?? 0,
      ports: normalizePorts(c.Ports),
      endpoints: running ? endpointsFor(c.Ports, dashboardHost) : [],
      cpuPct: running ? cpuPctFromStats(st) : null,
      memUsedBytes,
      memPct,
    };
  });

  rows.sort((a, b) => {
    const ar = a.state === "running" ? 0 : 1;
    const br = b.state === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });

  const totalCpuPct =
    rows.reduce((a, r) => a + (r.cpuPct || 0), 0) / (info.NCPU || 1);
  const totalMemUsedBytes = rows.reduce((a, r) => a + (r.memUsedBytes || 0), 0);

  return {
    host: {
      dockerVersion: info.ServerVersion || "unknown",
      os: info.OperatingSystem || "unknown",
      arch: info.Architecture || "unknown",
      containersRunning: info.ContainersRunning ?? rows.filter((r) => r.state === "running").length,
      containersStopped: info.ContainersStopped ?? rows.filter((r) => r.state !== "running").length,
      imagesCount: info.Images ?? 0,
      storageDriver: info.Driver || "unknown",
      diskUsedBytes: diskUsed(df),
      diskTotalBytes: null,
      totalCpuPct,
      totalMemUsedBytes,
      memLimitBytes: info.MemTotal ?? 0,
      engineUptimeSecs: earliestStart === null ? null : Math.floor((nowMs - earliestStart) / SECOND),
    },
    containers: rows,
    lastUpdated: now.toISOString(),
    lastError: null,
  };
}

export async function collect(client, config, now = new Date()) {
  const [info, df, containers] = await Promise.all([
    client.info(),
    client.df(),
    client.listContainers(),
  ]);

  const inspects = new Map();
  const stats = new Map();

  const inspectResults = await Promise.allSettled(
    containers.map((c) => client.inspect(c.Id).then((r) => [c.Id, r]))
  );
  for (const r of inspectResults) {
    if (r.status === "fulfilled" && r.value) inspects.set(r.value[0], r.value[1]);
  }

  const runningIds = containers
    .filter((c) => (c.State || inspects.get(c.Id)?.State?.Status) === "running")
    .map((c) => c.Id);
  const statResults = await Promise.allSettled(
    runningIds.map((id) => client.stats(id).then((r) => [id, r]))
  );
  for (const r of statResults) {
    if (r.status === "fulfilled" && r.value) stats.set(r.value[0], r.value[1]);
  }

  return buildSnapshot({
    info,
    df,
    containers,
    inspects,
    stats,
    now,
    dashboardHost: config.dashboardHost,
  });
}
