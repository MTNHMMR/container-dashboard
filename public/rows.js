import { esc, isHttpUrl } from "./escape.js";
import { fmtBytes, fmtDuration, fmtPct } from "./format.js";

// Pure string -> string helpers for the container table. No DOM, no side effects.

export function healthDot(health, state) {
  if (state !== "running") return `<span class="dot dot-idle"></span>${esc(state)}`;
  if (health === "healthy") return `<span class="dot dot-ok"></span>healthy`;
  if (health === "unhealthy") return `<span class="dot dot-bad"></span>unhealthy`;
  if (health === "starting") return `<span class="dot dot-warn"></span>starting`;
  return `<span class="dot dot-ok"></span>—`;
}

function endpointsHtml(endpoints) {
  return (endpoints || [])
    .map((u) => {
      const text = esc(String(u).replace(/^https?:\/\//, ""));
      return isHttpUrl(u)
        ? `<a href="${esc(u)}" target="_blank" rel="noreferrer noopener">${text}</a>`
        : text;
    })
    .join("");
}

export function rowHtml(c) {
  const endpoints = endpointsHtml(c.endpoints);
  return `<tr>
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
