import { fmtBytes, fmtDuration, fmtPct, fmtRelTime } from "/format.js";
import { rowHtml } from "/rows.js";

const REFRESH_MS = 30_000;
const $ = (id) => document.getElementById(id);

function card(k, v, note) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="k"></div><div class="v"></div><div class="note"></div>`;
  el.querySelector(".k").textContent = k;
  el.querySelector(".v").textContent = v;
  el.querySelector(".note").textContent = note || "";
  return el;
}

function renderHost(host) {
  const cards = $("host-cards");
  cards.replaceChildren();
  if (!host) return;
  cards.append(
    card("Containers", `${host.containersRunning} up`, `${host.containersStopped} stopped`),
    card("CPU", fmtPct(host.totalCpuPct), `${host.arch} · ${host.containersRunning} running`),
    card("Memory", fmtBytes(host.totalMemUsedBytes), `across ${host.containersRunning} running`),
    card("Docker disk", fmtBytes(host.diskUsedBytes), "images + containers + volumes"),
    card("Engine uptime", fmtDuration(host.engineUptimeSecs), `Docker ${host.dockerVersion}`),
  );
  $("host-sub").textContent =
    `${host.os} · ${host.arch} · ${fmtBytes(host.memLimitBytes)} RAM · storage: ${host.storageDriver}`;
}

function renderRows(containers) {
  const tbody = $("container-rows");
  tbody.innerHTML = (containers || []).map(rowHtml).join("");
}

function renderFreshness(snap) {
  const b = $("freshness");
  if (!snap.host && snap.lastError) {
    b.className = "badge badge-down";
    b.textContent = `Cannot reach Docker — ${snap.lastError}`;
    return;
  }
  if (snap.lastError) {
    b.className = "badge badge-stale";
    b.textContent = `Data stale — last updated ${fmtRelTime(snap.lastUpdated)} (${snap.lastError})`;
    return;
  }
  b.className = "badge badge-live";
  b.textContent = `Live · updated ${fmtRelTime(snap.lastUpdated)} · refreshes every 30 s`;
}

async function tick() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const snap = await res.json();
    renderHost(snap.host);
    renderRows(snap.containers);
    renderFreshness(snap);
    $("foot").textContent = `${(snap.containers || []).length} containers · snapshot ${snap.lastUpdated ?? "—"}`;
  } catch (err) {
    const b = $("freshness");
    b.className = "badge badge-down";
    b.textContent = `Dashboard cannot reach its own API — ${err.message}`;
  }
}

tick();
setInterval(tick, REFRESH_MS);
