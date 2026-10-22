import { store } from "./store.js";
import { CONFIG } from "./config.js";
import {
  PROJECTS, AREAS, CURRENT, applySettings, setCurrentProject, STATUSES, OPEN_STATUSES, CLOSED_STATUSES, PRIORITIES, ACTION_STATUSES, PHOTO_KINDS, FIELDS, FIELD_MAP,
  OPS, VALUELESS_OPS, FULFILLMENT, PRICE_DISCLAIMER, money, toRow, todayISO, ticketLabel, isOverdue,
} from "./fields.js";
import { applyView, defaultSpec, sanitizeSpec, localSpecFromPrompt } from "./views.js";
import { downloadWorkbook, downloadCsv, requestsTab, viewTab, actionsTab } from "./export.js";
import { findMatches, rejectedMatch, DUP_THRESHOLD } from "./dedupe.js";
import { S, isManager, ROLE_LABEL, hooks } from "./state.js";
import { app, modalRoot, esc, slug, fmtDate, opt, badge, toast, guard, icon, tableHTML, initials } from "./ui.js";
import * as inventory from "./inventory.js";
import * as intake from "./intake.js";
import * as email from "./email.js";
import * as team from "./team.js";
import * as projects from "./projects.js";
import * as notes from "./notes.js";
import { notesBlock, followUpBanner, followUpsDue } from "./notes.js";
import * as settings from "./settings.js";
import * as outlook from "./outlook.js";
import * as help from "./help.js";
import * as files from "./files.js";
import * as review from "./review.js";
import * as spec from "./spec.js";

// `global` pages work before a project is chosen; the rest need one.
const NAV = [
  { id: "projects", label: "All Projects", global: true },
  { id: "project", label: "Project Home" },
  { id: "dashboard", label: "Dashboard" },
  { id: "requests", label: "All Requests" },
  { id: "email", label: "Email Requests", badge: "email" },
  { id: "new", label: "New Request" },
  { id: "spec", label: "Spec Sheet" },
  { id: "approvals", label: "Approvals", manager: true, badge: "pending" },
  { id: "files", label: "Files & Assistant" },
  { id: "inventory", label: "Inventory & Attic Stock" },
  { id: "import", label: "Import Spreadsheet", manager: true },
  { id: "actions", label: "My Action Items", global: true },
  { id: "builder", label: "Sheet Builder" },
  { id: "outlook", label: "My Outlook Report", global: true },
  { id: "team", label: "Team & Roles", manager: true, global: true },
  { id: "settings", label: "Settings", manager: true, global: true },
  { id: "help", label: "How to Use", global: true },
];
const NAV_ICON = { project: "dashboard", projects: "inventory", outlook: "outlook", settings: "settings", help: "help", files: "note", spec: "builder" };
const TITLES = {
  projects: "Projects", dashboard: "Dashboard", requests: "All Requests", email: "Email Requests", new: "New FF&E Request",
  approvals: "Approval Queue", inventory: "Inventory & Attic Stock", import: "Import Spreadsheet", actions: "My Action Items",
  builder: "Custom Sheet Builder", spec: "FF&E Spec Sheet", files: "Files & Assistant", outlook: "My Outlook FF&E Report", team: "Team & Roles", settings: "Settings", help: "How to Use",
};
const title = (route) => (route === "project" ? CURRENT.project : route === "area" ? S.areaName : TITLES[route]);
const MODULES = [inventory, intake, email, team, projects, notes, settings, outlook, help, files, review, spec];

function routeFromHash() {
  const r = decodeURIComponent(location.hash.replace(/^#\/?/, "")) || "projects";
  const fallback = S.project ? "dashboard" : "projects";
  if (r.startsWith("area/")) {
    S.areaName = r.slice(5);
    return S.project ? "area" : "projects";
  }
  const item = NAV.find((n) => n.id === r);
  if (!item || (item.manager && !isManager())) return fallback;
  if (!item.global && !S.project) return "projects";
  return r;
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  try { S.me = await store.currentUser(); } catch (e) { console.error(e); }
  if (S.me && store.passwordSetupNeeded()) return renderSetPassword();
  if (!S.me) return renderLogin();
  startApp();
}

let started = false;
// fresh: just signed in, so start on the Projects page.
async function startApp(fresh = false) {
  applySettings(await guard(() => store.getSettings()));
  const saved = fresh ? "" : projects.savedProject();
  if (saved && PROJECTS.includes(saved)) {
    S.project = saved;
    store.setScope(saved);
    setCurrentProject(saved);
  }
  await loadAll();
  if (!started) {
    started = true;
    store.subscribe(onRemoteChange);
    window.addEventListener("hashchange", () => { S.route = routeFromHash(); render(); window.scrollTo(0, 0); help.onRoute(); });
  }
  if (fresh || !S.project) history.replaceState(null, "", "#/projects");
  S.route = routeFromHash();
  render();
  help.maybeOfferTour();
}

async function loadAll() {
  await guard(async () => {
    const scoped = !!S.project;
    const [requests, actions, views, profiles, inv, moves, emails, summary, docs, specs] = await Promise.all([
      scoped ? store.listRequests() : [], store.listActions(), store.listViews(), isManager() ? store.listProfiles() : [],
      scoped ? store.listInventory() : [], scoped ? store.listMoves() : [], scoped ? store.listEmailRequests() : [],
      store.projectSummary(),
      // Files arrived in a later database update; don't let a missing table block everything else.
      scoped ? store.listDocuments().catch((e) => { console.warn("Files unavailable:", e.message); return []; }) : [],
      scoped ? store.listSpecItems().catch((e) => { console.warn("Spec sheet unavailable:", e.message); return []; }) : [],
    ]);
    Object.assign(S, { requests, actions, views, profiles, inventory: inv, moves, emails, summary, docs, specs, allRequests: null });
  });
}

async function onRemoteChange(kind) {
  if (kind === "profiles" || kind === "all") {
    const fresh = await guard(() => store.currentUser());
    if (!fresh) { toast("Your access was removed", "err"); setTimeout(() => CLICK.signout(), 1500); return; }
    if (fresh.role !== S.me.role) { S.me = fresh; toast(`Your role is now ${ROLE_LABEL[fresh.role]}`); }
  }
  if (kind === "all" || kind === "settings") applySettings(await guard(() => store.getSettings()));
  if (kind === "all") await loadAll();
  else if (kind === "settings") { /* lists updated above */ }
  else if (kind === "profiles") { if (isManager()) S.profiles = (await guard(() => store.listProfiles())) || S.profiles; }
  else if (!S.project) S.summary = (await guard(() => store.projectSummary())) || S.summary;
  else if (kind === "inventory") await guard(inventory.reloadInventory);
  else if (kind === "email") S.emails = (await guard(() => store.listEmailRequests())) || S.emails;
  else if (kind === "documents") S.docs = (await guard(() => store.listDocuments())) || S.docs;
  else if (kind === "specs") S.specs = (await guard(() => store.listSpecItems())) || S.specs;
  else {
    S.requests = (await guard(() => store.listRequests())) || S.requests;
    if (S.allRequests) S.allRequests = (await guard(() => store.listAllRequests())) || S.allRequests;
  }
  // Don't wipe a half-filled form or a field someone is typing in; just refresh the badges.
  const typing = document.activeElement?.matches?.("#app input, #app textarea, #app select");
  if (S.route === "new" || typing) updateBadges();
  else render();
  if (S.modalId) openRequest(S.modalId, true);
}

/* ------------------------------------------------------------------ login */
function renderLogin(mode = "signin", msg = "") {
  const demo = store.mode === "demo";
  app.innerHTML = `
  <div class="login">
    <div class="login-art">
      <div class="brand-mark lg">FF</div>
      <h1>FF&amp;E Tracker</h1>
      <p class="tagline">Requests · Inventory · Attic stock</p>
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
        ${CONFIG.ALLOW_SIGNUP ? `<div class="tabs">
          <button class="tab ${mode === "signin" ? "on" : ""}" data-act="login-tab" data-mode="signin">Sign in</button>
          <button class="tab ${mode === "signup" ? "on" : ""}" data-act="login-tab" data-mode="signup">Create account</button>
        </div>` : `<h2>Sign in</h2><p class="muted small">Ask a manager to invite you if you don't have an account yet.</p>`}
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

// After creating an account (or signing in before confirming), the person types
// the code from their confirmation email. The link in that email works too.
function renderVerify(email, msg = "") {
  app.innerHTML = `
  <div class="login">
    <div class="login-art">
      <div class="brand-mark lg">FF</div>
      <h1>FF&amp;E Tracker</h1>
      <p class="tagline">Requests · Inventory · Attic stock</p>
    </div>
    <div class="login-card">
      <h2>Check your email</h2>
      <p class="muted">We sent a confirmation email to <b>${esc(email)}</b>. Enter the code from it below, or just click the confirm link in the email, to finish creating your account.</p>
      ${msg ? `<p class="notice">${esc(msg)}</p>` : ""}
      <form data-form="verify-code" class="stack">
        <input type="hidden" name="email" value="${esc(email)}">
        <label>Verification code<input name="code" class="code-input" required inputmode="numeric" autocomplete="one-time-code"
          pattern="[0-9]{6,10}" maxlength="10" placeholder="••••••" aria-describedby="code-help"></label>
        <button class="btn primary" type="submit">Verify &amp; sign in</button>
      </form>
      <p class="muted small" id="code-help">Can't find it? Check Junk and the Other tab, or wait a minute. The code expires after an hour.</p>
      <div class="btn-row">
        <button type="button" class="btn small" data-act="resend-confirm" data-email="${esc(email)}">Send a new code</button>
        <button type="button" class="btn link" data-act="login-tab" data-mode="signin">Back to sign in</button>
      </div>
    </div>
  </div>`;
  app.querySelector(".code-input")?.focus();
}

// Shown after someone opens an invite or password-reset email.
function renderSetPassword(msg = "") {
  app.innerHTML = `
  <div class="login">
    <div class="login-art">
      <div class="brand-mark lg">FF</div>
      <h1>FF&amp;E Tracker</h1>
      <p class="tagline">Requests · Inventory · Attic stock</p>
    </div>
    <div class="login-card">
      <h2>Welcome${S.me?.full_name ? `, ${esc(S.me.full_name.split(" ")[0])}` : ""}</h2>
      <p class="muted">Choose a password to finish setting up your account.</p>
      ${msg ? `<p class="notice">${esc(msg)}</p>` : ""}
      <form data-form="set-password" class="stack">
        <label>New password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
        <label>Confirm password<input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label>
        <button class="btn primary" type="submit">Save password &amp; continue</button>
      </form>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- shell */
function pendingCount() { return S.requests.filter((r) => ["Pending", "Duplicate"].includes(r.status)).length; }
function badgeCount(kind) {
  if (kind === "email") return email.emailsToReview();
  if (kind === "pending") return pendingCount() + email.emailsToReview();
  return 0;
}

function render() {
  const nav = NAV.filter((n) => (!n.manager || isManager()) && (n.global || S.project));
  app.innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand"><div class="brand-mark">FF</div><div><strong>FF&amp;E Tracker</strong><small>Resort projects</small></div></div>
      ${S.project ? `<a class="cur-project" href="#/projects" data-tour="switch"><small>Project</small><strong>${esc(S.project)}</strong><span>Switch ⇄</span></a>` : ""}
      <nav>${nav.map((n) => `
        <a href="#/${n.id}" class="nav-item ${S.route === n.id || (n.id === "project" && S.route === "area") ? "on" : ""}" data-tour="nav-${n.id}">${icon(NAV_ICON[n.id] || n.id)}<span>${n.label}</span>
        ${n.badge ? `<em class="count" data-badge="${n.badge}">${badgeCount(n.badge) || ""}</em>` : ""}</a>`).join("")}
      </nav>
      <div class="me">
        <span class="avatar">${esc(initials(S.me.full_name))}</span>
        <div><strong>${esc(S.me.full_name || S.me.email)}</strong><small>${esc(ROLE_LABEL[S.me.role] || S.me.role)}</small></div>
        <button class="icon-btn" data-act="signout" title="Sign out" aria-label="Sign out">${icon("logout")}</button>
      </div>
    </aside>
    <main>
      <header class="topbar">
        <h1>${esc(title(S.route))}</h1>
        <span class="mode ${store.mode}">${store.mode === "cloud" ? "Live · shared" : "Demo · this browser only"}</span>
      </header>
      <section class="content">${PAGES[S.route]()}</section>
    </main>
  </div>`;
  for (const m of MODULES) m.afterRender?.();
}

function updateBadges() {
  app.querySelectorAll("[data-badge]").forEach((el) => { el.textContent = badgeCount(el.dataset.badge) || ""; });
}


/* ------------------------------------------------------------- dashboard */
function pageDashboard() {
  const today = todayISO();
  const rows = S.requests.map((r) => toRow(r, today));
  const open = rows.filter((r) => OPEN_STATUSES.includes(r.status));
  const overdue = rows.filter((r) => isOverdue(r, today));
  const month = today.slice(0, 7);
  const doneMonth = rows.filter((r) => r.status === "Fulfilled" && (r._raw.fulfilled_at || r._raw.updated_at || "").slice(0, 7) === month);
  const pinned = S.views.filter((v) => v.pinned);
  const myOpenActions = S.actions.filter((a) => a.status !== "Done").length;
  const lowStock = S.inventory.filter(inventory.isLow).length;

  return `
  <div class="kpis">
    <div class="kpi"><span>Open requests</span><strong>${open.length}</strong></div>
    <a class="kpi ${isManager() ? "link" : ""}" ${isManager() ? 'href="#/approvals"' : ""}><span>Awaiting approval</span><strong>${pendingCount()}</strong></a>
    <div class="kpi ${overdue.length ? "warn" : ""}"><span>Overdue</span><strong>${overdue.length}</strong></div>
    <div class="kpi"><span>Fulfilled this month</span><strong>${doneMonth.length}</strong></div>
    <a class="kpi link ${email.emailsToReview() ? "warn-soft" : ""}" href="#/email"><span>Emailed requests to review</span><strong>${email.emailsToReview()}</strong></a>
    <a class="kpi link ${lowStock ? "warn" : ""}" href="#/inventory"><span>Low-stock items</span><strong>${lowStock}</strong></a>
    <a class="kpi link" href="#/actions"><span>My open action items</span><strong>${myOpenActions}</strong></a>
    <button class="kpi link ${followUpsDue(0) ? "warn" : ""}" data-act="show-follow-ups"><span>Follow-ups this week</span><strong>${followUpsDue(7)}</strong></button>
  </div>

  <div class="section-head">
    <h2 class="section">Sub-projects</h2>
    <a class="btn small" href="#/project">See all</a>
  </div>
  ${projects.subProjectCards()}

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
    ["ticket", "sub_project", "buildings", "rooms", "item_needed", "needed_by", "status", "requester_name"].map((k) => FIELD_MAP[k]),
    rows, { limit: 8, empty: "No requests yet. Submit the first one from New Request." })}</div>`;
}

/* -------------------------------------------------------------- requests */
function filteredRequests() {
  const { q, sub, status } = S.reqFilter;
  const needle = q.trim().toLowerCase();
  const all = S.reqScope === "all";
  return (all ? S.allRequests || [] : S.requests).map((r) => toRow(r)).filter((row) =>
    (all || !sub || row.sub_project === sub) &&
    (!status || (status === "open" ? OPEN_STATUSES.includes(row.status) : status === "overdue" ? isOverdue(row)
      : status === "closed-out" ? ["Rejected", "Cancelled"].includes(row.status)
      : status === "follow-up" ? !!row.follow_up_on : row.status === status)) &&
    (!needle || ["ticket", "buildings", "rooms", "item_needed", "ffe_tag", "spec", "requester_name", "details"].some((k) => String(row[k]).toLowerCase().includes(needle))));
}

const REQUEST_COLS = ["ticket", "sub_project", "buildings", "rooms", "item_needed", "ffe_tag", "fulfillment", "needed_by", "priority", "status", "requester_name", "notes"];

function requestsTableHTML() {
  const all = S.reqScope === "all";
  if (all && !S.allRequests) return '<p class="muted small more">Loading every project…</p>';
  const rows = filteredRequests().sort((a, b) => (all ? a.project.localeCompare(b.project) : 0) || (b._raw.created_at || "").localeCompare(a._raw.created_at || ""));
  const cols = all ? ["project", ...REQUEST_COLS] : REQUEST_COLS;
  return `<p class="muted small">${rows.length} request${rows.length === 1 ? "" : "s"}${all ? " across all projects" : ""}</p>` +
    tableHTML(cols.map((k) => FIELD_MAP[k]), rows, { empty: "No requests match these filters.", groupBy: all ? "project" : "none" });
}

async function loadAllRequests() {
  const list = await guard(() => store.listAllRequests());
  S.allRequests = list || [];
  const box = document.getElementById("req-table");
  if (box) box.innerHTML = requestsTableHTML();
}

function pageRequests() {
  const f = S.reqFilter;
  return `
  <div class="seg-row" role="tablist" aria-label="Which requests">
    <button class="seg ${S.reqScope !== "all" ? "on" : ""}" data-act="req-scope" data-scope="project">${esc(CURRENT.project)}</button>
    <button class="seg ${S.reqScope === "all" ? "on" : ""}" data-act="req-scope" data-scope="all">All projects</button>
  </div>
  <div class="toolbar">
    <input type="search" placeholder="Search ticket, building, room, item, tag…" value="${esc(f.q)}" data-input="req-search" class="grow">
    ${AREAS.length && S.reqScope !== "all" ? `<select data-change="req-filter" data-key="sub">${opt("", "All sub-projects")}${AREAS.map((p) => opt(p, p, f.sub === p)).join("")}</select>` : ""}
    <select data-change="req-filter" data-key="status">${opt("", "All statuses")}${opt("open", "Open (not closed)", f.status === "open")}${opt("overdue", "Overdue", f.status === "overdue")}${opt("closed-out", "Rejected & cancelled (follow up)", f.status === "closed-out")}${opt("follow-up", "Has a follow-up", f.status === "follow-up")}${STATUSES.map((s) => opt(s, s, f.status === s)).join("")}</select>
    <button class="btn" data-act="export-requests">${icon("download")} Export</button>
    <a class="btn primary" href="#/new">${icon("new")} New request</a>
  </div>
  <div class="card flush" id="req-table">${requestsTableHTML()}</div>`;
}

/* ----------------------------------------------------------- new request */
function pageNew() {
  const d = S.draft;
  const item = spec.specById(d.specId);
  return `
  <form class="request-form" data-form="request" novalidate>
    <p class="lead">Be as specific as possible — the more detail here, the faster this gets approved and filled.</p>

    <fieldset class="card">
      <legend>1. Attic stock or new? <em>*</em></legend>
      <div class="chip-select stack-sm" role="radiogroup" aria-label="Attic stock or order new">
        ${Object.entries(FULFILLMENT).map(([k, label]) => `<label class="chip"><input type="radio" name="fulfillment" value="${k}" ${d.fulfillment === k ? "checked" : ""} data-change="req-fulfillment" required><span>${esc(label)}</span></label>`).join("")}
      </div>
    </fieldset>

    <fieldset class="card">
      <legend>2. Where</legend>
      <p class="muted small">Project: <b>${esc(CURRENT.project)}</b>${AREAS.length ? " · choose the sub-project" : ""}</p>
      ${AREAS.length ? `<div class="chip-select" role="radiogroup" aria-label="Sub-project">
        ${AREAS.map((p) => `<label class="chip"><input type="radio" name="sub_project" value="${esc(p)}" ${d.sub === p ? "checked" : ""} data-change="req-sub" required><span>${esc(p)}</span></label>`).join("")}
      </div>` : ""}
      <div class="row2">
        <label>Building(s) <em>*</em><input name="buildings" required placeholder="e.g. 89, or 89 & 90"></label>
        <label>Room number(s) <em>*</em><input name="rooms" required placeholder="e.g. 8902, 8904 — or “Lobby”"></label>
      </div>
    </fieldset>

    <fieldset class="card">
      <legend>3. What</legend>
      <div id="spec-pick">${spec.specSelectHTML(d.sub, d.specId)}</div>
      <div id="spec-price">${spec.priceHTML(item, 1)}</div>
      <label>What do you need? <em>*</em><textarea name="item_needed" required rows="3" placeholder="Describe the item and what's wrong or what's needed">${esc(item?.name || "")}</textarea></label>
      <div class="row2">
        <label>FF&amp;E tag # <em>*</em><input name="ffe_tag" required placeholder="Tag on the item, e.g. FFE-COV-OD-114" value="${esc(item?.ffe_tag || "")}" data-input="req-tag"></label>
        <label>Specification <span class="muted">(manufacturer, model, finish, size)</span><input name="spec" placeholder="e.g. Sunbrella Canvas Navy, 24×24×4" value="${esc(item?.spec || "")}"></label>
      </div>
      <div id="attic-hint">${d.fulfillment && d.fulfillment !== "order" ? spec.atticHTML(item?.ffe_tag, d.sub) : ""}</div>
      <div class="row2">
        <label>Quantity <em>*</em><input name="quantity" type="number" min="1" value="1" required data-input="req-qty"></label>
        <label>Desired delivery date <em>*</em><input name="needed_by" type="date" required min="${todayISO()}"></label>
      </div>
      <p class="muted small">Managers set the priority after approving.</p>
    </fieldset>

    <fieldset class="card">
      <legend>4. Photos <em>*</em></legend>
      <p class="muted small">Attach at least one photo. For each one, choose whether it's a <b>concept image</b> (what the item should look like) or <b>proof of damage</b>.</p>
      <label class="drop">
        ${icon("camera", "ico lg")}
        <span>Tap to take or choose photos</span>
        <input type="file" accept="image/*" multiple data-change="photos">
      </label>
      <div id="photo-list" class="photo-list">${photoListHTML()}</div>
    </fieldset>

    <fieldset class="card">
      <legend>5. Anything else</legend>
      <label>Additional details <span class="muted">(access notes, vendor, guest impact…)</span><textarea name="details" rows="3"></textarea></label>
    </fieldset>

    <div class="form-actions">
      <span class="muted small" id="form-error" role="alert"></span>
      <button class="btn primary lg" type="submit">Submit request</button>
    </div>
  </form>`;
}

// Live bits of the request form: spec list for the sub-project, price, attic stock on hand.
function refreshSpecPrice(form) {
  const box = form.querySelector("#spec-price");
  if (box) box.innerHTML = spec.priceHTML(spec.specById(S.draft.specId), form.elements.quantity?.value);
}
function refreshAtticHint(form) {
  const box = form.querySelector("#attic-hint");
  if (box) box.innerHTML = S.draft.fulfillment && S.draft.fulfillment !== "order" ? spec.atticHTML(form.elements.ffe_tag.value, S.draft.sub) : "";
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
    project: CURRENT.project, sub_project: v("sub_project"), buildings: v("buildings"), rooms: v("rooms"), item_needed: v("item_needed"),
    ffe_tag: v("ffe_tag"), spec: v("spec"), quantity: Math.max(1, parseInt(v("quantity"), 10) || 1),
    needed_by: v("needed_by"), details: v("details"), fulfillment: v("fulfillment"),
  };
  const picked = spec.specById(S.draft.specId);
  if (picked) Object.assign(fields, { spec_item_id: picked.id, unit_price: picked.unit_price ?? null });
  const missing = [];
  if (!fields.fulfillment) missing.push("attic stock or order new");
  if (AREAS.length && !fields.sub_project) missing.push("sub-project");
  if (!fields.buildings) missing.push("building(s)");
  if (!fields.rooms) missing.push("room number(s)");
  if (!fields.item_needed) missing.push("what you need");
  if (!fields.ffe_tag) missing.push("FF&E tag");
  if (!fields.needed_by) missing.push("desired delivery date");
  if (!S.draft.photos.length) missing.push("at least one photo");
  form.querySelectorAll("[required]").forEach((el) => el.classList.toggle("invalid", !el.value.trim() && el.type !== "radio"));
  if (missing.length) { err.textContent = `Please add: ${missing.join(", ")}.`; return; }
  if (fields.needed_by < todayISO()) { err.textContent = "The desired delivery date can't be in the past."; return; }
  if (S.draft.photos.some((p) => !p.kind)) { err.textContent = "Choose “Concept image” or “Proof of damage” for every photo."; return; }
  err.textContent = "";

  // Catch the same request being submitted twice before a manager has to review both.
  const open = S.requests.filter((r) => !["Rejected", "Cancelled", "Fulfilled", "Duplicate"].includes(r.status));
  const [dup] = findMatches(fields, open, 1);
  if (dup && dup.score >= DUP_THRESHOLD && !confirm(
    `This looks like ${ticketLabel(dup.item.ticket_no)} (${dup.item.status}): “${dup.item.item_needed}”, ${dup.reasons.join(", ")}.\n\nSubmit it anyway as a separate request?`)) {
    openRequest(dup.item.id);
    return;
  }
  // Something managers already rejected goes to Duplicate requests instead of the approval queue.
  const again = rejectedMatch(fields, S.requests);
  if (again) Object.assign(fields, { status: "Duplicate", duplicate_of: again.root.id });

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Submitting…";
  const created = await guard(() => store.createRequest(fields, S.draft.photos));
  btn.disabled = false;
  btn.textContent = "Submit request";
  if (!created) return;
  S.requests = [created, ...S.requests.filter((r) => r.id !== created.id)];
  S.draft = { photos: [], sub: "", specId: "", fulfillment: "" };
  toast(again
    ? `${ticketLabel(created.ticket_no)} submitted. It's like ${ticketLabel(again.root.ticket_no)}, which was rejected, so managers will see them together.`
    : `${ticketLabel(created.ticket_no)} submitted for approval`);
  location.hash = "#/requests";
  openRequest(created.id);
  email.linkEmailsToNewRequest(created);
}

/* ------------------------------------------------------------- approvals */
// Drafts: rejected requests that can still be approved later. A rejected
// duplicate is folded into the original it repeats, so each need shows once.
function draftRequests() {
  const ids = new Set(S.requests.map((r) => r.id));
  return S.requests.filter((r) => r.status === "Rejected" && !(r.duplicate_of && ids.has(r.duplicate_of)));
}
const repeatsOf = (id) => S.requests.filter((r) => r.duplicate_of === id);
const duplicateRequests = () => S.requests.filter((r) => r.status === "Duplicate");

function priorityPicker(r, label = "Priority") {
  return `<label class="prio-pick" title="Managers set the priority after approving">${label}
    <select data-change="set-priority" data-id="${esc(r.id)}">${PRIORITIES.map((p) => opt(p, p, (r.priority || "Normal") === p)).join("")}</select></label>`;
}

function pageApprovals() {
  const today = todayISO();
  const byNeeded = (a, b) => a.needed_by.localeCompare(b.needed_by);
  const pending = S.requests.filter((r) => r.status === "Pending").map((r) => toRow(r, today)).sort(byNeeded);
  const active = S.requests.filter((r) => ["Approved", "In Progress"].includes(r.status)).map((r) => toRow(r, today)).sort(byNeeded);
  const dups = duplicateRequests();
  const drafts = draftRequests().sort((a, b) => (b.reviewed_at || "").localeCompare(a.reviewed_at || ""));
  const tab = S.approvalTab;
  const tabs = `<div class="seg-row" role="tablist" aria-label="Approvals">
    ${[["pending", "To approve", pending.length], ["active", "Approved & in progress", active.length], ["duplicates", "Duplicate requests", dups.length], ["drafts", "Drafts (rejected)", drafts.length]]
      .map(([k, label, n]) => `<button class="seg ${tab === k ? "on" : ""}" data-act="ap-tab" data-tab="${k}">${label} <span>${n}</span></button>`).join("")}
  </div>`;
  const summary = (row) => `
        <div class="ap-top"><strong class="mono">${esc(row.ticket)}</strong> ${badge(row.sub_project || row.project, "proj")} ${row.fulfillment ? badge(row.fulfillment, "inv") : ""} ${row.priority !== "Normal" && !["Pending", "Duplicate"].includes(row.status) ? badge(row.priority, `p-${slug(row.priority)}`) : ""}</div>
        <h3>${esc(row.item_needed)}</h3>
        <p class="muted small">Bldg ${esc(row.buildings)} · Room ${esc(row.rooms)} · Tag ${esc(row.ffe_tag)} · Qty ${esc(row.quantity)}${row.est_cost !== "" ? ` · Est. ${esc(money(row.est_cost))}` : ""}</p>
        <p class="small">Delivery by <span class="${isOverdue(row, today) ? "overdue" : ""}">${esc(fmtDate(row.needed_by))}</span> · from ${esc(row.requester_name)} · ${row.concept_photos + row.damage_photos} photo(s)</p>`;
  const card = (row) => `
    <div class="approval">
      <div class="ap-main" data-act="open-request" data-id="${esc(row._raw.id)}">${summary(row)}</div>
      <div class="ap-actions">
        ${row.status === "Pending" ? `
          <button class="btn approve" data-act="quick-review" data-id="${esc(row._raw.id)}" data-status="Approved">Approve</button>
          <button class="btn reject" data-act="open-request" data-id="${esc(row._raw.id)}">Reject…</button>` : `
          ${badge(row.status)}
          ${priorityPicker(row._raw)}
          ${row.status === "Approved" ? `<button class="btn small" data-act="quick-status" data-id="${esc(row._raw.id)}" data-status="In Progress">Start work</button>` : ""}
          <button class="btn small" data-act="quick-status" data-id="${esc(row._raw.id)}" data-status="Fulfilled">Mark fulfilled</button>`}
      </div>
    </div>`;
  const original = (r) => S.requests.find((x) => x.id === r.duplicate_of);
  const dupCard = (r) => {
    const row = toRow(r, today);
    const o = original(r);
    return `
    <div class="approval dup">
      <div class="ap-main" data-act="open-request" data-id="${esc(r.id)}">${summary(row)}
        ${o ? `<div class="dup-of" data-act="open-request" data-id="${esc(o.id)}">Same as <b class="mono">${esc(ticketLabel(o.ticket_no))}</b> ${badge(o.status)} “${esc(o.item_needed)}”
          ${o.status === "Rejected" ? `<span class="muted small">rejected by ${esc(o.reviewer_name || "a manager")} ${esc(fmtDate(o.reviewed_at))}${o.review_note ? `: ${esc(o.review_note)}` : ""}</span>` : ""}</div>` : ""}
      </div>
      <div class="ap-actions">
        <button class="btn approve" data-act="quick-review" data-id="${esc(r.id)}" data-status="Approved">Approve</button>
        <button class="btn reject" data-act="dup-reject" data-id="${esc(r.id)}" title="Files it with the original in Drafts">Reject</button>
      </div>
    </div>`;
  };
  const draftCard = (r) => {
    const row = toRow(r, today);
    const again = repeatsOf(r.id);
    return `
    <div class="approval draft">
      <div class="ap-main" data-act="open-request" data-id="${esc(r.id)}">${summary(row)}
        <p class="small muted">Rejected by ${esc(r.reviewer_name || "a manager")} ${esc(fmtDate(r.reviewed_at))}${r.review_note ? `: “${esc(r.review_note)}”` : ""}</p>
        ${again.length ? `<p class="small"><b>Requested again ${again.length}×</b> ${again.map((x) => `<span class="mono">${esc(ticketLabel(x.ticket_no))}</span>`).join(", ")}</p>` : ""}
      </div>
      <div class="ap-actions"><button class="btn approve" data-act="quick-review" data-id="${esc(r.id)}" data-status="Approved">Approve now</button></div>
    </div>`;
  };
  const emailNote = email.emailsToReview() ? `<a class="card callout-link" href="#/email">${icon("email")} <span><b>${email.emailsToReview()} emailed request${email.emailsToReview() === 1 ? "" : "s"}</b> waiting to be turned into tickets. Duplicates were already filed away.</span> <span class="btn small">Review</span></a>` : "";

  if (tab === "active") {
    return `${tabs}<p class="muted small">Set each one's priority, then move it to In Progress and Fulfilled. Fulfilled requests are kept as history on each project and sub-project page.</p>
      ${active.length ? active.map(card).join("") : `<div class="empty card">No approved work in progress.</div>`}`;
  }
  if (tab === "duplicates") {
    return `${tabs}<p class="muted small">New requests that match something already rejected. Approve one to put it back in the queue as approved, or reject it to file it with the original in Drafts (it won't be listed twice).</p>
      ${dups.length ? dups.map(dupCard).join("") : `<div class="empty card">No duplicate requests.</div>`}`;
  }
  if (tab === "drafts") {
    return `${tabs}<p class="muted small">Rejected requests stay here so you can approve them later. Repeat requests for the same thing are counted on the original instead of listed again.</p>
      ${drafts.length ? drafts.map(draftCard).join("") : `<div class="empty card">No rejected requests.</div>`}`;
  }
  if (review.RV.mode === "swipe") return `${tabs}${review.toggleHTML()}${review.swipeHTML()}`;
  return `${tabs}${review.toggleHTML()}${emailNote}
    ${pending.length ? pending.map(card).join("") : `<div class="empty card">All caught up — nothing waiting for approval.</div>`}`;
}

/* ---------------------------------------------------------- request modal */
async function openRequest(id, refresh = false) {
  const r = S.requests.find((x) => x.id === id) || S.allRequests?.find((x) => x.id === id);
  if (!r) { closeModal(); return; }
  if (refresh && !modalRoot.innerHTML) return;
  S.modalId = id;
  const row = toRow(r);
  const mine = r.requested_by === S.me.id;
  const photos = Array.isArray(r.photos) ? r.photos : [];
  const linked = S.actions.some((a) => a.linked_ticket === row.ticket);
  const keepNote = modalRoot.querySelector("#review-note")?.value || "";
  const field = (label, value) => value === "" || value == null ? "" : `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const pool = S.allRequests || S.requests;
  const dupOf = r.duplicate_of && pool.find((x) => x.id === r.duplicate_of);
  const repeats = pool.filter((x) => x.duplicate_of === r.id);

  modalRoot.innerHTML = `
  <div class="modal-bg" data-act="close-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(row.ticket)}" data-stop>
      <header class="modal-head">
        <div><span class="mono muted">${esc(row.ticket)}</span><h2>${esc(row.item_needed)}</h2>
          <div class="btn-row">${badge(row.status)} ${badge(row.sub_project || row.project, "proj")} ${row.priority !== "Normal" && !["Pending", "Duplicate"].includes(r.status) ? badge(row.priority, `p-${slug(row.priority)}`) : ""}</div></div>
        <button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button>
      </header>
      <dl class="facts">
        ${field("Project", esc(row.project))}
        ${field("Sub-project", esc(row.sub_project))}
        ${field("Building(s)", esc(row.buildings))}
        ${field("Room(s)", esc(row.rooms))}
        ${field("FF&E tag", `<span class="mono">${esc(row.ffe_tag)}</span>`)}
        ${field("Specification", esc(row.spec))}
        ${field("Quantity", esc(row.quantity))}
        ${field("Attic stock or new", esc(row.fulfillment))}
        ${row.unit_price !== "" ? field("Item price", `${esc(money(row.unit_price))} each · ${esc(money(row.est_cost))} for ${esc(row.quantity)}<div class="disclaimer">${esc(PRICE_DISCLAIMER)}</div>`) : ""}
        ${isManager() && ["Approved", "In Progress", "Fulfilled"].includes(r.status) ? field("Priority", priorityPicker(r, "")) : ""}
        ${field("Desired delivery", `<span class="${isOverdue(row) ? "overdue" : ""}">${esc(fmtDate(row.needed_by))}${isOverdue(row) ? " · overdue" : ""}</span>`)}
        ${field("Requested by", `${esc(row.requester_name)} · ${esc(fmtDate(row.created_at))}`)}
        ${row.reviewer_name ? field("Reviewed by", `${esc(row.reviewer_name)} · ${esc(fmtDate(row.reviewed_at))}`) : ""}
        ${r.status === "Fulfilled" ? field("Fulfilled", `${esc(fmtDate(row.fulfilled_at))}${row.fulfilled_by_name ? ` · ${esc(row.fulfilled_by_name)}` : ""}`) : ""}
      </dl>
      ${dupOf ? `<div class="dup-of" data-act="open-request" data-id="${esc(dupOf.id)}">${r.status === "Duplicate" ? "Duplicate of" : "Same as"} <b class="mono">${esc(ticketLabel(dupOf.ticket_no))}</b> ${badge(dupOf.status)} “${esc(dupOf.item_needed)}”${dupOf.review_note ? ` <span class="muted small">· ${esc(dupOf.review_note)}</span>` : ""}</div>` : ""}
      ${repeats.length ? `<p class="small">Requested again ${repeats.length}×: ${repeats.map((x) => `<button class="link-btn mono" data-act="open-request" data-id="${esc(x.id)}">${esc(ticketLabel(x.ticket_no))}</button>`).join(", ")}</p>` : ""}
      ${row.details ? `<div class="note-block"><dt>Additional details</dt><p>${esc(row.details)}</p></div>` : ""}
      ${row.review_note ? `<div class="note-block review"><dt>Manager note</dt><p>${esc(row.review_note)}</p></div>` : ""}
      ${followUpBanner("requests", r)}
      ${notesBlock("requests", r)}
      ${["concept", "damage"].map((kind) => {
        const list = photos.filter((p) => p.kind === kind);
        return list.length ? `<h3 class="ph-head">${esc(PHOTO_KINDS[kind])} <span class="muted">(${list.length})</span></h3>
          <div class="gallery">${list.map((p) => `<a class="ph" data-path="${esc(p.path)}" target="_blank" rel="noopener"><span class="ph-loading"></span></a>`).join("")}</div>` : "";
      }).join("")}
      <footer class="modal-foot">
        ${isManager() && ["Pending", "Duplicate"].includes(r.status) ? `
          <label class="grow">Note to requester <span class="muted">(required to reject)</span><textarea id="review-note" rows="2">${esc(keepNote)}</textarea></label>
          <div class="btn-row">
            <button class="btn reject" data-act="review" data-id="${esc(r.id)}" data-status="Rejected">Reject</button>
            <button class="btn approve" data-act="review" data-id="${esc(r.id)}" data-status="Approved">Approve</button>
          </div>` : ""}
        ${isManager() && r.status === "Approved" ? `<button class="btn" data-act="quick-status" data-id="${esc(r.id)}" data-status="In Progress">Start work</button>` : ""}
        ${isManager() && ["Approved", "In Progress"].includes(r.status) ? `<button class="btn approve" data-act="quick-status" data-id="${esc(r.id)}" data-status="Fulfilled">Mark fulfilled</button>` : ""}
        ${isManager() && r.status === "Rejected" ? `<button class="btn approve" data-act="quick-review" data-id="${esc(r.id)}" data-status="Approved">Approve from Drafts</button>` : ""}
        ${mine && ["Pending", "Duplicate"].includes(r.status) ? `<button class="btn" data-act="cancel-request" data-id="${esc(r.id)}">Cancel my request</button>` : ""}
        ${isManager() && ["Rejected", "Cancelled"].includes(r.status) ? `<button class="btn" data-act="quick-status" data-id="${esc(r.id)}" data-status="Pending">Reopen</button>` : ""}
        ${r.follow_up_on ? "" : `<button class="btn" data-act="follow-up" data-table="requests" data-id="${esc(r.id)}">Follow up</button>`}
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
  const r = S.requests.find((x) => x.id === id) || S.allRequests?.find((x) => x.id === id);
  const patch = { status };
  if (status === "Approved" || status === "Rejected") {
    Object.assign(patch, { reviewed_by: S.me.id, reviewer_name: S.me.full_name || S.me.email, reviewed_at: new Date().toISOString() });
    if (note !== undefined) patch.review_note = note;
  }
  // An approved duplicate stands on its own; a rejected one stays linked so Drafts shows it once.
  if (status === "Approved" && r?.status === "Duplicate") patch.duplicate_of = null;
  if (status === "Fulfilled") Object.assign(patch, { fulfilled_at: new Date().toISOString(), fulfilled_by_name: S.me.full_name || S.me.email });
  const msg = status === "Approved" ? (r?.status === "Rejected" ? "Approved from Drafts. Set its priority." : "Request approved. Set its priority under Approved & in progress.")
    : status === "Rejected" && r?.status === "Duplicate" ? "Rejected and filed with the original in Drafts"
    : status === "Rejected" ? "Request rejected and kept in Drafts" : `Request ${status.toLowerCase()}`;
  const updated = await guard(() => store.updateRequest(id, patch), msg);
  if (!updated) return;
  S.requests = S.requests.map((x) => (x.id === id ? updated : x));
  if (S.allRequests) S.allRequests = S.allRequests.map((x) => (x.id === id ? updated : x));
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
  "Everything overdue, grouped by sub-project, with manager notes",
  "My requests and their status, newest first",
  "Urgent and high priority items with damage photos",
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
      body: JSON.stringify({ prompt, today: todayISO(), current: b.viewId ? b.spec : null, subprojects: AREAS }),
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

const PAGES = Object.assign({
  dashboard: pageDashboard, requests: pageRequests, new: pageNew, approvals: pageApprovals,
  actions: pageActions, builder: pageBuilder,
}, ...MODULES.map((m) => m.pages));

/* -------------------------------------------------------------- handlers */
const CLICK = {
  async "demo-login"(el) { S.me = await store.signInAs(el.dataset.id); startApp(true); },
  "demo-reset"() { store.resetDemo(); toast("Demo data reset"); renderLogin(); },
  "login-tab"(el) { renderLogin(el.dataset.mode); },
  async "resend-confirm"(el) {
    await guard(() => store.resendConfirmation(el.dataset.email), `New code sent to ${el.dataset.email}`);
  },
  async forgot() {
    const email = app.querySelector('input[name="email"]')?.value.trim();
    if (!email) { toast("Enter your email first", "err"); return; }
    await guard(() => store.resetPassword(email), "Password reset email sent");
  },
  async signout() { await store.signOut(); location.hash = ""; location.reload(); },
  "open-request"(el) { openRequest(el.dataset.id); },
  "close-modal"() { closeModal(); },
  "show-follow-ups"() { S.reqFilter = { q: "", sub: "", status: "follow-up" }; location.hash = "#/requests"; },
  "filter-sub"(el) { S.reqFilter = { q: "", sub: el.dataset.sub, status: "" }; location.hash = "#/requests"; },
  "export-requests"() {
    const rows = filteredRequests();
    downloadWorkbook(`${CURRENT.project} FF&E Requests ${todayISO()}`, [requestsTab("Overall Requests", rows)]);
  },
  "remove-photo"(el) { S.draft.photos.splice(Number(el.dataset.idx), 1); document.getElementById("photo-list").innerHTML = photoListHTML(); },
  "quick-review"(el) { setRequestStatus(el.dataset.id, el.dataset.status, ""); },
  "quick-status"(el) { setRequestStatus(el.dataset.id, el.dataset.status); },
  "req-scope"(el) {
    S.reqScope = el.dataset.scope;
    render();
    if (S.reqScope === "all" && !S.allRequests) loadAllRequests();
  },
  "ap-tab"(el) { S.approvalTab = el.dataset.tab; render(); },
  "dup-reject"(el) { setRequestStatus(el.dataset.id, "Rejected", "Same as a request already rejected"); },
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
      due_date: r.needed_by, linked_ticket: ticketLabel(r.ticket_no), category: r.sub_project || r.project, notes: `Bldg ${r.buildings} · Room ${r.rooms}`,
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
    downloadWorkbook(`${CURRENT.project} FF&E Combined - ${S.me.full_name || "Me"} ${todayISO()}`, tabs);
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
  "req-fulfillment"(el) { S.draft.fulfillment = el.value; refreshAtticHint(el.form); },
  "req-sub"(el) {
    S.draft.sub = el.value;
    // A spec item from another sub-project no longer applies.
    if (!spec.specsFor(el.value).some((x) => x.id === S.draft.specId)) S.draft.specId = "";
    el.form.querySelector("#spec-pick").innerHTML = spec.specSelectHTML(el.value, S.draft.specId);
    refreshSpecPrice(el.form);
  },
  "spec-pick"(el) {
    const prev = spec.specById(S.draft.specId);
    S.draft.specId = el.value === "other" ? "" : el.value;
    const item = spec.specById(S.draft.specId);
    const f = el.form.elements;
    // Fill from the spec sheet, without overwriting anything the person typed themselves.
    const fill = (name, from, to) => { if (!f[name].value.trim() || f[name].value === (from || "")) f[name].value = to || ""; };
    fill("item_needed", prev?.name, item?.name);
    fill("ffe_tag", prev?.ffe_tag, item?.ffe_tag);
    fill("spec", prev?.spec, item?.spec);
    refreshSpecPrice(el.form);
    refreshAtticHint(el.form);
  },
  async "set-priority"(el) {
    const updated = await guard(() => store.updateRequest(el.dataset.id, { priority: el.value }), `Priority set to ${el.value}`);
    if (!updated) return;
    S.requests = S.requests.map((x) => (x.id === updated.id ? updated : x));
    if (S.modalId === updated.id) openRequest(updated.id);
  },
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
};

const INPUT = {
  "req-qty"(el) { refreshSpecPrice(el.form); },
  "req-tag"(el) { refreshAtticHint(el.form); },
  "req-search"(el) { S.reqFilter.q = el.value; document.getElementById("req-table").innerHTML = requestsTableHTML(); },
  "builder-prompt"(el) { S.builder.prompt = el.value; },
};

const SUBMIT = {
  async signin(form) {
    const fd = new FormData(form);
    const email = String(fd.get("email")).trim();
    try {
      S.me = await store.signIn(email, String(fd.get("password")));
      startApp(true);
    } catch (e) {
      if (/not confirmed/i.test(e.message)) {
        renderVerify(email, "Your email isn't verified yet. Enter the code from your confirmation email, or send a new one.");
      } else toast(e.message || "Couldn't sign in", "err");
    }
  },
  async signup(form) {
    const fd = new FormData(form);
    const email = String(fd.get("email")).trim();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await store.signUp(String(fd.get("name")).trim(), email, String(fd.get("password")));
      if (res === null) renderVerify(email);
      else { S.me = res; startApp(true); }
    } catch (e) {
      btn.disabled = false;
      if (/already/i.test(e.message)) renderLogin("signin", e.message);
      else toast(e.message || "Couldn't create the account", "err");
    }
  },
  request(form) { submitRequest(form); },
  async "verify-code"(form) {
    const fd = new FormData(form);
    const code = String(fd.get("code")).replace(/\D/g, "");
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const me = await guard(() => store.verifyEmailCode(String(fd.get("email")), code), "Email verified. Welcome!");
    btn.disabled = false;
    if (me) { S.me = me; startApp(true); }
  },
  async "set-password"(form) {
    const fd = new FormData(form);
    const pw = String(fd.get("password"));
    if (pw !== String(fd.get("confirm"))) { renderSetPassword("Those passwords don't match."); return; }
    const ok = await guard(async () => { await store.setPassword(pw); return true; }, "Password saved");
    if (ok) { history.replaceState(null, "", location.pathname); startApp(true); }
  },
  "add-filter"(form) {
    const fd = new FormData(form);
    const f = { field: String(fd.get("field")), op: String(fd.get("op")), value: String(fd.get("value") || "").trim() };
    if (!VALUELESS_OPS.includes(f.op) && !f.value) { toast("Enter a value for that filter", "err"); return; }
    S.builder.spec.filters.push(f);
    render();
  },
};

// Page modules contribute their own handlers.
for (const m of MODULES) {
  Object.assign(CLICK, m.CLICK);
  Object.assign(CHANGE, m.CHANGE);
  Object.assign(INPUT, m.INPUT);
  Object.assign(SUBMIT, m.SUBMIT);
}
Object.assign(hooks, {
  render, openRequest: (id) => openRequest(id), closeModal: () => closeModal(),
  reload: async () => { await loadAll(); render(); },
});

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
  });
  root.addEventListener("input", (e) => {
    const el = e.target.closest("[data-input]");
    if (el) INPUT[el.dataset.input]?.(el);
  });
  root.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-form]");
    if (!form) return;
    e.preventDefault();
    SUBMIT[form.dataset.form]?.(form, e.submitter);
  });
}

delegate(app);
delegate(modalRoot);
notes.initNoteTips();
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalRoot.innerHTML) closeModal(); });
boot();
