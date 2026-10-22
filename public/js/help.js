// How to Use: a written guide for each part of the app, plus a guided walkthrough
// that moves through the real screens in order, highlighting each one.
import { PROJECTS, AREAS, subProjects } from "./fields.js";
import { S, isManager } from "./state.js";
import { esc, icon } from "./ui.js";
import { openProject, areaHref } from "./projects.js";

const SEEN_KEY = () => `bdr-ffe-tour-offered-${S.me?.id}`;

/* -------------------------------------------------------------- the tour */
// route: where to go first (null = stay). sel: what to highlight (null = centered card).
const STEPS = [
  { title: "Welcome to the FF&E Tracker",
    body: "This walkthrough takes you through the app in the order you'll use it. It starts where everyone starts: the sign-in page, where you sign in with your work email and password (or by opening the invite email a manager sent you). Use Next and Back, or close it any time." },
  { route: "#/projects", sel: '[data-tour="projects"]', title: "Choose your project",
    body: "After signing in you land on Projects. Click the resort you're working on: Black Desert Resort, Cornerstone, Sweetens Cove or Marcella. Everything you see after that is for that project." },
  { route: "#/projects", sel: '[data-tour="add-project"]', manager: true, title: "Managers: add a project",
    body: "Type a new project's name (and optionally its sub-projects) and click Add project. It shows up for everyone right away." },
  { route: "#/project", sel: '[data-tour="subprojects"]', needsProject: true, title: "Sub-projects",
    body: "Each project is split into sub-projects. For Black Desert Resort those are The Terrace, The Cove, Resort Center, Pickleball and Waterpark. Click one to see its open requests and inventory." },
  { route: "#/project", sel: '[data-tour="add-sub"]', manager: true, needsProject: true, title: "Managers: add a sub-project",
    body: "Add sub-projects here. Renaming, reordering and archiving are in Settings." },
  { route: "area", sel: ".area-nav", needsProject: true, needsArea: true, title: "Back arrows",
    body: "Inside a sub-project, the back arrow takes you up a level (sub-project → project → all projects). The ‹ › buttons flip between sub-projects so you can browse them all." },
  { route: "#/project", sel: '[data-tour="switch"]', needsProject: true, title: "Switch projects any time",
    body: "The project you're in is shown at the top of the menu. Click it to go back to all projects and pick another." },
  { route: "#/dashboard", sel: ".kpis", needsProject: true, title: "Dashboard",
    body: "Your project at a glance: open requests, what's waiting for approval, overdue items, emails to review, low stock, your action items and follow-ups due this week. Click a tile to jump to that list." },
  { route: "#/new", sel: ".request-form", needsProject: true, title: "New request",
    body: "Submit an FF&E request. Be specific: sub-project, building(s), room number(s), what's needed, the FF&E tag, quantity, the date it's needed by, and at least one photo marked Concept image or Proof of damage. If it's already been requested, the app shows you the existing ticket." },
  { route: "#/requests", sel: "#req-table", needsProject: true, title: "All requests",
    body: "Everyone can see every request. Search and filter by sub-project or status, including Rejected & cancelled for anything that needs a follow-up. Hover the note icon on a row to read its notes, or click it to add some. Click a row to open the ticket." },
  { route: "#/email", sel: ".email-intro", needsProject: true, title: "Email requests",
    body: "Requests that arrive by email land here as drafts. Anything already submitted, or emailed twice, is filed under Auto-matched duplicates, so it's only reviewed once. Dismissed emails stay visible so you can follow up." },
  { route: "#/files", sel: '[data-tour="files-upload"]', needsProject: true, title: "Files & the assistant",
    body: "Upload spreadsheets and PDFs (punch lists, inspection reports, spec books). They're saved with the project so anyone can open them later, and the assistant turns them into requests, putting each one in the right sub-project. Chat with it to change what's included or how it's organized, then confirm." },
  { route: "#/approvals", sel: ".content", manager: true, needsProject: true, title: "Managers: approvals",
    body: "Go through pending requests one card at a time: ✓ (or drag right, or →) approves, ✗ (or drag left, or ←) rejects, Later skips, and Undo takes it back. Switch to List to see them all at once." },
  { route: "#/inventory", sel: ".content", needsProject: true, title: "Inventory & attic stock",
    body: "Attic stock and inventory per sub-project, with low-stock warnings. Click Take out to remove stock and optionally record where it went: sub-project, building, room and ticket. Every move is logged." },
  { route: "#/import", sel: ".intake-start", manager: true, needsProject: true, title: "Managers: import spreadsheets",
    body: "Upload an Excel or CSV file. Rows are sorted into sub-projects automatically and you check everything before it's saved." },
  { route: "#/actions", sel: ".content", title: "My action items",
    body: "Your own checklist with status, due dates and notes. Export your sheet, or a combined workbook with the overall sheet plus your tab." },
  { route: "#/builder", sel: ".ai-card", needsProject: true, title: "Sheet builder",
    body: "Describe the spreadsheet you want in plain English. The assistant builds it, you can pin it to your dashboard, and export it any time." },
  { route: "#/outlook", sel: ".ol-connect", title: "My Outlook report",
    body: "Anyone can connect their own Outlook. The app reads your recent emails and reports which FF&E requests are coming up, and whether each one is already a ticket. Send new ones to Email Requests with one click." },
  { route: "#/team", sel: ".invite-form", manager: true, title: "Managers: team",
    body: "Invite people by email, change roles, or remove people." },
  { route: "#/settings", sel: ".content", manager: true, title: "Managers: settings",
    body: "Rename, reorder and archive projects and sub-projects, and edit the option lists used in forms (categories, storage locations, units)." },
  { route: "#/help", sel: '[data-tour="nav-help"]', title: "That's it!",
    body: "Come back to How to Use any time to read the guide or replay this walkthrough." },
];

let tour = null; // { steps, i }

function stepsForUser() {
  return STEPS.filter((s) => !s.manager || isManager())
    .filter((s) => !s.needsArea || PROJECTS.some((p) => subProjects(p).length));
}

async function ensureProject(step) {
  if (!step.needsProject || S.project) return;
  const pick = PROJECTS.find((p) => subProjects(p).length) || PROJECTS[0];
  if (pick) await openProject(pick);
}

async function goTo(i) {
  if (!tour) return;
  tour.i = i;
  const step = tour.steps[i];
  await ensureProject(step);
  let route = step.route;
  if (route === "area") route = AREAS.length ? areaHref(AREAS[0]) : "#/project";
  if (route && location.hash !== route) location.hash = route;
  else draw();
}

function waitFor(sel, tries = 30) {
  return new Promise((resolve) => {
    const tick = (n) => {
      const el = sel && document.querySelector(sel);
      if (el || !sel || n <= 0) return resolve(el || null);
      setTimeout(() => tick(n - 1), 50);
    };
    tick(tries);
  });
}

async function draw() {
  if (!tour) return;
  const step = tour.steps[tour.i];
  const target = await waitFor(step.sel);
  let root = document.getElementById("tour");
  if (!root) {
    root = document.createElement("div");
    root.id = "tour";
    document.body.appendChild(root);
  }
  const last = tour.i === tour.steps.length - 1;
  root.innerHTML = `
    <div class="tour-shade ${target ? "" : "full"}"></div>
    ${target ? '<div class="tour-spot"></div>' : ""}
    <div class="tour-card" role="dialog" aria-modal="false" aria-labelledby="tour-title">
      <div class="tour-progress">Step ${tour.i + 1} of ${tour.steps.length}</div>
      <h3 id="tour-title">${esc(step.title)}</h3>
      <p>${esc(step.body)}</p>
      <div class="btn-row">
        <button class="btn small" data-tour-act="close">${last ? "Close" : "Skip tour"}</button>
        <span class="grow"></span>
        ${tour.i ? `<button class="btn small" data-tour-act="back">${icon("back")} Back</button>` : ""}
        ${last ? "" : '<button class="btn small primary" data-tour-act="next">Next ›</button>'}
      </div>
    </div>`;
  if (target) target.scrollIntoView({ block: "center" });
  position(target);
  root.querySelector('[data-tour-act="next"], [data-tour-act="close"]')?.focus();
}

function position(target) {
  const root = document.getElementById("tour");
  if (!root) return;
  const card = root.querySelector(".tour-card");
  const spot = root.querySelector(".tour-spot");
  const mobile = window.innerWidth < 700;
  if (!target || !spot) {
    Object.assign(card.style, { left: "50%", top: "50%", transform: "translate(-50%, -50%)" });
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 6;
  const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad);
  const height = Math.min(r.height + pad * 2, window.innerHeight - top - 4);
  Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${Math.min(r.width + pad * 2, window.innerWidth - left - 4)}px`, height: `${height}px` });
  card.style.transform = "none";
  if (mobile) {
    Object.assign(card.style, { left: "12px", right: "12px", top: "auto", bottom: "12px" });
    return;
  }
  const w = card.offsetWidth, h = card.offsetHeight;
  let cl = r.right + 16, ct = r.top;
  if (cl + w > window.innerWidth - 12) { cl = Math.min(Math.max(12, r.left), window.innerWidth - w - 12); ct = r.bottom + 14; }
  if (ct + h > window.innerHeight - 12) ct = Math.max(12, r.top - h - 14);
  if (ct < 12) ct = 12;
  Object.assign(card.style, { left: `${cl}px`, top: `${ct}px`, right: "auto", bottom: "auto" });
}

export function startTour() {
  tour = { steps: stepsForUser(), i: 0 };
  try { localStorage.setItem(SEEN_KEY(), "1"); } catch { /* ignore */ }
  document.getElementById("tour-offer")?.remove();
  goTo(0);
}

function endTour() {
  tour = null;
  document.getElementById("tour")?.remove();
}

// Called by the app after each page change so the highlight follows the new screen.
export function onRoute() { if (tour) draw(); }

document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-tour-act]");
  if (!b) return;
  const act = b.dataset.tourAct;
  if (act === "close") endTour();
  else if (act === "next") goTo(tour.i + 1);
  else if (act === "back") goTo(tour.i - 1);
  else if (act === "start") startTour();
  else if (act === "dismiss") { try { localStorage.setItem(SEEN_KEY(), "1"); } catch { /* ignore */ } b.closest("#tour-offer")?.remove(); }
});
document.addEventListener("keydown", (e) => {
  if (!tour) return;
  if (e.key === "Escape") endTour();
  else if (e.key === "ArrowRight" && tour.i < tour.steps.length - 1) goTo(tour.i + 1);
  else if (e.key === "ArrowLeft" && tour.i > 0) goTo(tour.i - 1);
});
window.addEventListener("resize", () => { if (tour) draw(); });

// First sign-in: offer the walkthrough once.
export function maybeOfferTour() {
  let seen = false;
  try { seen = !!localStorage.getItem(SEEN_KEY()); } catch { seen = true; }
  if (seen || document.getElementById("tour-offer")) return;
  const el = document.createElement("div");
  el.id = "tour-offer";
  el.className = "tour-offer";
  el.innerHTML = `<div><b>New here?</b> Take a 2-minute walkthrough of how everything works.</div>
    <div class="btn-row"><button class="btn small" data-tour-act="dismiss">No thanks</button><button class="btn small primary" data-tour-act="start">Start walkthrough</button></div>`;
  document.body.appendChild(el);
}

/* ------------------------------------------------------------- the guide */
const GUIDE = [
  { title: "Signing in", body: [
    "Open the site and sign in with your work email and password.",
    "New? A manager invites you by email. Open the invite and choose a password.",
    "Forgot your password? Click “Forgot password?” on the sign-in page.",
  ] },
  { title: "Projects and sub-projects", body: [
    "After signing in, choose your project (resort): Black Desert Resort, Cornerstone, Sweetens Cove or Marcella.",
    "Projects are split into sub-projects, e.g. The Terrace, The Cove, Resort Center, Pickleball and Waterpark under Black Desert Resort.",
    "Click a sub-project to see its open requests and inventory. Use the back arrow to go up a level and ‹ › to flip between sub-projects.",
    "Switch projects any time by clicking the project name at the top of the menu.",
  ] },
  { title: "Submitting a request", body: [
    "Go to New Request. Pick the sub-project, then fill in building(s), room number(s), what you need, the FF&E tag (and specification if you know it), quantity and the date it's needed by.",
    "Add at least one photo and mark each as Concept image (what it should look like) or Proof of damage.",
    "If the same thing was already requested, you'll see that ticket first so it isn't submitted twice.",
  ] },
  { title: "Notes and follow-ups", body: [
    "Every request, inventory item and emailed request has notes. Hover the note icon to read them; click it to add or edit.",
    "Use Follow up on any ticket or dismissed email to set a date and what needs to happen; it can go straight onto your action items.",
    "Find them later with the “Rejected & cancelled” and “Has a follow-up” filters on All Requests, or the Dismissed tab in Email Requests.",
  ] },
  { title: "Files and the assistant", body: [
    "Open Files & Assistant, or click “Upload spreadsheet or PDF here” on any sub-project page.",
    "Choose what it's mostly about (or let the assistant sort it) and optionally say how to organize it, e.g. “only items marked replace”.",
    "The file is saved with the project so anyone can open it later from Files or the sub-project page.",
    "The assistant proposes requests, each in the sub-project it belongs to; anything already requested is unchecked. Chat with it to change things, edit or move items yourself, then click Create.",
    "New requests are Pending until a manager approves them.",
  ] },
  { title: "Email requests", body: [
    "Emails sent to the FF&E inbox are turned into draft tickets automatically, photos included.",
    "Duplicates of existing tickets, or of earlier emails, are filed under Auto-matched duplicates so managers review each request once.",
    "Anyone can paste an email in. Managers turn emails into tickets, dismiss them, or bring dismissed ones back.",
  ] },
  { title: "Approvals", manager: true, body: [
    "Approvals shows pending tickets one card at a time: ✓ or drag right to approve, ✗ or drag left to reject (add an optional note first), Later to skip, Undo to take it back. Arrow keys work too.",
    "Switch to List to see everything at once.",
    "Move approved work to In Progress, then Completed. Rejected or cancelled tickets can be reopened.",
  ] },
  { title: "Inventory and attic stock", body: [
    "Inventory shows attic stock and inventory for each sub-project, with low-stock warnings against par levels.",
    "Take out removes stock and lets you record where it went (sub-project, building, room, ticket, note). Return / add stock puts it back.",
    "Every move is in the movement log. Export gives one Excel tab per sub-project plus the log.",
  ] },
  { title: "Importing spreadsheets", manager: true, body: [
    "Import Spreadsheet takes Excel or CSV files for inventory or requests.",
    "Rows are sorted into sub-projects by a Sub-project column, the tab name, or names in the row. You check everything, including duplicates and rows that need a sub-project, before importing.",
  ] },
  { title: "My action items and spreadsheets", body: [
    "My Action Items is your private checklist with status, priority, due date, linked ticket and notes.",
    "Export just your items, or a combined workbook with the overall sheet plus your own tab.",
    "Sheet Builder: describe the sheet you want, adjust the columns and filters, pin it to your dashboard and export it.",
  ] },
  { title: "My Outlook report", body: [
    "Go to My Outlook Report and click Connect Outlook to sign in with your work Microsoft account.",
    "Choose how far back to look and build the report. It lists FF&E requests found in your email, what's needed soon, and whether each is already a ticket.",
    "Send anything new to Email Requests with one click, copy the summary, or export it to Excel.",
  ] },
  { title: "Team and settings", manager: true, body: [
    "Team & Roles: invite people by email, change roles (Manager or Owner Relations), resend invites or remove people.",
    "Settings: rename, reorder or archive projects and sub-projects, add other names used in emails, and edit the option lists.",
  ] },
];

export function pageHelp() {
  return `
  <div class="card help-hero">
    <div><h3>${icon("help")} How to use the FF&amp;E Tracker</h3>
      <p class="muted">Take the guided walkthrough, or read the steps for each part below.${isManager() ? " Sections marked Managers are only for managers." : ""}</p></div>
    <button class="btn primary" data-tour-act="start">Start the walkthrough</button>
  </div>
  <div class="help-list">${GUIDE.filter((g) => !g.manager || isManager()).map((g, i) => `
    <details class="card help-item" ${i < 2 ? "open" : ""}>
      <summary>${esc(g.title)}${g.manager ? ' <span class="badge b-approved">Managers</span>' : ""}</summary>
      <ol>${g.body.map((b) => `<li>${esc(b)}</li>`).join("")}</ol>
    </details>`).join("")}
  </div>`;
}

export const pages = { help: pageHelp };
