export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const kib = n / 1024;
  if (kib < 1024) return `${Math.round(kib)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}

export function fmtDuration(secs) {
  if (secs === null || secs === undefined || Number.isNaN(secs)) return "—";
  const s = Math.floor(secs);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d && m) parts.push(`${m}m`);
  if (!d && !h && sec) parts.push(`${sec}s`);
  if (parts.length === 0) parts.push("0s");
  return parts.slice(0, 2).join(" ");
}

export function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

export function fmtRelTime(iso, now = new Date()) {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never";
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}
