import { store } from "./store.js";
import { CONFIG } from "./config.js";
import {
  PROJECTS, STATUSES, OPEN_STATUSES, CLOSED_STATUSES, PRIORITIES, ACTION_STATUSES, PHOTO_KINDS, FIELDS, FIELD_MAP,
  OPS, VALUELESS_OPS, toRow, todayISO, ticketLabel, isOverdue,
} from "./fields.js";
import { applyView, defaultSpec, sanitizeSpec, localSpecFromPrompt } from "./views.js";
import { downloadWorkbook, downloadCsv, requestsTab, viewTab, actionsTab } from "./export.js";

const app = document.getElementById("app");
const modalRoot = document.getElementById("modal-root");
const toastRoot = document.getElementById("toast-root");

const S = {
  me: null,
  requests: [], actions: [], views: [], profiles: [],
  route: "dashboard",
  reqFilter: { q: "", project: "", status: "" },
  actionFilter: "",
  builder: { prompt: "", spec: defaultSpec(), viewId: null, pinned: false, busy: false, note: "", source: "" },
  draft: { photos: [], project: "" },
  modalId: null,
};

const isManager = () => S.me?.role === "manager";
const ROLE_LABEL = { manager: "Manager", owner_relations: "Owner Relations" };

/* ---------------------------------------------------------------- helpers */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label ?? value)}</option>`;
const badge = (text, kind = slug(text)) => `<span class="badge b-${kind}">${esc(text)}</span>`;

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast t-${kind}`;
  el.textContent = msg;
  toastRoot.appendChild(el);
  setTimeout(() => el.classList.add("out"), 3600);
  setTimeout(() => el.remove(), 4000);
}

async function guard(fn, okMsg) {
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

const ICONS = {
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
  pin: '<path d="M12 17v5M5 17h14l-2-4V5H7v8z"/>',
};
const icon = (name, cls = "ico") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "requests", label: "All Requests" },
  { id: "new", label: "New Request" },
  { id: "approvals", label: "Approvals", manager: true },
  { id: "actions", label: "My Action Items" },
  { id: "builder", label: "Sheet Builder" },
  { id: "team", label: "Team & Roles", manager: true },
];
const TITLES = {
  dashboard: "Dashboard", requests: "All Requests", new: "New FF&E Request", approvals: "Approval Queue",
  actions: "My Action Items", builder: "Custom Sheet Builder", team: "Team & Roles",
};

function routeFromHash() {
  const r = location.hash.replace(/^#\/?/, "") || "dashboard";
  const item = NAV.find((n) => n.id === r);
  if (!item || (item.manager && !isManager())) return "dashboard";
  return r;
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  try { S.me = await store.currentUser(); } catch (e) { console.error(e); }
  if (!S.me) return renderLogin();
  startApp();
}

async function startApp() {
  await loadAll();
  store.subscribe(onRemoteChange);
  window.addEventListener("hashchange", () => { S.route = routeFromHash(); render(); window.scrollTo(0, 0); });
  S.route = routeFromHash();
  render();
}

async function loadAll() {
  await guard(async () => {
    const [requests, actions, views, profiles] = await Promise.all([
      store.listRequests(), store.listActions(), store.listViews(), isManager() ? store.listProfiles() : [],
    ]);
    Object.assign(S, { requests, actions, views, profiles });
  });
}

async function onRemoteChange(kind) {
  if (kind === "profiles") {
    const fresh = await guard(() => store.currentUser());
    if (fresh && fresh.role !== S.me.role) { S.me = fresh; toast(`Your role is now ${ROLE_LABEL[fresh.role]}`); }
    if (isManager()) S.profiles = (await guard(() => store.listProfiles())) || S.profiles;
  } else {
    S.requests = (await guard(() => store.listRequests())) || S.requests;
  }
  // Don't wipe a half-filled form; just refresh the badges.
  if (S.route === "new") updateBadges();
  else render();
  if (S.modalId) openRequest(S.modalId, true);
}

/* ------------------------------------------------------------------ login */
function renderLogin(mode = "signin", msg = "") {
  const demo = store.mode === "demo";
  app.innerHTML = `
  <div class="login">
    <div class="login-art">
      <div class="brand-mark lg">BD</div>
      <h1>Black Desert Resort</h1>
      <p class="tagline">FF&amp;E Tracker</p>
      <ul class="proj-list">${PROJECTS.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
    </div>
    <div class="login-card">
      ${demo ? `
        <h2>Demo mode</h2>
        <p class="muted">No database is connected yet, so everything is saved only in this browser. Pick someone to try the app as. See the README to connect Supabase for real multi-user logins.</p>
        <div class="demo-users">
          ${store.demoUsers().map((u) => `
            <button class="demo-user" data-act="demo-login" data-id="${esc(u.id)}">
              <span class="avatar">${esc(initials(u.full_name))}</span>
              <span><strong>${esc(u.full_name)}</strong><small>${esc(ROLE_LABEL[u.role])}</small></span>
            </button>`).join("")}
        </div>
        <button class="btn link" data-act="demo-reset">Reset demo data</button>
      ` : `
        <div class="tabs">
          <button class="tab ${mode === "signin" ? "on" : ""}" data-act="login-tab" data-mode="signin">Sign in</button>
          <button class="tab ${mode === "signup" ? "on" : ""}" data-act="login-tab" data-mode="signup">Create account</button>
        </div>
        ${msg ? `<p class="notice">${esc(msg)}</p>` : ""}
        <form data-form="${mode}" class="stack">
          ${mode === "signup" ? `<label>Full name<input name="name" required autocomplete="name"></label>` : ""}
          <label>Work email<input name="email" type="email" required autocomplete="email"></label>
          <label>Password<input name="password" type="password" required minlength="8" autocomplete="${mode === "signup" ? "new-password" : "current-password"}"></label>
          <button class="btn primary" type="submit">${mode === "signup" ? "Create account" : "Sign in"}</button>
          ${mode === "signin" ? `<button type="button" class="btn link" data-act="forgot">Forgot password?</button>` : `<p class="muted small">New accounts start as Owner Relations. A manager can change your role under Team &amp; Roles.</p>`}
        </form>
      `}
    </div>
  </div>`;
}

const initials = (name) => String(name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

/* ----------------------------------------------------------------- shell */
function pendingCount() { return S.requests.filter((r) => r.status === "Pending").length; }

function render() {
  const nav = NAV.filter((n) => !n.manager || isManager());
  app.innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand"><div class="brand-mark">BD</div><div><strong>Black Desert</strong><small>FF&amp;E Tracker</small></div></div>
      <nav>${nav.map((n) => `
        <a href="#/${n.id}" class="nav-item ${S.route === n.id ? "on" : ""}">${icon(n.id)}<span>${n.label}</span>
        ${n.id === "approvals" ? `<em class="count" data-badge="pending">${pendingCount() || ""}</em>` : ""}</a>`).join("")}
      </nav>
      <div class="me">
        <span class="avatar">${esc(initials(S.me.full_name))}</span>
        <div><strong>${esc(S.me.full_name || S.me.email)}</strong><small>${esc(ROLE_LABEL[S.me.role] || S.me.role)}</small></div>
        <button class="icon-btn" data-act="signout" title="Sign out" aria-label="Sign out">${icon("logout")}</button>
      </div>
    </aside>
    <main>
      <header class="topbar">
        <h1>${TITLES[S.route]}</h1>
        <span class="mode ${store.mode}">${store.mode === "cloud" ? "Live · shared" : "Demo · this browser only"}</span>
      </header>
      <section class="content">${PAGES[S.route]()}</section>
    </main>
  </div>`;
}

function updateBadges() {
  const el = app.querySelector('[data-badge="pending"]');
  if (el) el.textContent = pendingCount() || "";
}

/* ---------------------------------------------------------------- tables */
function cellHTML(key, row) {
  const v = row[key];
  if (key === "status") return badge(v);
  if (key === "priority") return v === "Normal" ? esc(v) : badge(v, `p-${slug(v)}`);
  if (key === "needed_by") return `<span class="${isOverdue(row) ? "overdue" : ""}">${esc(fmtDate(v))}</span>`;
  if (FIELD_MAP[key]?.type === "date") return esc(fmtDate(v));
  if (key === "ticket") return `<strong class="mono">${esc(v)}</strong>`;
  if (key === "days_until_due" && v !== "" && !CLOSED_STATUSES.includes(row.status)) return `<span class="${v < 0 ? "overdue" : ""}">${esc(v)}</span>`;
  return esc(v);
}

function tableHTML(columns, rows, { groupBy = "none", limit = 0, empty = "Nothing here yet." } = {}) {
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

/* ------------------------------------------------------------- dashboard */
function pageDashboard() {
  const today = todayISO();
  const rows = S.requests.map((r) => toRow(r, today));
  const open = rows.filter((r) => OPEN_STATUSES.includes(r.status));
  const overdue = rows.filter((r) => isOverdue(r, today));
  const month = today.slice(0, 7);
  const doneMonth = rows.filter((r) => r.status === "Completed" && (r._raw.updated_at || r._raw.reviewed_at || "").slice(0, 7) === month);
  const pinned = S.views.filter((v) => v.pinned);
  const myOpenActions = S.actions.filter((a) => a.status !== "Done").length;

  return `
  <div class="kpis">
    <div class="kpi"><span>Open requests</span><strong>${open.length}</strong></div>
    <a class="kpi ${isManager() ? "link" : ""}" ${isManager() ? 'href="#/approvals"' : ""}><span>Awaiting approval</span><strong>${pendingCount()}</strong></a>
    <div class="kpi ${overdue.length ? "warn" : ""}"><span>Overdue</span><strong>${overdue.length}</strong></div>
    <div class="kpi"><span>Completed this month</span><strong>${doneMonth.length}</strong></div>
    <a class="kpi link" href="#/actions"><span>My open action items</span><strong>${myOpenActions}</strong></a>
  </div>

  <h2 class="section">Projects</h2>
  <div class="projects">${PROJECTS.map((p) => {
    const pr = rows.filter((r) => r.project === p);
    const counts = STATUSES.map((s) => [s, pr.filter((r) => r.status === s).length]).filter(([, n]) => n);
    return `<button class="project-card" data-act="filter-project" data-project="${esc(p)}">
      <span class="pc-name">${esc(p)}</span>
      <span class="pc-num">${pr.filter((r) => OPEN_STATUSES.includes(r.status)).length}<small> open</small></span>
      <span class="bar">${counts.map(([s, n]) => `<i class="s-${slug(s)}" style="flex:${n}" title="${esc(s)}: ${n}"></i>`).join("") || '<i class="none" style="flex:1"></i>'}</span>
      <span class="pc-meta">${pr.length} total${pr.filter((r) => isOverdue(r, today)).length ? ` · <b class="overdue">${pr.filter((r) => isOverdue(r, today)).length} overdue</b>` : ""}</span>
    </button>`;
  }).join("")}</div>

  <div class="section-head">
    <h2 class="section">My pinned sheets</h2>
    <a class="btn small" href="#/builder">${icon("sparkle")} Build a sheet</a>
  </div>
  ${pinned.length ? pinned.map((v) => {
    const view = applyView(v.spec, S.requests, S.me);
    return `<div class="card">
      <div class="card-head">
        <div><h3>${esc(v.name)}</h3><p class="muted small">${view.rows.length} rows${v.prompt ? ` · “${esc(v.prompt)}”` : ""}</p></div>
        <div class="btn-row">
          <button class="btn small" data-act="load-view" data-id="${esc(v.id)}">Open</button>
          <button class="btn small" data-act="export-saved-view" data-id="${esc(v.id)}">${icon("download")} Excel</button>
        </div>
      </div>
      ${tableHTML(view.columns, view.rows, { groupBy: view.spec.group_by, limit: 8, empty: "No requests match this sheet right now." })}
    </div>`;
  }).join("") : `<div class="empty card">Pin a custom sheet from the Sheet Builder and it will always show up here.</div>`}

  <h2 class="section">Recent requests</h2>
  <div class="card flush">${tableHTML(
    ["ticket", "project", "buildings", "rooms", "item_needed", "needed_by", "status", "requester_name"].map((k) => FIELD_MAP[k]),
    rows, { limit: 8, empty: "No requests yet. Submit the first one from New Request." })}</div>`;
}

/* -------------------------------------------------------------- requests */
function filteredRequests() {
  const { q, project, status } = S.reqFilter;
  const needle = q.trim().toLowerCase();
  return S.requests.map((r) => toRow(r)).filter((row) =>
    (!project || row.project === project) &&
    (!status || (status === "open" ? OPEN_STATUSES.includes(row.status) : status === "overdue" ? isOverdue(row) : row.status === status)) &&
    (!needle || ["ticket", "buildings", "rooms", "item_needed", "ffe_tag", "spec", "requester_name", "details"].some((k) => String(row[k]).toLowerCase().includes(needle))));
}

const REQUEST_COLS = ["ticket", "project", "buildings", "rooms", "item_needed", "ffe_tag", "needed_by", "priority", "status", "requester_name"];

function requestsTableHTML() {
  const rows = filteredRequests().sort((a, b) => (b._raw.created_at || "").localeCompare(a._raw.created_at || ""));
  return `<p class="muted small">${rows.length} request${rows.length === 1 ? "" : "s"}</p>` +
    tableHTML(REQUEST_COLS.map((k) => FIELD_MAP[k]), rows, { empty: "No requests match these filters." });
}

function pageRequests() {
  const f = S.reqFilter;
  return `
  <div class="toolbar">
    <input type="search" placeholder="Search ticket, building, room, item, tag…" value="${esc(f.q)}" data-input="req-search" class="grow">
    <select data-change="req-filter" data-key="project">${opt("", "All projects")}${PROJECTS.map((p) => opt(p, p, f.project === p)).join("")}</select>
    <select data-change="req-filter" data-key="status">${opt("", "All statuses")}${opt("open", "Open (not closed)", f.status === "open")}${opt("overdue", "Overdue", f.status === "overdue")}${STATUSES.map((s) => opt(s, s, f.status === s)).join("")}</select>
    <button class="btn" data-act="export-requests">${icon("download")} Export</button>
    <a class="btn primary" href="#/new">${icon("new")} New request</a>
  </div>
  <div class="card flush" id="req-table">${requestsTableHTML()}</div>`;
}

/* ----------------------------------------------------------- new request */
function pageNew() {
  const d = S.draft;
  return `
  <form class="request-form" data-form="request" novalidate>
    <p class="lead">Be as specific as possible — the more detail here, the faster this gets approved and fixed.</p>

    <fieldset class="card">
      <legend>1. Where</legend>
      <div class="chip-select" role="radiogroup" aria-label="Project">
        ${PROJECTS.map((p) => `<label class="chip"><input type="radio" name="project" value="${esc(p)}" ${d.project === p ? "checked" : ""} required><span>${esc(p)}</span></label>`).join("")}
      </div>
      <div class="row2">
        <label>Building(s) <em>*</em><input name="buildings" required placeholder="e.g. 89, or 89 & 90"></label>
        <label>Room number(s) <em>*</em><input name="rooms" required placeholder="e.g. 8902, 8904 — or “Lobby”"></label>
      </div>
    </fieldset>

    <fieldset class="card">
      <legend>2. What</legend>
      <label>What do you need? <em>*</em><textarea name="item_needed" required rows="3" placeholder="Describe the item and what's wrong or what's needed"></textarea></label>
      <div class="row2">
        <label>FF&amp;E tag # <em>*</em><input name="ffe_tag" required placeholder="Tag on the item, e.g. FFE-COV-OD-114"></label>
        <label>Specification <span class="muted">(manufacturer, model, finish, size)</span><input name="spec" placeholder="e.g. Sunbrella Canvas Navy, 24×24×4"></label>
      </div>
      <div class="row3">
        <label>Quantity <em>*</em><input name="quantity" type="number" min="1" value="1" required></label>
        <label>Priority<select name="priority">${PRIORITIES.map((p) => opt(p, p, p === "Normal")).join("")}</select></label>
        <label>Needed fixed by <em>*</em><input name="needed_by" type="date" required min="${todayISO()}"></label>
      </div>
    </fieldset>

    <fieldset class="card">
      <legend>3. Photos <em>*</em></legend>
      <p class="muted small">Attach at least one photo. For each one, choose whether it's a <b>concept image</b> (what the item should look like) or <b>proof of damage</b>.</p>
      <label class="drop">
        ${icon("camera", "ico lg")}
        <span>Tap to take or choose photos</span>
        <input type="file" accept="image/*" multiple data-change="photos">
      </label>
      <div id="photo-list" class="photo-list">${photoListHTML()}</div>
    </fieldset>

    <fieldset class="card">
      <legend>4. Anything else</legend>
      <label>Additional details <span class="muted">(access notes, vendor, guest impact…)</span><textarea name="details" rows="3"></textarea></label>
    </fieldset>

    <div class="form-actions">
      <span class="muted small" id="form-error" role="alert"></span>
      <button class="btn primary lg" type="submit">Submit request</button>
    </div>
  </form>`;
}

function photoListHTML() {
  return S.draft.photos.map((p, i) => `
    <div class="photo-item ${p.kind ? "" : "needs"}">
      <img src="${p.preview}" alt="">
      <div class="stack tight">
        <span class="small ellipsis">${esc(p.name)}</span>
        <select data-change="photo-kind" data-idx="${i}" aria-label="Photo type">
          ${opt("", "Choose type…", !p.kind)}${opt("concept", PHOTO_KINDS.concept, p.kind === "concept")}${opt("damage", PHOTO_KINDS.damage, p.kind === "damage")}
        </select>
      </div>
      <button type="button" class="icon-btn" data-act="remove-photo" data-idx="${i}" aria-label="Remove photo">${icon("trash")}</button>
    </div>`).join("");
}

function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL("image/jpeg", quality);
      c.toBlob((blob) => resolve({ blob, dataUrl }), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Couldn't read ${file.name}`)); };
    img.src = url;
  });
}

async function addPhotos(files) {
  const demo = store.mode === "demo";
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const res = await guard(() => compressImage(file, demo ? 900 : 1800, demo ? 0.7 : 0.85));
    if (res) S.draft.photos.push({ name: file.name, kind: "", blob: res.blob, dataUrl: res.dataUrl, preview: res.dataUrl });
  }
  const list = document.getElementById("photo-list");
  if (list) list.innerHTML = photoListHTML();
}

async function submitRequest(form) {
  const fd = new FormData(form);
  const v = (k) => String(fd.get(k) || "").trim();
  const err = form.querySelector("#form-error");
  const fields = {
    project: v("project"), buildings: v("buildings"), rooms: v("rooms"), item_needed: v("item_needed"),
    ffe_tag: v("ffe_tag"), spec: v("spec"), quantity: Math.max(1, parseInt(v("quantity"), 10) || 1),
    priority: v("priority") || "Normal", needed_by: v("needed_by"), details: v("details"),
  };
  const missing = [];
  if (!fields.project) missing.push("project");
  if (!fields.buildings) missing.push("building(s)");
  if (!fields.rooms) missing.push("room number(s)");
  if (!fields.item_needed) missing.push("what you need");
  if (!fields.ffe_tag) missing.push("FF&E tag");
  if (!fields.needed_by) missing.push("needed-by date");
  if (!S.draft.photos.length) missing.push("at least one photo");
  form.querySelectorAll("[required]").forEach((el) => el.classList.toggle("invalid", !el.value.trim() && el.type !== "radio"));
  if (missing.length) { err.textContent = `Please add: ${missing.join(", ")}.`; return; }
  if (fields.needed_by < todayISO()) { err.textContent = "The needed-by date can't be in the past."; return; }
  if (S.draft.photos.some((p) => !p.kind)) { err.textContent = "Choose “Concept image” or “Proof of damage” for every photo."; return; }
  err.textContent = "";

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Submitting…";
  const created = await guard(() => store.createRequest(fields, S.draft.photos));
  btn.disabled = false;
  btn.textContent = "Submit request";
  if (!created) return;
  S.requests = [created, ...S.requests.filter((r) => r.id !== created.id)];
  S.draft = { photos: [], project: "" };
  toast(`${ticketLabel(created.ticket_no)} submitted for approval`);
  location.hash = "#/requests";
  openRequest(created.id);
}

/* ------------------------------------------------------------- approvals */
function pageApprovals() {
  const today = todayISO();
  const pending = S.requests.filter((r) => r.status === "Pending").map((r) => toRow(r, today)).sort((a, b) => a.needed_by.localeCompare(b.needed_by));
  const active = S.requests.filter((r) => ["Approved", "In Progress"].includes(r.status)).map((r) => toRow(r, today)).sort((a, b) => a.needed_by.localeCompare(b.needed_by));
  const card = (row) => `
    <div class="approval">
      <div class="ap-main" data-act="open-request" data-id="${esc(row._raw.id)}">
        <div class="ap-top"><strong class="mono">${esc(row.ticket)}</strong> ${badge(row.project, "proj")} ${row.priority !== "Normal" ? badge(row.priority, `p-${slug(row.priority)}`) : ""}</div>
        <h3>${esc(row.item_needed)}</h3>
        <p class="muted small">Bldg ${esc(row.buildings)} · Room ${esc(row.rooms)} · Tag ${esc(row.ffe_tag)} · Qty ${esc(row.quantity)}</p>
        <p class="small">Needed by <span class="${isOverdue(row, today) ? "overdue" : ""}">${esc(fmtDate(row.needed_by))}</span> · from ${esc(row.requester_name)} · ${row.concept_photos + row.damage_photos} photo(s)</p>
      </div>
      <div class="ap-actions">
        ${row.status === "Pending" ? `
          <button class="btn approve" data-act="quick-review" data-id="${esc(row._raw.id)}" data-status="Approved">Approve</button>
          <button class="btn reject" data-act="open-request" data-id="${esc(row._raw.id)}">Reject…</button>` : `
          ${badge(row.status)}
          ${row.status === "Approved" ? `<button class="btn small" data-act="quick-status" data-id="${esc(row._raw.id)}" data-status="In Progress">Start work</button>` : ""}
          <button class="btn small" data-act="quick-status" data-id="${esc(row._raw.id)}" data-status="Completed">Mark completed</button>`}
      </div>
    </div>`;
  return `
    <h2 class="section">Waiting for approval <span class="muted">(${pending.length})</span></h2>
    ${pending.length ? pending.map(card).join("") : `<div class="empty card">All caught up — nothing waiting for approval.</div>`}
    <h2 class="section">Approved &amp; in progress <span class="muted">(${active.length})</span></h2>
    ${active.length ? active.map(card).join("") : `<div class="empty card">No approved work in progress.</div>`}`;
}

/* ---------------------------------------------------------- request modal */
async function openRequest(id, refresh = false) {
  const r = S.requests.find((x) => x.id === id);
  if (!r) { closeModal(); return; }
  if (refresh && !modalRoot.innerHTML) return;
  S.modalId = id;
  const row = toRow(r);
  const mine = r.requested_by === S.me.id;
  const photos = Array.isArray(r.photos) ? r.photos : [];
  const linked = S.actions.some((a) => a.linked_ticket === row.ticket);
  const keepNote = modalRoot.querySelector("#review-note")?.value || "";
  const field = (label, value) => value === "" || value == null ? "" : `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

  modalRoot.innerHTML = `
  <div class="modal-bg" data-act="close-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(row.ticket)}" data-stop>
      <header class="modal-head">
        <div><span class="mono muted">${esc(row.ticket)}</span><h2>${esc(row.item_needed)}</h2>
          <div class="btn-row">${badge(row.status)} ${badge(row.project, "proj")} ${row.priority !== "Normal" ? badge(row.priority, `p-${slug(row.priority)}`) : ""}</div></div>
        <button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button>
      </header>
      <dl class="facts">
        ${field("Project", esc(row.project))}
        ${field("Building(s)", esc(row.buildings))}
        ${field("Room(s)", esc(row.rooms))}
        ${field("FF&E tag", `<span class="mono">${esc(row.ffe_tag)}</span>`)}
        ${field("Specification", esc(row.spec))}
        ${field("Quantity", esc(row.quantity))}
        ${field("Needed by", `<span class="${isOverdue(row) ? "overdue" : ""}">${esc(fmtDate(row.needed_by))}${isOverdue(row) ? " · overdue" : ""}</span>`)}
        ${field("Requested by", `${esc(row.requester_name)} · ${esc(fmtDate(row.created_at))}`)}
        ${row.reviewer_name ? field("Reviewed by", `${esc(row.reviewer_name)} · ${esc(fmtDate(row.reviewed_at))}`) : ""}
      </dl>
      ${row.details ? `<div class="note-block"><dt>Additional details</dt><p>${esc(row.details)}</p></div>` : ""}
      ${row.review_note ? `<div class="note-block review"><dt>Manager note</dt><p>${esc(row.review_note)}</p></div>` : ""}
      ${["concept", "damage"].map((kind) => {
        const list = photos.filter((p) => p.kind === kind);
        return list.length ? `<h3 class="ph-head">${esc(PHOTO_KINDS[kind])} <span class="muted">(${list.length})</span></h3>
          <div class="gallery">${list.map((p) => `<a class="ph" data-path="${esc(p.path)}" target="_blank" rel="noopener"><span class="ph-loading"></span></a>`).join("")}</div>` : "";
      }).join("")}
      <footer class="modal-foot">
        ${isManager() && r.status === "Pending" ? `
          <label class="grow">Note to requester <span class="muted">(required to reject)</span><textarea id="review-note" rows="2">${esc(keepNote)}</textarea></label>
          <div class="btn-row">
            <button class="btn reject" data-act="review" data-id="${esc(r.id)}" data-status="Rejected">Reject</button>
            <button class="btn approve" data-act="review" data-id="${esc(r.id)}" data-status="Approved">Approve</button>
          </div>` : ""}
        ${isManager() && r.status === "Approved" ? `<button class="btn" data-act="quick-status" data-id="${esc(r.id)}" data-status="In Progress">Start work</button>` : ""}
        ${isManager() && ["Approved", "In Progress"].includes(r.status) ? `<button class="btn approve" data-act="quick-status" data-id="${esc(r.id)}" data-status="Completed">Mark completed</button>` : ""}
        ${mine && r.status === "Pending" ? `<button class="btn" data-act="cancel-request" data-id="${esc(r.id)}">Cancel my request</button>` : ""}
        <button class="btn" data-act="add-to-actions" data-id="${esc(r.id)}" ${linked ? "disabled" : ""}>${linked ? "In my action items" : "Add to my action items"}</button>
      </footer>
    </div>
  </div>`;

  if (photos.length) {
    const urls = await guard(() => store.photoUrls(photos));
    if (S.modalId !== id || !urls) return;
    modalRoot.querySelectorAll(".ph").forEach((a) => {
      const url = urls[a.dataset.path];
      if (url) { a.href = url; a.innerHTML = `<img src="${esc(url)}" alt="Request photo" loading="lazy">`; }
      else a.innerHTML = '<span class="muted small">Unavailable</span>';
    });
  }
}

function closeModal() { S.modalId = null; modalRoot.innerHTML = ""; }

async function setRequestStatus(id, status, note) {
  const patch = { status };
  if (status === "Approved" || status === "Rejected") {
    Object.assign(patch, { reviewed_by: S.me.id, reviewer_name: S.me.full_name || S.me.email, reviewed_at: new Date().toISOString() });
    if (note !== undefined) patch.review_note = note;
  }
  const updated = await guard(() => store.updateRequest(id, patch), `Request ${status.toLowerCase()}`);
  if (!updated) return;
  S.requests = S.requests.map((r) => (r.id === id ? updated : r));
  render();
  if (S.modalId === id) openRequest(id);
}

/* ---------------------------------------------------------- action items */
function pageActions() {
  const total = S.actions.length;
  const done = S.actions.filter((a) => a.status === "Done").length;
  const items = S.actions
    .filter((a) => !S.actionFilter || (S.actionFilter === "open" ? a.status !== "Done" : a.status === S.actionFilter))
    .sort((a, b) => (a.status === "Done") - (b.status === "Done") || (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  const tickets = S.requests.map((r) => ticketLabel(r.ticket_no));
  return `
  <div class="toolbar">
    <select data-change="action-filter">${opt("", "All items")}${opt("open", "Not done", S.actionFilter === "open")}${ACTION_STATUSES.map((s) => opt(s, s, S.actionFilter === s)).join("")}</select>
    <div id="action-progress" class="progress grow">${progressHTML(done, total)}</div>
    <button class="btn primary" data-act="new-action">${icon("new")} New item</button>
  </div>
  <div class="card export-card">
    <div><h3>My spreadsheet</h3><p class="muted small">Download just your action items, or a combined workbook: the overall request sheet plus your own tab${S.views.length ? " and your saved sheets" : ""}.</p></div>
    <div class="btn-row">
      <button class="btn" data-act="export-my-sheet">${icon("download")} My sheet</button>
      <button class="btn primary" data-act="export-combined">${icon("download")} Combined workbook</button>
    </div>
  </div>
  <div class="actions-list">
    ${items.length ? items.map((a) => actionRowHTML(a, tickets)).join("") : `<div class="empty card">${total ? "No items match this filter." : "Your checklist is empty. Add the things you need to take care of on your side — they stay private to you."}</div>`}
  </div>`;
}

const progressHTML = (done, total) => total
  ? `<span class="bar"><i class="s-completed" style="width:${Math.round((done / total) * 100)}%"></i></span><span class="small muted">${done} of ${total} done</span>`
  : "";

function actionRowHTML(a, tickets) {
  const overdue = a.due_date && a.due_date < todayISO() && a.status !== "Done";
  return `
  <div class="action ${a.status === "Done" ? "done" : ""}" data-id="${esc(a.id)}">
    <input type="checkbox" class="check" data-change="action-done" data-id="${esc(a.id)}" ${a.status === "Done" ? "checked" : ""} aria-label="Done">
    <div class="action-body">
      <input class="title-input" value="${esc(a.title)}" data-change="action-field" data-field="title" data-id="${esc(a.id)}" aria-label="Title" placeholder="What needs to happen?">
      <div class="action-meta">
        <label>Status<select data-change="action-field" data-field="status" data-id="${esc(a.id)}">${ACTION_STATUSES.map((s) => opt(s, s, a.status === s)).join("")}</select></label>
        <label>Priority<select data-change="action-field" data-field="priority" data-id="${esc(a.id)}">${PRIORITIES.map((p) => opt(p, p, (a.priority || "Normal") === p)).join("")}</select></label>
        <label>Due<input type="date" class="${overdue ? "overdue" : ""}" value="${esc(a.due_date || "")}" data-change="action-field" data-field="due_date" data-id="${esc(a.id)}"></label>
        <label>Ticket<select data-change="action-field" data-field="linked_ticket" data-id="${esc(a.id)}">${opt("", "—")}${tickets.map((t) => opt(t, t, a.linked_ticket === t)).join("")}</select></label>
        <label>Category<input value="${esc(a.category || "")}" data-change="action-field" data-field="category" data-id="${esc(a.id)}" placeholder="e.g. Owner follow-up"></label>
      </div>
      <textarea rows="2" placeholder="Notes…" data-change="action-field" data-field="notes" data-id="${esc(a.id)}">${esc(a.notes || "")}</textarea>
    </div>
    <button class="icon-btn" data-act="delete-action" data-id="${esc(a.id)}" aria-label="Delete item">${icon("trash")}</button>
  </div>`;
}

async function saveActionField(id, field, value) {
  const a = S.actions.find((x) => x.id === id);
  if (!a) return;
  a[field] = value === "" && field !== "title" && field !== "notes" && field !== "category" ? null : value;
  const saved = await guard(() => store.saveAction(a));
  if (saved) Object.assign(a, saved);
  const done = S.actions.filter((x) => x.status === "Done").length;
  const prog = document.getElementById("action-progress");
  if (prog) prog.innerHTML = progressHTML(done, S.actions.length);
  const rowEl = app.querySelector(`.action[data-id="${CSS.escape(id)}"]`);
  if (rowEl && field === "status") {
    rowEl.classList.toggle("done", a.status === "Done");
    rowEl.querySelector(".check").checked = a.status === "Done";
  }
}

/* ---------------------------------------------------------- sheet builder */
const EXAMPLES = [
  "Open Cove requests due in the next 14 days, grouped by building",
  "Everything overdue, grouped by project, with manager notes",
  "My requests and their status, newest first",
  "Urgent and high priority items across all projects with damage photos",
];

function pageBuilder() {
  const b = S.builder;
  const view = applyView(b.spec, S.requests, S.me);
  const spec = view.spec;
  return `
  <div class="builder">
    <div class="card ai-card">
      <h3>${icon("sparkle")} Spreadsheet assistant</h3>
      <p class="muted small">Describe the sheet you want to see. It builds the columns, filters, sorting and grouping for you — then tweak anything below${b.viewId ? ". Your request will refine the sheet that's open" : ""}.</p>
      <textarea rows="3" data-input="builder-prompt" placeholder="e.g. Show pending Terrace and Cove requests due this month grouped by building, include FF&E tag and spec">${esc(b.prompt)}</textarea>
      <div class="chips">${EXAMPLES.map((e) => `<button class="chip-btn" data-act="example" data-text="${esc(e)}">${esc(e)}</button>`).join("")}</div>
      <div class="btn-row">
        <button class="btn primary" data-act="ai-generate" ${b.busy ? "disabled" : ""}>${b.busy ? "Building…" : `${icon("sparkle")} Build my sheet`}</button>
        ${b.viewId ? `<button class="btn" data-act="new-view">Start a new sheet</button>` : ""}
      </div>
      ${b.note ? `<p class="ai-note ${b.source}">${esc(b.note)}</p>` : ""}
    </div>

    <div class="card">
      <div class="card-head">
        <label class="grow">Sheet name<input value="${esc(spec.name)}" data-change="spec-name"></label>
        <label class="check-label"><input type="checkbox" data-change="spec-pinned" ${b.pinned ? "checked" : ""}> ${icon("pin")} Pin to dashboard</label>
        <button class="btn primary" data-act="save-view">${b.viewId ? "Save changes" : "Save sheet"}</button>
      </div>
      <details ${b.viewId || spec.filters.length ? "open" : ""}>
        <summary>Columns, filters &amp; sorting</summary>
        <h4>Columns</h4>
        <div class="col-grid">${FIELDS.map((f) => `<label class="check-label"><input type="checkbox" data-change="spec-col" data-key="${f.key}" ${spec.columns.includes(f.key) ? "checked" : ""}> ${esc(f.label)}</label>`).join("")}</div>
        <h4>Filters</h4>
        <div class="filters">
          ${spec.filters.map((f, i) => `<span class="filter-chip">${esc(f.op === "overdue" ? "Overdue" : FIELD_MAP[f.field]?.label)} ${f.op === "overdue" ? "" : esc(OPS[f.op])} ${VALUELESS_OPS.includes(f.op) ? "" : `<b>${esc(FIELD_MAP[f.field]?.type === "date" && f.op !== "due_within_days" ? fmtDate(f.value) : f.value)}</b>`}<button data-act="remove-filter" data-idx="${i}" aria-label="Remove filter">✕</button></span>`).join("") || '<span class="muted small">No filters — showing every request.</span>'}
        </div>
        <form class="filter-add" data-form="add-filter">
          <select name="field">${FIELDS.map((f) => opt(f.key, f.label)).join("")}</select>
          <select name="op">${Object.entries(OPS).map(([k, l]) => opt(k, l)).join("")}</select>
          <input name="value" placeholder="value (comma-separate lists)">
          <button class="btn small" type="submit">Add filter</button>
        </form>
        <div class="row3">
          <label>Sort by<select data-change="spec-sort">${FIELDS.map((f) => opt(f.key, f.label, spec.sort_field === f.key)).join("")}</select></label>
          <label>Direction<select data-change="spec-dir">${opt("asc", "Ascending", spec.sort_dir === "asc")}${opt("desc", "Descending", spec.sort_dir === "desc")}</select></label>
          <label>Group by<select data-change="spec-group">${opt("none", "No grouping")}${FIELDS.map((f) => opt(f.key, f.label, spec.group_by === f.key)).join("")}</select></label>
        </div>
      </details>
    </div>

    <div class="card flush">
      <div class="card-head pad">
        <div><h3>Preview</h3><p class="muted small">${view.rows.length} row${view.rows.length === 1 ? "" : "s"} · updates live as requests change</p></div>
        <div class="btn-row">
          <button class="btn small" data-act="export-view-csv">${icon("download")} CSV</button>
          <button class="btn small primary" data-act="export-view-xlsx">${icon("download")} Excel</button>
        </div>
      </div>
      ${tableHTML(view.columns, view.rows, { groupBy: spec.group_by, empty: "No requests match this sheet." })}
    </div>

    <div class="card">
      <h3>My saved sheets</h3>
      ${S.views.length ? `<ul class="saved">${S.views.map((v) => `
        <li class="${v.id === b.viewId ? "on" : ""}">
          <button class="link-btn" data-act="load-view" data-id="${esc(v.id)}">${esc(v.name)}</button>
          ${v.pinned ? `<span class="badge b-pin">${icon("pin", "ico xs")} Pinned</span>` : ""}
          <span class="grow"></span>
          <button class="btn small" data-act="toggle-pin" data-id="${esc(v.id)}">${v.pinned ? "Unpin" : "Pin"}</button>
          <button class="btn small" data-act="export-saved-view" data-id="${esc(v.id)}">Excel</button>
          <button class="icon-btn" data-act="delete-view" data-id="${esc(v.id)}" aria-label="Delete sheet">${icon("trash")}</button>
        </li>`).join("")}</ul>` : `<p class="muted small">Saved sheets appear here. Pin one and it's always visible on your dashboard.</p>`}
    </div>
  </div>`;
}

async function generateSpec() {
  const b = S.builder;
  const prompt = b.prompt.trim();
  if (!prompt) { toast("Describe the sheet you want first", "err"); return; }
  b.busy = true;
  render();
  try {
    const token = await store.accessToken();
    const res = await fetch(CONFIG.AI_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ prompt, today: todayISO(), current: b.viewId ? b.spec : null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `AI assistant unavailable (${res.status})`);
    b.spec = sanitizeSpec(data.spec);
    b.note = b.spec.explanation || "Sheet built by the AI assistant.";
    b.source = "ai";
  } catch (e) {
    console.warn("AI assistant fallback:", e.message);
    const local = localSpecFromPrompt(prompt);
    if (b.viewId) local.name = b.spec.name;
    b.spec = local;
    b.note = `${local.explanation} (AI assistant not reachable: ${e.message})`;
    b.source = "local";
  }
  b.busy = false;
  render();
}

function exportView(spec, name) {
  const view = applyView(spec, S.requests, S.me);
  downloadWorkbook(`${name} ${todayISO()}`, [viewTab(name, view)]);
}

/* ------------------------------------------------------------------- team */
function pageTeam() {
  return `
  <p class="muted">Managers approve and reject requests and see everything. Owner Relations can submit requests, see everything, and keep their own action items. New sign-ups start as Owner Relations.</p>
  <div class="card flush"><div class="table-wrap"><table class="grid">
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Requests</th></tr></thead>
    <tbody>${S.profiles.map((p) => `
      <tr><td data-label="Name"><strong>${esc(p.full_name || "—")}</strong>${p.id === S.me.id ? ' <span class="muted small">(you)</span>' : ""}</td>
      <td data-label="Email">${esc(p.email || "")}</td>
      <td data-label="Role">${p.id === S.me.id ? esc(ROLE_LABEL[p.role]) : `<select data-change="set-role" data-id="${esc(p.id)}">${Object.entries(ROLE_LABEL).map(([k, l]) => opt(k, l, p.role === k)).join("")}</select>`}</td>
      <td data-label="Requests">${S.requests.filter((r) => r.requested_by === p.id).length}</td></tr>`).join("")}
    </tbody></table></div></div>`;
}

const PAGES = {
  dashboard: pageDashboard, requests: pageRequests, new: pageNew, approvals: pageApprovals,
  actions: pageActions, builder: pageBuilder, team: pageTeam,
};

/* -------------------------------------------------------------- handlers */
const CLICK = {
  async "demo-login"(el) { S.me = await store.signInAs(el.dataset.id); startApp(); },
  "demo-reset"() { store.resetDemo(); toast("Demo data reset"); renderLogin(); },
  "login-tab"(el) { renderLogin(el.dataset.mode); },
  async forgot() {
    const email = app.querySelector('input[name="email"]')?.value.trim();
    if (!email) { toast("Enter your email first", "err"); return; }
    await guard(() => store.resetPassword(email), "Password reset email sent");
  },
  async signout() { await store.signOut(); location.hash = ""; location.reload(); },
  "open-request"(el) { openRequest(el.dataset.id); },
  "close-modal"() { closeModal(); },
  "filter-project"(el) { S.reqFilter = { q: "", project: el.dataset.project, status: "" }; location.hash = "#/requests"; },
  "export-requests"() {
    const rows = filteredRequests();
    downloadWorkbook(`BDR FF&E Requests ${todayISO()}`, [requestsTab("Overall Requests", rows)]);
  },
  "remove-photo"(el) { S.draft.photos.splice(Number(el.dataset.idx), 1); document.getElementById("photo-list").innerHTML = photoListHTML(); },
  "quick-review"(el) { setRequestStatus(el.dataset.id, el.dataset.status, ""); },
  "quick-status"(el) { setRequestStatus(el.dataset.id, el.dataset.status); },
  review(el) {
    const note = modalRoot.querySelector("#review-note")?.value.trim() || "";
    if (el.dataset.status === "Rejected" && !note) { toast("Add a note explaining the rejection", "err"); modalRoot.querySelector("#review-note")?.focus(); return; }
    setRequestStatus(el.dataset.id, el.dataset.status, note);
  },
  "cancel-request"(el) { if (confirm("Cancel this request?")) setRequestStatus(el.dataset.id, "Cancelled"); },
  async "add-to-actions"(el) {
    const r = S.requests.find((x) => x.id === el.dataset.id);
    const item = await guard(() => store.saveAction({
      title: `Follow up: ${r.item_needed}`.slice(0, 200), status: "Not Started", priority: r.priority || "Normal",
      due_date: r.needed_by, linked_ticket: ticketLabel(r.ticket_no), category: r.project, notes: `Bldg ${r.buildings} · Room ${r.rooms}`,
    }), "Added to your action items");
    if (item) { S.actions = [...S.actions.filter((a) => a.id !== item.id), item]; openRequest(r.id); }
  },
  async "new-action"() {
    const item = await guard(() => store.saveAction({ title: "", status: "Not Started", priority: "Normal" }));
    if (!item) return;
    S.actions.push(item);
    S.actionFilter = "";
    render();
    app.querySelector(`.action[data-id="${CSS.escape(item.id)}"] .title-input`)?.focus();
  },
  async "delete-action"(el) {
    if (!confirm("Delete this action item?")) return;
    const ok = await guard(async () => { await store.deleteAction(el.dataset.id); return true; });
    if (ok) { S.actions = S.actions.filter((a) => a.id !== el.dataset.id); render(); }
  },
  "export-my-sheet"() {
    downloadWorkbook(`${S.me.full_name || "My"} Action Items ${todayISO()}`, [actionsTab(`${S.me.full_name || "My"} Items`, S.actions)]);
  },
  "export-combined"() {
    const all = S.requests.map((r) => toRow(r)).sort((a, b) => a.ticket.localeCompare(b.ticket));
    const tabs = [requestsTab("Overall Requests", all), actionsTab(`${S.me.full_name || "My"} Items`, S.actions)];
    S.views.forEach((v) => tabs.push(viewTab(v.name, applyView(v.spec, S.requests, S.me))));
    downloadWorkbook(`BDR FF&E Combined - ${S.me.full_name || "Me"} ${todayISO()}`, tabs);
  },
  example(el) { S.builder.prompt = el.dataset.text; render(); },
  "ai-generate"() { generateSpec(); },
  "new-view"() { S.builder = { ...S.builder, spec: defaultSpec(), viewId: null, pinned: false, note: "", prompt: "" }; render(); },
  async "save-view"() {
    const b = S.builder;
    const saved = await guard(() => store.saveView({ id: b.viewId || undefined, name: b.spec.name, prompt: b.prompt, spec: b.spec, pinned: b.pinned }), "Sheet saved");
    if (!saved) return;
    S.views = b.viewId ? S.views.map((v) => (v.id === saved.id ? saved : v)) : [...S.views, saved];
    b.viewId = saved.id;
    render();
  },
  "load-view"(el) {
    const v = S.views.find((x) => x.id === el.dataset.id);
    S.builder = { prompt: "", spec: sanitizeSpec(v.spec), viewId: v.id, pinned: !!v.pinned, busy: false, note: "", source: "" };
    if (S.route !== "builder") location.hash = "#/builder"; else render();
  },
  async "toggle-pin"(el) {
    const v = S.views.find((x) => x.id === el.dataset.id);
    const saved = await guard(() => store.saveView({ ...v, pinned: !v.pinned }));
    if (!saved) return;
    S.views = S.views.map((x) => (x.id === saved.id ? saved : x));
    if (S.builder.viewId === saved.id) S.builder.pinned = saved.pinned;
    render();
  },
  async "delete-view"(el) {
    if (!confirm("Delete this saved sheet?")) return;
    const ok = await guard(async () => { await store.deleteView(el.dataset.id); return true; });
    if (!ok) return;
    S.views = S.views.filter((v) => v.id !== el.dataset.id);
    if (S.builder.viewId === el.dataset.id) S.builder.viewId = null;
    render();
  },
  "export-saved-view"(el) { const v = S.views.find((x) => x.id === el.dataset.id); exportView(v.spec, v.name); },
  "export-view-xlsx"() { exportView(S.builder.spec, S.builder.spec.name); },
  "export-view-csv"() {
    const view = applyView(S.builder.spec, S.requests, S.me);
    downloadCsv(`${view.spec.name} ${todayISO()}`, viewTab(view.spec.name, view).columns, view.rows);
  },
  "remove-filter"(el) { S.builder.spec.filters.splice(Number(el.dataset.idx), 1); render(); },
};

const CHANGE = {
  "req-filter"(el) { S.reqFilter[el.dataset.key] = el.value; document.getElementById("req-table").innerHTML = requestsTableHTML(); },
  photos(el) { addPhotos([...el.files]); el.value = ""; },
  "photo-kind"(el) { S.draft.photos[Number(el.dataset.idx)].kind = el.value; el.closest(".photo-item").classList.toggle("needs", !el.value); },
  "action-filter"(el) { S.actionFilter = el.value; render(); },
  "action-done"(el) {
    const sel = el.closest(".action").querySelector('[data-field="status"]');
    sel.value = el.checked ? "Done" : "Not Started";
    saveActionField(el.dataset.id, "status", sel.value);
  },
  "action-field"(el) { saveActionField(el.dataset.id, el.dataset.field, el.value); },
  "spec-name"(el) { S.builder.spec.name = el.value.trim() || "Untitled sheet"; },
  "spec-pinned"(el) { S.builder.pinned = el.checked; },
  "spec-col"(el) {
    const cols = S.builder.spec.columns;
    if (el.checked) cols.push(el.dataset.key);
    else if (cols.length > 1) cols.splice(cols.indexOf(el.dataset.key), 1);
    S.builder.spec.columns = FIELDS.map((f) => f.key).filter((k) => cols.includes(k));
    render();
  },
  "spec-sort"(el) { S.builder.spec.sort_field = el.value; render(); },
  "spec-dir"(el) { S.builder.spec.sort_dir = el.value; render(); },
  "spec-group"(el) { S.builder.spec.group_by = el.value; render(); },
  async "set-role"(el) {
    const saved = await guard(() => store.setRole(el.dataset.id, el.value), "Role updated");
    if (saved) S.profiles = S.profiles.map((p) => (p.id === saved.id ? saved : p));
  },
};

const INPUT = {
  "req-search"(el) { S.reqFilter.q = el.value; document.getElementById("req-table").innerHTML = requestsTableHTML(); },
  "builder-prompt"(el) { S.builder.prompt = el.value; },
};

const SUBMIT = {
  async signin(form) {
    const fd = new FormData(form);
    const me = await guard(() => store.signIn(String(fd.get("email")).trim(), String(fd.get("password"))));
    if (me) { S.me = me; startApp(); }
  },
  async signup(form) {
    const fd = new FormData(form);
    const res = await guard(() => store.signUp(String(fd.get("name")).trim(), String(fd.get("email")).trim(), String(fd.get("password"))));
    if (res === null) renderLogin("signin", "Account created. Check your email to confirm it, then sign in.");
    else if (res) { S.me = res; startApp(); }
  },
  request(form) { submitRequest(form); },
  "add-filter"(form) {
    const fd = new FormData(form);
    const f = { field: String(fd.get("field")), op: String(fd.get("op")), value: String(fd.get("value") || "").trim() };
    if (!VALUELESS_OPS.includes(f.op) && !f.value) { toast("Enter a value for that filter", "err"); return; }
    S.builder.spec.filters.push(f);
    render();
  },
};

function delegate(root) {
  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !root.contains(el)) return;
    // Clicks inside the dialog shouldn't count as a click on the backdrop.
    if (el.classList.contains("modal-bg") && e.target.closest("[data-stop]")) return;
    e.preventDefault();
    CLICK[el.dataset.act]?.(el);
  });
  root.addEventListener("change", (e) => {
    const el = e.target.closest("[data-change]");
    if (el) CHANGE[el.dataset.change]?.(el);
    if (e.target.name === "project" && e.target.type === "radio") S.draft.project = e.target.value;
  });
  root.addEventListener("input", (e) => {
    const el = e.target.closest("[data-input]");
    if (el) INPUT[el.dataset.input]?.(el);
  });
  root.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-form]");
    if (!form) return;
    e.preventDefault();
    SUBMIT[form.dataset.form]?.(form);
  });
}

delegate(app);
delegate(modalRoot);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.modalId) closeModal(); });
boot();
