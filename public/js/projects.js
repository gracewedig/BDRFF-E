// Projects (resorts) → sub-projects → one sub-project. The first page after
// signing in; managers add projects and sub-projects here too.
import { store } from "./store.js";
import {
  PROJECTS, AREAS, CURRENT, SETTINGS, OPEN_STATUSES, STATUSES, FIELD_MAP, applySettings, subProjects, toRow, todayISO, isOverdue,
} from "./fields.js";
import { S, isManager, hooks } from "./state.js";
import { esc, slug, badge, toast, guard, icon, tableHTML } from "./ui.js";
import { isLow } from "./inventory.js";
import { filesListHTML } from "./files.js";

const enc = encodeURIComponent;
export const areaHref = (name) => `#/area/${enc(name)}`;

export function backLink(href, label) {
  return `<a class="back-link" href="${href}" data-tour="back">${icon("back")}<span>${esc(label)}</span></a>`;
}

function crumbs(parts) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.map(([label, href], i) =>
    href && i < parts.length - 1 ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`).join('<span class="sep">›</span>')}</nav>`;
}

/* ------------------------------------------------------- all projects */
function projectStats(name) {
  const sum = S.summary || { requests: [], inventory: [], emails: [] };
  const reqs = sum.requests.filter((r) => r.project === name);
  return {
    open: reqs.filter((r) => OPEN_STATUSES.includes(r.status)).length,
    pending: reqs.filter((r) => r.status === "Pending").length,
    overdue: reqs.filter((r) => isOverdue({ needed_by: (r.needed_by || "").slice(0, 10), status: r.status })).length,
    items: sum.inventory.filter((i) => i.project === name).length,
    emails: sum.emails.filter((e) => e.project === name).length,
  };
}

export function pageProjects() {
  const archived = SETTINGS.projects.filter((p) => p.archived);
  return `
  <p class="lead">Choose the project you're working on. You can switch any time from the menu.</p>
  <div class="resort-grid" data-tour="projects">
    ${PROJECTS.map((name) => {
      const st = projectStats(name);
      const subs = subProjects(name);
      return `<button class="resort-card ${CURRENT.project === name ? "current" : ""}" data-act="pick-project" data-project="${esc(name)}">
        <span class="resort-mark">${esc(name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase())}</span>
        <span class="resort-name">${esc(name)}</span>
        <span class="resort-subs">${subs.length ? `${subs.length} sub-project${subs.length === 1 ? "" : "s"}: ${esc(subs.slice(0, 5).join(", "))}${subs.length > 5 ? "…" : ""}` : "No sub-projects yet"}</span>
        <span class="resort-stats">
          <span><b>${st.open}</b> open</span>
          ${st.pending ? `<span><b>${st.pending}</b> to approve</span>` : ""}
          ${st.overdue ? `<span class="overdue"><b>${st.overdue}</b> overdue</span>` : ""}
          <span><b>${st.items}</b> inventory items</span>
        </span>
        ${CURRENT.project === name ? '<span class="badge b-pin">Current</span>' : ""}
      </button>`;
    }).join("")}
    ${isManager() ? `
    <form class="resort-card add" data-form="add-project" data-tour="add-project">
      <span class="resort-mark">${icon("new")}</span>
      <span class="resort-name">Add a project</span>
      <input name="name" placeholder="Project name, e.g. Marcella" aria-label="Project name" required>
      <input name="subs" placeholder="Sub-projects (optional), comma separated" aria-label="Sub-projects">
      <button class="btn primary small" type="submit">Add project</button>
    </form>` : ""}
  </div>
  ${archived.length && isManager() ? `<p class="muted small">Archived: ${esc(archived.map((p) => p.name).join(", "))} (restore in Settings).</p>` : ""}`;
}

/* ------------------------------------------- one project: sub-projects */
function areaStats(name) {
  const today = todayISO();
  const rows = S.requests.filter((r) => r.sub_project === name).map((r) => toRow(r, today));
  const items = S.inventory.filter((i) => i.sub_project === name);
  return {
    rows,
    open: rows.filter((r) => OPEN_STATUSES.includes(r.status)).length,
    overdue: rows.filter((r) => isOverdue(r, today)).length,
    counts: STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]).filter(([, n]) => n),
    items: items.length,
    low: items.filter(isLow).length,
    units: items.reduce((n, i) => n + Number(i.quantity || 0), 0),
  };
}

export function subProjectCards() {
  if (!AREAS.length) {
    return `<div class="empty card">${esc(CURRENT.project)} has no sub-projects yet.${isManager() ? ' Add one on the <a href="#/project">project page</a>.' : ""}</div>`;
  }
  return `<div class="projects" data-tour="subprojects">${AREAS.map((name) => {
    const st = areaStats(name);
    return `<a class="project-card" href="${areaHref(name)}">
      <span class="pc-name">${esc(name)}</span>
      <span class="pc-num">${st.open}<small> open</small></span>
      <span class="bar">${st.counts.map(([s, n]) => `<i class="s-${slug(s)}" style="flex:${n}" title="${esc(s)}: ${n}"></i>`).join("") || '<i class="none" style="flex:1"></i>'}</span>
      <span class="pc-meta">${st.rows.length} request${st.rows.length === 1 ? "" : "s"} · ${st.items} item${st.items === 1 ? "" : "s"}${st.overdue ? ` · <b class="overdue">${st.overdue} overdue</b>` : ""}${st.low ? ` · <b class="overdue">${st.low} low</b>` : ""}</span>
    </a>`;
  }).join("")}</div>`;
}

export function pageProject() {
  const def = SETTINGS.projects.find((p) => p.name === CURRENT.project);
  const noSub = S.requests.filter((r) => !r.sub_project).length;
  return `
  ${backLink("#/projects", "All projects")}
  ${crumbs([["Projects", "#/projects"], [CURRENT.project]])}
  <div class="section-head">
    <h2 class="section">Sub-projects</h2>
    <div class="btn-row"><a class="btn small" href="#/dashboard">Dashboard</a><a class="btn small primary" href="#/new">${icon("new")} New request</a></div>
  </div>
  ${subProjectCards()}
  <div class="section-head">
    <h2 class="section">Files &amp; spreadsheets</h2>
    <a class="btn small" href="#/files">${icon("import")} Upload or see all</a>
  </div>
  <div class="card flush">${filesListHTML({ limit: 5, empty: "No files yet. Upload spreadsheets and PDFs from Files & Assistant or from any sub-project page." })}</div>
  ${noSub && AREAS.length ? `<p class="muted small">${noSub} request${noSub === 1 ? " isn't" : "s aren't"} assigned to a sub-project. <a href="#/requests">See all requests</a>.</p>` : ""}
  ${isManager() ? `
  <form class="inline-add big" data-form="add-sub" data-tour="add-sub">
    <input name="name" placeholder="New sub-project for ${esc(CURRENT.project)}, e.g. Clubhouse" aria-label="New sub-project" required>
    <button class="btn" type="submit">${icon("new")} Add sub-project</button>
  </form>
  <p class="muted small">Rename, reorder or archive projects and sub-projects in <a href="#/settings">Settings</a>.${def?.aliases?.length ? ` Also recognized in emails as: ${esc(def.aliases.join(", "))}.` : ""}</p>` : ""}`;
}

/* ------------------------------------------------ one sub-project */
export function pageArea() {
  const name = S.areaName;
  if (!AREAS.includes(name)) {
    return `${backLink("#/project", CURRENT.project)}<div class="empty card">That sub-project isn't part of ${esc(CURRENT.project)}.</div>`;
  }
  const i = AREAS.indexOf(name);
  const prev = AREAS[(i - 1 + AREAS.length) % AREAS.length];
  const next = AREAS[(i + 1) % AREAS.length];
  const st = areaStats(name);
  const items = S.inventory.filter((it) => it.sub_project === name).sort((a, b) => a.item_name.localeCompare(b.item_name));
  const cols = ["ticket", "buildings", "rooms", "item_needed", "ffe_tag", "needed_by", "priority", "status", "notes"].map((k) => FIELD_MAP[k]);
  const openRows = st.rows.filter((r) => OPEN_STATUSES.includes(r.status)).sort((a, b) => a.needed_by.localeCompare(b.needed_by));
  return `
  <div class="area-nav">
    ${backLink("#/project", CURRENT.project)}
    ${AREAS.length > 1 ? `<span class="grow"></span>
      <a class="btn small" href="${areaHref(prev)}" aria-label="Previous sub-project">‹ ${esc(prev)}</a>
      <a class="btn small" href="${areaHref(next)}" aria-label="Next sub-project">${esc(next)} ›</a>` : ""}
  </div>
  ${crumbs([["Projects", "#/projects"], [CURRENT.project, "#/project"], [name]])}
  <div class="kpis">
    <div class="kpi"><span>Open requests</span><strong>${st.open}</strong></div>
    <div class="kpi ${st.overdue ? "warn" : ""}"><span>Overdue</span><strong>${st.overdue}</strong></div>
    <div class="kpi"><span>Inventory items</span><strong>${st.items}</strong></div>
    <div class="kpi"><span>Units on hand</span><strong>${st.units}</strong></div>
    <div class="kpi ${st.low ? "warn" : ""}"><span>Low stock</span><strong>${st.low}</strong></div>
  </div>
  <div class="section-head">
    <h2 class="section">Open requests</h2>
    <div class="btn-row">
      <button class="btn small" data-act="filter-sub" data-sub="${esc(name)}">All requests here</button>
      <button class="btn small primary" data-act="new-in-area" data-sub="${esc(name)}">${icon("new")} New request here</button>
    </div>
  </div>
  <div class="card flush">${tableHTML(cols, openRows, { empty: `No open requests for ${name}.` })}</div>
  <div class="section-head">
    <h2 class="section">Files &amp; spreadsheets</h2>
    <button class="btn small primary" data-act="upload-here" data-sub="${esc(name)}" data-tour="upload-here">${icon("import")} Upload spreadsheet or PDF here</button>
  </div>
  <div class="card flush">${filesListHTML({ sub: name, empty: `No files for ${name} yet. Upload a spreadsheet or PDF and the assistant will turn it into requests, sorted into the right sub-projects.` })}</div>
  <div class="section-head">
    <h2 class="section">Inventory &amp; attic stock</h2>
    <button class="btn small" data-act="inv-in-area" data-sub="${esc(name)}">Open in Inventory</button>
  </div>
  <div class="card flush">${items.length ? `<div class="table-wrap"><table class="grid">
    <thead><tr><th>Item</th><th>FF&amp;E Tag</th><th>Type</th><th>Location</th><th>On hand</th></tr></thead>
    <tbody>${items.map((it) => `<tr class="click" data-act="open-item" data-id="${esc(it.id)}">
      <td data-label="Item"><strong>${esc(it.item_name)}</strong></td><td data-label="FF&E Tag" class="mono">${esc(it.ffe_tag || "")}</td>
      <td data-label="Type">${badge(it.stock_type, it.stock_type === "Attic Stock" ? "attic" : "inv")}</td>
      <td data-label="Location">${esc(it.location || "")}</td>
      <td data-label="On hand" class="num"><strong class="${isLow(it) ? "overdue" : ""}">${esc(it.quantity)}</strong> ${esc(it.unit || "ea")}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">No inventory recorded for ${esc(name)}.</div>`}</div>`;
}

/* ------------------------------------------------------------ actions */
const PROJECT_KEY = (uid) => `bdr-ffe-project-${uid}`;
export function savedProject() {
  try { return localStorage.getItem(PROJECT_KEY(S.me.id)) || ""; } catch { return ""; }
}

// Switch the whole app to `name` and reload its records.
export async function openProject(name) {
  S.project = name;
  try { localStorage.setItem(PROJECT_KEY(S.me.id), name); } catch { /* private window */ }
  store.setScope(name);
  CURRENT.project = name;
  applySettings({ projects: SETTINGS.projects, options: SETTINGS.options });
  S.reqFilter = { q: "", sub: "", status: "" };
  S.inv = { ...S.inv, sub: "" };
  S.imp = null;
  await hooks.reload();
}

async function saveSettings(mutate, msg) {
  const next = structuredClone({ projects: SETTINGS.projects, options: SETTINGS.options });
  mutate(next);
  const saved = await guard(() => store.saveSettings(next), msg);
  if (saved) applySettings(saved);
  return !!saved;
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

export const CLICK = {
  async "pick-project"(el) {
    await openProject(el.dataset.project);
    location.hash = "#/project";
  },
  "new-in-area"(el) { S.draft = { ...S.draft, sub: el.dataset.sub }; location.hash = "#/new"; },
  "inv-in-area"(el) { S.inv = { ...S.inv, sub: el.dataset.sub }; location.hash = "#/inventory"; },
};

export const SUBMIT = {
  async "add-project"(form) {
    const name = clean(form.querySelector("[name=name]").value);
    const subs = form.querySelector("[name=subs]").value.split(",").map(clean).filter(Boolean);
    if (!name) return;
    if (SETTINGS.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast("That project already exists", "err"); return; }
    if (await saveSettings((s) => { s.projects.push({ name, subprojects: [...new Set(subs)], aliases: [], archived: false }); }, `${name} added`)) hooks.render();
  },
  async "add-sub"(form) {
    const name = clean(form.querySelector("[name=name]").value);
    if (!name) return;
    if (AREAS.some((a) => a.toLowerCase() === name.toLowerCase())) { toast("That sub-project already exists", "err"); return; }
    if (await saveSettings((s) => {
      const p = s.projects.find((x) => x.name === CURRENT.project);
      p.subprojects = [...(p.subprojects || []), name];
    }, `${name} added to ${CURRENT.project}`)) hooks.render();
  },
};

export const pages = { projects: pageProjects, project: pageProject, area: pageArea };
