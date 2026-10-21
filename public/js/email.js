// Email requests: requests that arrived by email, read into ticket fields, with
// duplicates of existing tickets (or of earlier emails) filed away automatically.
import { store } from "./store.js";
import { CONFIG } from "./config.js";
import { PROJECTS, PRIORITIES, PHOTO_KINDS, ticketLabel } from "./fields.js";
import { findMatches, DUP_THRESHOLD, POSSIBLE_THRESHOLD } from "./dedupe.js";
import { S, isManager, hooks } from "./state.js";
import { modalRoot, esc, opt, badge, fmtDate, toast, guard, icon, openModal } from "./ui.js";

const TABS = [
  ["New", "Needs review"],
  ["Duplicate", "Auto-matched duplicates"],
  ["Converted", "Turned into tickets"],
  ["Dismissed", "Dismissed"],
];
const emailById = (id) => S.emails.find((e) => e.id === id);
const requestById = (id) => S.requests.find((r) => r.id === id);
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const openPool = () => S.requests.filter((r) => !["Rejected", "Cancelled"].includes(r.status));

export const emailsToReview = () => S.emails.filter((e) => e.status === "New").length;

function possibleMatch(e) {
  const [m] = findMatches(e, openPool(), 1, POSSIBLE_THRESHOLD);
  return m;
}

function fieldsHTML(e) {
  const f = (label, v, required) => `<div><dt>${esc(label)}</dt><dd class="${!v && required ? "missing" : ""}">${v ? esc(v) : required ? "missing" : "—"}</dd></div>`;
  return `<dl class="facts compact">
    ${f("Project", e.project, true)}${f("Building(s)", e.buildings, true)}${f("Room(s)", e.rooms, true)}
    ${f("FF&E tag", e.ffe_tag, true)}${f("Qty", e.quantity)}${f("Needed by", e.needed_by ? fmtDate(e.needed_by) : "", true)}
    ${e.priority && e.priority !== "Normal" ? f("Priority", e.priority) : ""}
  </dl>`;
}

function cardHTML(e) {
  const mgr = isManager();
  const dupTicket = e.duplicate_of && requestById(e.duplicate_of);
  const dupEmail = e.duplicate_of_email && emailById(e.duplicate_of_email);
  const converted = e.converted_request && requestById(e.converted_request);
  const maybe = e.status === "New" ? possibleMatch(e) : null;
  let callout = "";
  if (e.status === "Duplicate") {
    callout = `<div class="callout dup">${icon("approvals")} <div><b>Already covered${dupTicket ? ` by ${esc(ticketLabel(dupTicket.ticket_no))}` : dupEmail ? ` by an earlier email from ${esc(dupEmail.from_name || dupEmail.from_email)}` : ""}</b>
      <span class="muted small">${esc(e.duplicate_reason || "")}${e.match_score ? ` · ${Math.round(e.match_score * 100)}% match` : ""}</span>
      ${dupTicket ? `<span class="small">Ticket status: ${badge(dupTicket.status)}</span>` : ""}</div>
      <div class="btn-row">${dupTicket ? `<button class="btn small" data-act="open-request" data-id="${esc(dupTicket.id)}">Open ticket</button>` : ""}
      ${mgr ? `<button class="btn small" data-act="em-not-dup" data-id="${esc(e.id)}">Not a duplicate</button>` : ""}</div></div>`;
  } else if (maybe) {
    callout = `<div class="callout maybe">${icon("approvals")} <div><b>Possibly the same as ${esc(ticketLabel(maybe.item.ticket_no))}</b>
      <span class="muted small">${esc(maybe.item.item_needed)} · ${esc(maybe.reasons.join(", "))}</span></div>
      <div class="btn-row"><button class="btn small" data-act="open-request" data-id="${esc(maybe.item.id)}">Compare</button>
      ${mgr ? `<button class="btn small" data-act="em-mark-dup" data-id="${esc(e.id)}" data-req="${esc(maybe.item.id)}">Mark duplicate</button>` : ""}</div></div>`;
  } else if (e.status === "Converted") {
    callout = `<div class="callout ok">${icon("approvals")} <div><b>Created ${converted ? esc(ticketLabel(converted.ticket_no)) : "a ticket"}</b>
      <span class="muted small">${esc(e.reviewer_name || "")} · ${esc(when(e.reviewed_at))}</span></div>
      ${converted ? `<button class="btn small" data-act="open-request" data-id="${esc(converted.id)}">Open ticket</button>` : ""}</div>`;
  } else if (e.status === "Dismissed") {
    callout = `<div class="callout">${esc(e.duplicate_reason || "Dismissed")}${e.reviewer_name ? ` · ${esc(e.reviewer_name)}` : ""}
      ${mgr ? `<button class="btn small" data-act="em-restore" data-id="${esc(e.id)}">Restore</button>` : ""}</div>`;
  }
  return `
  <article class="email-card">
    <header>
      <span class="avatar sm">${icon("email", "ico xs")}</span>
      <div class="grow"><strong>${esc(e.from_name || e.from_email || "Unknown sender")}</strong> <span class="muted small">${esc(e.from_email && e.from_name ? e.from_email : "")}</span>
        <div class="email-subject">${esc(e.subject || "(no subject)")}</div></div>
      <span class="muted small nowrap">${esc(when(e.received_at))}</span>
    </header>
    <p class="email-need"><b>${esc(e.item_needed || "—")}</b>${e.attachments?.length ? ` <span class="muted small">· ${e.attachments.length} photo${e.attachments.length === 1 ? "" : "s"}</span>` : ""}</p>
    ${fieldsHTML(e)}
    ${callout}
    <details class="email-body"><summary>Original email${e.ai_summary ? ` · <span class="muted">${esc(e.ai_summary)}</span>` : ""}</summary><pre>${esc(e.body || "")}</pre></details>
    ${mgr && e.status === "New" ? `<footer class="btn-row end">
      <button class="btn small" data-act="em-dismiss" data-id="${esc(e.id)}">Dismiss</button>
      <button class="btn primary small" data-act="em-review" data-id="${esc(e.id)}">Review &amp; create ticket</button></footer>` : ""}
  </article>`;
}

export function pageEmail() {
  const tab = S.emailTab;
  const list = S.emails.filter((e) => e.status === tab);
  const count = (s) => S.emails.filter((e) => e.status === s).length;
  const hookUrl = `${location.origin}${CONFIG.EMAIL_ENDPOINT}?key=YOUR_SECRET`;
  return `
  <div class="card email-intro">
    <div>
      <h3>${icon("email")} Requests sent by email</h3>
      <p class="muted small">Forwarded emails are read automatically and turned into draft tickets. If the same request was already submitted in the app, or emailed before, it's filed under <b>Auto-matched duplicates</b> so nobody reviews it twice.</p>
      ${isManager() ? (store.mode === "cloud"
        ? `<p class="small">Inbox hookup: point your forwarding rule or Power Automate flow at <code class="copy" data-act="em-copy" data-text="${esc(hookUrl)}" title="Click to copy">${esc(hookUrl)}</code>. Setup steps are in the README.</p>`
        : `<p class="small muted">Demo mode: there's no inbox hookup, so use <b>Paste an email</b> to try it.</p>`) : ""}
    </div>
    <button class="btn primary" data-act="em-paste">${icon("new")} Paste an email</button>
  </div>
  <div class="seg-row">${TABS.map(([s, l]) => `<button class="seg ${tab === s ? "on" : ""}" data-act="em-tab" data-tab="${s}">${l} <span>${count(s)}</span></button>`).join("")}</div>
  <div class="email-list">${list.length ? list.map(cardHTML).join("") : `<div class="empty card">${tab === "New" ? "No emailed requests waiting for review." : "Nothing here."}</div>`}</div>`;
}

/* ------------------------------------------------------------------ modals */
function openPaste() {
  openModal(`
    <header class="modal-head"><h2>Paste an email</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></header>
    <p class="muted small">Copy an email from Outlook or Gmail and paste it here. It's read the same way as forwarded mail and checked for duplicates.</p>
    <form class="stack" data-form="em-paste">
      <div class="row2"><label>From (name)<input name="from_name" placeholder="e.g. Cove Front Desk"></label>
        <label>From (email)<input name="from_email" type="email" placeholder="name@company.com"></label></div>
      <label>Subject<input name="subject"></label>
      <label>Email text <em>*</em><textarea name="text" rows="9" required></textarea></label>
      <div class="btn-row end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary" type="submit">Read email</button></div>
    </form>`);
}

async function openReview(id) {
  const e = emailById(id);
  if (!e) return;
  const atts = e.attachments || [];
  openModal(`
    <header class="modal-head">
      <div><span class="muted small">From ${esc(e.from_name || e.from_email)} · ${esc(when(e.received_at))}</span><h2>Create a ticket from this email</h2></div>
      <button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button>
    </header>
    <details class="email-body"><summary>Original email: ${esc(e.subject || "")}</summary><pre>${esc(e.body || "")}</pre></details>
    <form class="stack" data-form="em-convert">
      <input type="hidden" name="id" value="${esc(e.id)}">
      <div class="chip-select">${PROJECTS.map((p) => `<label class="chip"><input type="radio" name="project" value="${esc(p)}" ${e.project === p ? "checked" : ""}><span>${esc(p)}</span></label>`).join("")}</div>
      <div class="row2"><label>Building(s) <em>*</em><input name="buildings" value="${esc(e.buildings || "")}"></label>
        <label>Room(s) <em>*</em><input name="rooms" value="${esc(e.rooms || "")}"></label></div>
      <label>What's needed <em>*</em><textarea name="item_needed" rows="2">${esc(e.item_needed || "")}</textarea></label>
      <div class="row2"><label>FF&amp;E tag <em>*</em><input name="ffe_tag" value="${esc(e.ffe_tag || "")}" placeholder="or TBD"></label>
        <label>Specification<input name="spec" value="${esc(e.spec || "")}"></label></div>
      <div class="row3"><label>Quantity<input name="quantity" type="number" min="1" value="${esc(e.quantity || 1)}"></label>
        <label>Priority<select name="priority">${PRIORITIES.map((p) => opt(p, p, (e.priority || "Normal") === p)).join("")}</select></label>
        <label>Needed by <em>*</em><input name="needed_by" type="date" value="${esc(e.needed_by || "")}"></label></div>
      ${atts.length ? `<div><h3 class="ph-head">Photos from the email</h3><div class="photo-list">${atts.map((a, i) => `
        <div class="photo-item"><span class="ph sm" data-path="${esc(a.path)}"><span class="ph-loading"></span></span>
          <div class="stack tight"><span class="small ellipsis">${esc(a.name || "photo")}</span>
          <select name="kind_${i}">${opt("concept", PHOTO_KINDS.concept, a.kind === "concept")}${opt("damage", PHOTO_KINDS.damage, a.kind !== "concept")}</select></div></div>`).join("")}</div></div>` : ""}
      <label>Details<textarea name="details" rows="3">${esc(e.details || "")}</textarea></label>
      <p class="muted small" id="convert-error" role="alert"></p>
      <div class="btn-row end">
        <button type="button" class="btn" data-act="close-modal">Cancel</button>
        <button class="btn" type="submit" name="mode" value="pending">Create as pending</button>
        <button class="btn approve" type="submit" name="mode" value="approve">Create &amp; approve</button>
      </div>
    </form>`, { wide: true });
  if (atts.length) {
    const urls = await guard(() => store.photoUrls(atts));
    modalRoot.querySelectorAll(".ph[data-path]").forEach((el) => {
      const u = urls?.[el.dataset.path];
      el.innerHTML = u ? `<img src="${esc(u)}" alt="">` : "";
    });
  }
}

async function convert(form, mode) {
  const fd = new FormData(form);
  const e = emailById(fd.get("id"));
  const v = (k) => String(fd.get(k) || "").trim();
  const fields = {
    project: v("project"), buildings: v("buildings"), rooms: v("rooms"), item_needed: v("item_needed"), ffe_tag: v("ffe_tag"),
    spec: v("spec"), quantity: Math.max(1, parseInt(v("quantity"), 10) || 1), priority: v("priority") || "Normal",
    needed_by: v("needed_by"), details: v("details"),
  };
  const missing = ["project", "buildings", "rooms", "item_needed", "ffe_tag", "needed_by"].filter((k) => !fields[k]);
  if (missing.length) {
    form.querySelector("#convert-error").textContent = `Please fill in: ${missing.map((k) => k.replace("_", " ")).join(", ")} (type TBD if unknown).`;
    return;
  }
  const sender = S.profiles.find((p) => p.email && e.from_email && p.email.toLowerCase() === e.from_email.toLowerCase());
  const photos = (e.attachments || []).map((a, i) => ({ ...a, kind: fd.get(`kind_${i}`) || a.kind || "damage" }));
  const now = new Date().toISOString();
  const reviewer = { reviewed_by: S.me.id, reviewer_name: S.me.full_name || S.me.email, reviewed_at: now };
  const created = await guard(async () => {
    const [r] = await store.insertRequests([{
      ...fields, photos, source: "email", source_ref: e.id, status: "Pending",
      requester_name: sender?.full_name || e.from_name || e.from_email || "Email",
    }]);
    const final = mode === "approve" ? await store.updateRequest(r.id, { status: "Approved", ...reviewer, review_note: "" }) : r;
    await store.updateEmailRequest(e.id, { status: "Converted", converted_request: final.id, ...reviewer });
    return final;
  });
  if (!created) return;
  // Any other waiting email about the same thing is now covered by this ticket.
  const linked = [];
  for (const other of S.emails.filter((x) => x.status === "New" && x.id !== e.id)) {
    const [m] = findMatches(other, [created], 1);
    if (m && m.score >= DUP_THRESHOLD) {
      await guard(() => store.updateEmailRequest(other.id, { status: "Duplicate", duplicate_of: created.id, match_score: m.score, duplicate_reason: `Covered by ticket created from another email: ${m.reasons.join(", ")}` }));
      linked.push(other.id);
    }
  }
  const [requests, emails] = await Promise.all([store.listRequests(), store.listEmailRequests()]);
  S.requests = requests;
  S.emails = emails;
  hooks.closeModal();
  hooks.render();
  toast(`${ticketLabel(created.ticket_no)} created${mode === "approve" ? " and approved" : ""}${linked.length ? ` · ${linked.length} matching email${linked.length === 1 ? "" : "s"} filed as duplicate` : ""}`);
}

async function patchEmail(id, patch, msg) {
  const saved = await guard(() => store.updateEmailRequest(id, patch), msg);
  if (!saved) return;
  S.emails = S.emails.map((e) => (e.id === id ? saved : e));
  hooks.render();
}

// After a ticket is submitted in the app, file any waiting email that describes it.
export async function linkEmailsToNewRequest(request) {
  const hits = S.emails.filter((e) => e.status === "New")
    .map((e) => ({ e, m: findMatches(e, [request], 1)[0] }))
    .filter(({ m }) => m && m.score >= DUP_THRESHOLD);
  for (const { e, m } of hits) {
    await guard(() => store.linkEmailDuplicate(e.id, request.id, `Also submitted in the app as ${ticketLabel(request.ticket_no)}: ${m.reasons.join(", ")}`));
  }
  if (hits.length) {
    S.emails = await store.listEmailRequests();
    toast(`${hits.length} emailed request${hits.length === 1 ? " was" : "s were"} matched to this ticket, so it won't be reviewed twice`);
  }
}

/* ---------------------------------------------------------------- handlers */
const reviewer = () => ({ reviewed_by: S.me.id, reviewer_name: S.me.full_name || S.me.email, reviewed_at: new Date().toISOString() });

export const CLICK = {
  "em-tab"(el) { S.emailTab = el.dataset.tab; hooks.render(); },
  "em-paste"() { openPaste(); },
  "em-review"(el) { openReview(el.dataset.id); },
  "em-dismiss"(el) {
    const reason = prompt("Reason for dismissing (optional):", "Not an FF&E request");
    if (reason === null) return;
    patchEmail(el.dataset.id, { status: "Dismissed", duplicate_reason: reason || "Dismissed", ...reviewer() }, "Email dismissed");
  },
  "em-restore"(el) { patchEmail(el.dataset.id, { status: "New", duplicate_reason: null }, "Moved back to Needs review"); },
  "em-not-dup"(el) { patchEmail(el.dataset.id, { status: "New", duplicate_of: null, duplicate_of_email: null, duplicate_reason: null, match_score: null }, "Moved to Needs review"); },
  "em-mark-dup"(el) {
    const r = requestById(el.dataset.req);
    patchEmail(el.dataset.id, { status: "Duplicate", duplicate_of: r.id, duplicate_reason: `Marked as duplicate of ${ticketLabel(r.ticket_no)}`, ...reviewer() }, "Filed as duplicate");
  },
  async "em-copy"(el) {
    try { await navigator.clipboard.writeText(el.dataset.text); toast("Copied"); } catch { toast("Select the address and copy it", "err"); }
  },
};

export const SUBMIT = {
  async "em-paste"(form) {
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.text.trim()) { toast("Paste the email text first", "err"); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Reading…";
    const e = await guard(() => store.submitEmail({ ...fd, text: fd.text.trim() }));
    btn.disabled = false;
    btn.textContent = "Read email";
    if (!e) return;
    S.emails = await store.listEmailRequests();
    S.emailTab = e.status;
    hooks.closeModal();
    hooks.render();
    toast(e.status === "Duplicate" ? "Already requested, so it was filed under Auto-matched duplicates"
      : e.status === "Dismissed" ? "That doesn't look like an FF&E request, so it was filed under Dismissed"
      : "Added to Needs review");
  },
  "em-convert"(form, submitter) { convert(form, submitter?.value || "pending"); },
};

export const pages = { email: pageEmail };
