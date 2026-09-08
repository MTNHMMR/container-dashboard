const MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Escape a value for safe interpolation into an HTML string.
// Non-string input is coerced; null/undefined become "".
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => MAP[ch]);
}

// True when a URL is an absolute http(s) URL — safe to use as an <a href>.
// Rejects javascript:, data:, relative refs and anything unparseable.
export function isHttpUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
