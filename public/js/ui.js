// Shared rendering helpers used by every page module.
import { FIELD_MAP, CLOSED_STATUSES, isOverdue } from "./fields.js";

export const app = document.getElementById("app");
export const modalRoot = document.getElementById("modal-root");
const toastRoot = document.getElementById("toast-root");

/* ---------------------------------------------------------------- helpers */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
export const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
export const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label ?? value)}</option>`;
export const badge = (text, kind = slug(text)) => `<span class="badge b-${kind}">${esc(text)}</span>`;

export function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast t-${kind}`;
  el.textContent = msg;
  toastRoot.appendChild(el);
  setTimeout(() => el.classList.add("out"), 3600);
  setTimeout(() => el.remove(), 4000);
}

export async function guard(fn, okMsg) {
  try {
    const out = await fn();
    if (okMsg) toast(okMsg);
    return out;
  } catch (e) {
    console.error(e);
    toast(e.message || "Something went wrong", "err");
    return undefined;
  }
}

export const ICONS = {
  dashboard: '<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>',
  requests: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  new: '<path d="M12 5v14M5 12h14"/>',
  approvals: '<path d="M20 6 9 17l-5-5"/>',
  actions: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  builder: '<path d="M3 3h18v18H3zM3 9h18M9 21V9"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
  inventory: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  import: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  out: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  userplus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>',
  pin: '<path d="M12 17v5M5 17h14l-2-4V5H7v8z"/>',
};
export const icon = (name, cls = "ico") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/* ---------------------------------------------------------------- tables */
export function cellHTML(key, row) {
  const v = row[key];
  if (key === "status") return badge(v);
  if (key === "priority") return v === "Normal" ? esc(v) : badge(v, `p-${slug(v)}`);
  if (key === "needed_by") return `<span class="${isOverdue(row) ? "overdue" : ""}">${esc(fmtDate(v))}</span>`;
  if (FIELD_MAP[key]?.type === "date") return esc(fmtDate(v));
  if (key === "ticket") return `<strong class="mono">${esc(v)}</strong>`;
  if (key === "days_until_due" && v !== "" && !CLOSED_STATUSES.includes(row.status)) return `<span class="${v < 0 ? "overdue" : ""}">${esc(v)}</span>`;
  return esc(v);
}

export function tableHTML(columns, rows, { groupBy = "none", limit = 0, empty = "Nothing here yet." } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const shown = limit ? rows.slice(0, limit) : rows;
  let lastGroup = null;
  const body = shown.map((row) => {
    let head = "";
    if (groupBy !== "none" && row[groupBy] !== lastGroup) {
      lastGroup = row[groupBy];
      const n = rows.filter((r) => r[groupBy] === lastGroup).length;
      head = `<tr class="group"><td colspan="${columns.length}">${esc(FIELD_MAP[groupBy].label)}: <strong>${esc(lastGroup === "" ? "(blank)" : FIELD_MAP[groupBy].type === "date" ? fmtDate(lastGroup) : lastGroup)}</strong> <span class="muted">· ${n}</span></td></tr>`;
    }
    return head + `<tr class="click" data-act="open-request" data-id="${esc(row._raw.id)}">${columns.map((c) => `<td data-label="${esc(c.label)}">${cellHTML(c.key, row)}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="grid">
    <thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${body}</tbody></table></div>
    ${limit && rows.length > limit ? `<p class="muted small more">Showing ${limit} of ${rows.length}</p>` : ""}`;
}

export const initials = (name) => String(name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

// Escapes for use inside a CSS attribute selector.
export const cssId = (id) => (window.CSS?.escape ? CSS.escape(id) : String(id).replace(/"/g, '\\"'));

export function openModal(html, { wide = false } = {}) {
  modalRoot.innerHTML = `<div class="modal-bg" data-act="close-modal"><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" data-stop>${html}</div></div>`;
  modalRoot.querySelector("input:not([type=hidden]), select, textarea")?.focus();
}
