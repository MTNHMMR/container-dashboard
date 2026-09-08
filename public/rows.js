import { esc, isHttpUrl } from "./escape.js";
import { fmtBytes, fmtDuration, fmtPct } from "./format.js";

// Pure string -> string helpers for the container table. No DOM, no side effects.

// Lifetime restart count at or above which a running container gets a soft flag.
const RESTART_WARN = 5;

export function healthDot(health, state) {
  if (state !== "running") return `<span class="dot dot-idle"></span>${esc(state)}`;
  if (health === "healthy") return `<span class="dot dot-ok"></span>healthy`;
  if (health === "unhealthy") return `<span class="dot dot-bad"></span>unhealthy`;
  if (health === "starting") return `<span class="dot dot-warn"></span>starting`;
  return `<span class="dot dot-idle"></span>no check`;
}

// A collector endpoint is always "http://<host>:<port>"; show just ":<port>" as a chip.
function portLabel(u) {
  try {
    const url = new URL(u);
    return url.port ? `:${url.port}` : url.protocol.replace(":", "");
  } catch {
    return String(u);
  }
}

function endpointsHtml(endpoints) {
  return (endpoints || [])
    .map((u) => {
      const text = esc(portLabel(u));
      return isHttpUrl(u)
        ? `<a class="chip" href="${esc(u)}" target="_blank" rel="noreferrer noopener" title="${esc(u)}">${text}</a>`
        : `<span class="chip">${text}</span>`;
    })
    .join("");
}

function rowAttr(c) {
  if (c.state === "running" && c.health === "unhealthy") return ' class="row-bad"';
  if (c.state === "running" && Number(c.restartCount) >= RESTART_WARN) return ' class="row-warn"';
  return "";
}

export function rowHtml(c) {
  const endpoints = endpointsHtml(c.endpoints);
  return `<tr${rowAttr(c)}>
      <td>${esc(c.name)}</td>
      <td class="${c.state === "running" ? "state-running" : "state-other"}">${esc(c.state)}</td>
      <td>${healthDot(c.health, c.state)}</td>
      <td>${fmtDuration(c.uptimeSecs)}</td>
      <td>${esc(c.restartCount)}</td>
      <td>${fmtPct(c.cpuPct)}</td>
      <td>${c.memUsedBytes === null ? "—" : fmtBytes(c.memUsedBytes)}</td>
      <td class="image"><span title="${esc(c.image)}">${esc(c.image)}</span></td>
      <td class="endpoints">${endpoints || "<span class=\"state-other\">—</span>"}</td>
    </tr>`;
}
