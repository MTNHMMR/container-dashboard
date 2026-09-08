import { fmtBytes, fmtDuration, fmtPct, fmtRelTime } from "/format.js";
import { esc, isHttpUrl } from "/escape.js";

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

function healthDot(health, state) {
  if (state !== "running") return `<span class="dot dot-idle"></span>${esc(state)}`;
  if (health === "healthy") return `<span class="dot dot-ok"></span>healthy`;
  if (health === "unhealthy") return `<span class="dot dot-bad"></span>unhealthy`;
  if (health === "starting") return `<span class="dot dot-warn"></span>starting`;
  return `<span class="dot dot-ok"></span>—`;
}

function renderHost(host) {
  const cards = $("host-cards");
  cards.replaceChildren();
  if (!host) return;
  cards.append(
    card("Containers", `${host.containersRunning} up`, `${host.containersStopped} stopped`),
    card("CPU", fmtPct(host.totalCpuPct), `${host.arch} · ${host.containersRunning} running`),
    card("Memory", fmtBytes(host.totalMemUsedBytes), `of ${fmtBytes(host.memLimitBytes)}`),
    card("Docker disk", fmtBytes(host.diskUsedBytes), "images + containers + volumes"),
    card("Engine uptime", fmtDuration(host.engineUptimeSecs), `Docker ${host.dockerVersion}`),
  );
  $("host-sub").textContent = `${host.os} · ${host.arch} · storage: ${host.storageDriver}`;
}

function renderRows(containers) {
  const tbody = $("container-rows");
  tbody.replaceChildren();
  for (const c of containers || []) {
    const tr = document.createElement("tr");
    const endpoints = (c.endpoints || [])
      .map((u) => {
        const text = esc(String(u).replace(/^https?:\/\//, ""));
        return isHttpUrl(u)
          ? `<a href="${esc(u)}" target="_blank" rel="noreferrer noopener">${text}</a>`
          : text;
      })
      .join("");
    tr.innerHTML = `
      <td>${esc(c.name)}</td>
      <td class="${c.state === "running" ? "state-running" : "state-other"}">${esc(c.state)}</td>
      <td>${healthDot(c.health, c.state)}</td>
      <td>${fmtDuration(c.uptimeSecs)}</td>
      <td>${c.restartCount}</td>
      <td>${fmtPct(c.cpuPct)}</td>
      <td>${c.memUsedBytes === null ? "—" : fmtBytes(c.memUsedBytes)}</td>
      <td>${esc(c.image)}</td>
      <td class="endpoints">${endpoints || "<span class=\"state-other\">—</span>"}</td>`;
    tbody.append(tr);
  }
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
