// Swipe review: go through pending requests one card at a time. Drag or press
// ✗ / ✓ (or ← / →) to reject or approve; "Later" skips; Undo puts it back.
import { store } from "./store.js";
import { AREAS, toRow, ticketLabel, isOverdue, PHOTO_KINDS } from "./fields.js";
import { S, hooks } from "./state.js";
import { app, esc, opt, badge, fmtDate, toast, guard, icon, notesChip } from "./ui.js";

export const RV = { mode: "swipe", sub: "", skipped: [], history: [], busy: false };
const SWIPE_AT = 110;

function queue() {
  const pending = S.requests.filter((r) => r.status === "Pending" && (!RV.sub || r.sub_project === RV.sub))
    .sort((a, b) => (a.needed_by || "9999").localeCompare(b.needed_by || "9999"));
  const later = pending.filter((r) => RV.skipped.includes(r.id));
  return [...pending.filter((r) => !RV.skipped.includes(r.id)), ...later];
}

export function toggleHTML() {
  return `<div class="seg-row review-toggle" role="tablist" aria-label="Review style">
    <button class="seg ${RV.mode === "swipe" ? "on" : ""}" data-act="rv-mode" data-mode="swipe">One at a time</button>
    <button class="seg ${RV.mode === "list" ? "on" : ""}" data-act="rv-mode" data-mode="list">List</button>
  </div>`;
}

export function swipeHTML() {
  const q = queue();
  const subs = AREAS.length ? `<select data-change="rv-sub" aria-label="Sub-project">${opt("", "All sub-projects")}${AREAS.map((a) => opt(a, `${a} (${S.requests.filter((r) => r.status === "Pending" && r.sub_project === a).length})`, RV.sub === a)).join("")}</select>` : "";
  const undo = RV.history.length ? `<button class="btn small" data-act="rv-undo">↺ Undo ${esc(RV.history.at(-1).label)}</button>` : "";
  if (!q.length) {
    return `<div class="rv-bar">${subs}<span class="grow"></span>${undo}</div>
      <div class="card rv-done"><div class="rv-done-mark">✓</div><h3>All caught up</h3><p class="muted">No requests waiting for approval${RV.sub ? ` in ${esc(RV.sub)}` : ""}.</p></div>`;
  }
  const r = q[0];
  const row = toRow(r);
  const photos = Array.isArray(r.photos) ? r.photos : [];
  const fact = (label, v) => (v ? `<div><dt>${esc(label)}</dt><dd>${v}</dd></div>` : "");
  return `
  <div class="rv-bar">${subs}<span class="muted small">${q.length} waiting${RV.skipped.length ? ` · ${RV.skipped.filter((id) => q.some((x) => x.id === id)).length} saved for later` : ""}</span><span class="grow"></span>${undo}</div>
  <div class="rv-stage">
    ${q[1] ? '<div class="rv-card rv-behind" aria-hidden="true"></div>' : ""}
    <article class="rv-card" id="rv-card" data-id="${esc(r.id)}" aria-label="Request ${esc(row.ticket)}">
      <span class="rv-stamp yes">APPROVE</span><span class="rv-stamp no">REJECT</span>
      <div class="rv-photo" data-path="${esc(photos[0]?.path || "")}">${photos.length ? '<span class="ph-loading"></span>' : `<span class="rv-nophoto">${icon("camera", "ico lg")}<span>No photo</span></span>`}
        ${photos.length ? `<span class="rv-photo-tag">${esc(PHOTO_KINDS[photos[0].kind] || "")}${photos.length > 1 ? ` · ${photos.length} photos` : ""}</span>` : ""}</div>
      <div class="rv-body">
        <div class="rv-top"><strong class="mono">${esc(row.ticket)}</strong> ${badge(row.sub_project || row.project, "proj")} ${row.priority !== "Normal" ? badge(row.priority, `p-${row.priority.toLowerCase()}`) : ""}
          <span class="grow"></span>${notesChip("requests", r)}</div>
        <h2>${esc(row.item_needed)}</h2>
        <dl class="facts compact">
          ${fact("Building(s)", esc(row.buildings))}${fact("Room(s)", esc(row.rooms))}${fact("FF&E tag", `<span class="mono">${esc(row.ffe_tag)}</span>`)}
          ${fact("Qty", esc(row.quantity))}${fact("Needed by", `<span class="${isOverdue(row) ? "overdue" : ""}">${esc(fmtDate(row.needed_by))}</span>`)}
          ${fact("Requested by", esc(row.requester_name))}${row.source !== "App" ? fact("Source", esc(row.source)) : ""}
        </dl>
        ${row.spec ? `<p class="small"><b>Spec:</b> ${esc(row.spec)}</p>` : ""}
        ${row.details ? `<p class="small rv-details">${esc(row.details)}</p>` : ""}
        <input class="rv-note" id="rv-note" placeholder="Note to requester (optional)" aria-label="Note to requester">
        <button class="link-btn accent small" data-act="open-request" data-id="${esc(r.id)}">Open full ticket</button>
      </div>
    </article>
  </div>
  <div class="rv-actions">
    <button class="rv-btn no" data-act="rv-decide" data-status="Rejected" aria-label="Reject" title="Reject (←)">✕</button>
    <button class="rv-btn later" data-act="rv-later" aria-label="Later" title="Later (↓)">Later</button>
    <button class="rv-btn yes" data-act="rv-decide" data-status="Approved" aria-label="Approve" title="Approve (→)">✓</button>
  </div>
  <p class="muted small center">Drag the card, or use ← reject · → approve · ↓ later</p>`;
}

async function decide(status) {
  const card = app.querySelector("#rv-card");
  if (!card || RV.busy) return;
  const r = S.requests.find((x) => x.id === card.dataset.id);
  const note = app.querySelector("#rv-note")?.value.trim() || "";
  RV.busy = true;
  card.classList.add(status === "Approved" ? "fly-right" : "fly-left");
  const prev = { status: r.status, reviewed_by: r.reviewed_by || null, reviewer_name: r.reviewer_name || null, reviewed_at: r.reviewed_at || null, review_note: r.review_note || null };
  const saved = await guard(() => store.updateRequest(r.id, {
    status, reviewed_by: S.me.id, reviewer_name: S.me.full_name || S.me.email, reviewed_at: new Date().toISOString(), review_note: note,
  }));
  RV.busy = false;
  if (!saved) { hooks.render(); return; }
  S.requests = S.requests.map((x) => (x.id === r.id ? saved : x));
  RV.skipped = RV.skipped.filter((id) => id !== r.id);
  RV.history.push({ id: r.id, prev, label: `${status === "Approved" ? "approval" : "rejection"} of ${ticketLabel(r.ticket_no)}` });
  if (RV.history.length > 20) RV.history.shift();
  toast(`${status} ${ticketLabel(r.ticket_no)}`);
  setTimeout(() => hooks.render(), 180);
}

async function undo() {
  const h = RV.history.pop();
  if (!h) return;
  const saved = await guard(() => store.updateRequest(h.id, h.prev), "Undone");
  if (!saved) { RV.history.push(h); return; }
  S.requests = S.requests.map((x) => (x.id === h.id ? saved : x));
  RV.skipped = RV.skipped.filter((id) => id !== h.id);
  hooks.render();
}

function later() {
  const card = app.querySelector("#rv-card");
  if (!card) return;
  RV.skipped = [...RV.skipped.filter((id) => id !== card.dataset.id), card.dataset.id];
  card.classList.add("fly-down");
  setTimeout(() => hooks.render(), 160);
}

// Called after every render: load the card's photo and make it draggable.
export function afterRender() {
  const card = app.querySelector("#rv-card");
  if (!card) return;
  const ph = card.querySelector(".rv-photo");
  const r = S.requests.find((x) => x.id === card.dataset.id);
  if (ph?.dataset.path && r) {
    store.photoUrls(r.photos).then((urls) => {
      const u = urls?.[ph.dataset.path];
      if (u && ph.isConnected) ph.insertAdjacentHTML("afterbegin", `<img src="${esc(u)}" alt="Request photo">`);
      ph.querySelector(".ph-loading")?.remove();
    }).catch(() => ph.querySelector(".ph-loading")?.remove());
  }
  let x0 = null, dx = 0;
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("input, button, a, select, textarea")) return;
    x0 = e.clientX; dx = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
  });
  card.addEventListener("pointermove", (e) => {
    if (x0 == null) return;
    dx = e.clientX - x0;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    card.style.setProperty("--yes", Math.max(0, Math.min(1, dx / SWIPE_AT)));
    card.style.setProperty("--no", Math.max(0, Math.min(1, -dx / SWIPE_AT)));
  });
  const end = () => {
    if (x0 == null) return;
    x0 = null;
    card.classList.remove("dragging");
    if (dx > SWIPE_AT) decide("Approved");
    else if (dx < -SWIPE_AT) decide("Rejected");
    else { card.style.transform = ""; card.style.setProperty("--yes", 0); card.style.setProperty("--no", 0); }
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

document.addEventListener("keydown", (e) => {
  if (S.route !== "approvals" || RV.mode !== "swipe" || document.getElementById("modal-root")?.innerHTML) return;
  if (e.target.closest?.("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "ArrowRight") { e.preventDefault(); decide("Approved"); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); decide("Rejected"); }
  else if (e.key === "ArrowDown") { e.preventDefault(); later(); }
});

export const CLICK = {
  "rv-mode"(el) { RV.mode = el.dataset.mode; hooks.render(); },
  "rv-decide"(el) { decide(el.dataset.status); },
  "rv-later"() { later(); },
  "rv-undo"() { undo(); },
};

export const CHANGE = {
  "rv-sub"(el) { RV.sub = el.value; hooks.render(); },
};
