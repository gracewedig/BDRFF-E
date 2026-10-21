// Notes on any item (hover the note icon to read, click to edit) and follow-ups
// on dismissed, rejected or any other request.
import { store } from "./store.js";
import { todayISO, addDaysISO, ticketLabel } from "./fields.js";
import { S, hooks } from "./state.js";
import { esc, fmtDate, guard, icon, openModal, notesChip } from "./ui.js";

export { notesChip };

const LISTS = {
  requests: { list: () => S.requests, set: (v) => { S.requests = v; }, title: (r) => `${ticketLabel(r.ticket_no)} · ${r.item_needed}` },
  inventory_items: { list: () => S.inventory, set: (v) => { S.inventory = v; }, title: (r) => r.item_name },
  email_requests: { list: () => S.emails, set: (v) => { S.emails = v; }, title: (r) => r.subject || r.item_needed || "Email" },
};
const find = (table, id) => LISTS[table].list().find((x) => x.id === id);
const when = (iso) => (iso ? fmtDate(iso.slice(0, 10)) : "");

export function notesBlock(table, item) {
  return `<div class="note-block notes">
    <div class="note-head"><dt>Notes</dt><button class="btn small" data-act="edit-notes" data-table="${table}" data-id="${esc(item.id)}">${item.notes ? "Edit notes" : "Add notes"}</button></div>
    ${item.notes ? `<p>${esc(item.notes)}</p><span class="muted tiny">${esc(item.notes_updated_by_name || "")}${item.notes_updated_at ? ` · ${esc(when(item.notes_updated_at))}` : ""}</span>` : '<p class="muted small">No notes yet.</p>'}
  </div>`;
}

export function followUpBanner(table, item) {
  if (!item.follow_up_on) return "";
  const due = item.follow_up_on <= todayISO();
  return `<div class="callout ${due ? "maybe" : ""} follow">${icon("approvals")}<div><b>Follow up ${due ? "due" : "on"} ${esc(fmtDate(item.follow_up_on))}</b>
    <span class="muted small">${esc(item.follow_up_by_name || "")}${item.follow_up_note ? ` · ${esc(item.follow_up_note)}` : ""}</span></div>
    <div class="btn-row"><button class="btn small" data-act="follow-up" data-table="${table}" data-id="${esc(item.id)}">Change</button>
    <button class="btn small" data-act="follow-up-done" data-table="${table}" data-id="${esc(item.id)}">Done</button></div></div>`;
}

export const followUpsDue = (days = 7) => {
  const limit = addDaysISO(todayISO(), days);
  return [...S.requests, ...S.emails].filter((x) => x.follow_up_on && x.follow_up_on <= limit).length;
};

let returnTo = null; // reopen the ticket dialog after editing its notes

function openNotes(table, id) {
  const it = find(table, id);
  if (!it) return;
  returnTo = table === "requests" && S.modalId === id ? id : null;
  openModal(`
    <header class="modal-head"><div><span class="muted small">Notes</span><h2>${esc(LISTS[table].title(it))}</h2></div>
      <button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></header>
    <form class="stack" data-form="notes">
      <input type="hidden" name="table" value="${table}"><input type="hidden" name="id" value="${esc(id)}">
      <label>Notes <span class="muted">(everyone can see these)</span><textarea name="notes" rows="6" placeholder="Vendor, order numbers, who you talked to, what's next…">${esc(it.notes || "")}</textarea></label>
      ${it.notes_updated_by_name ? `<p class="muted small">Last edited by ${esc(it.notes_updated_by_name)} · ${esc(when(it.notes_updated_at))}</p>` : ""}
      <div class="btn-row end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary" type="submit">Save notes</button></div>
    </form>`);
}

function openFollowUp(table, id) {
  const it = find(table, id);
  if (!it) return;
  returnTo = table === "requests" && S.modalId === id ? id : null;
  openModal(`
    <header class="modal-head"><div><span class="muted small">Follow up</span><h2>${esc(LISTS[table].title(it))}</h2></div>
      <button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></header>
    <form class="stack" data-form="follow-up">
      <input type="hidden" name="table" value="${table}"><input type="hidden" name="id" value="${esc(id)}">
      <label>Follow up on<input type="date" name="on" required value="${esc(it.follow_up_on || addDaysISO(todayISO(), 3))}"></label>
      <label>What needs to happen?<input name="note" value="${esc(it.follow_up_note || "")}" placeholder="e.g. Call the owner to confirm it's still needed"></label>
      <label class="check-label"><input type="checkbox" name="todo" checked> Add it to my action items</label>
      <div class="btn-row end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary" type="submit">Save follow-up</button></div>
    </form>`);
}

async function refreshItem(table) {
  const fresh = await (table === "requests" ? store.listRequests() : table === "inventory_items" ? store.listInventory() : store.listEmailRequests());
  LISTS[table].set(fresh);
}

function finish() {
  hooks.closeModal();
  hooks.render();
  if (returnTo) hooks.openRequest(returnTo);
  returnTo = null;
}

export const CLICK = {
  "edit-notes"(el) { openNotes(el.dataset.table, el.dataset.id); },
  "follow-up"(el) { openFollowUp(el.dataset.table, el.dataset.id); },
  async "follow-up-done"(el) {
    const { table, id } = el.dataset;
    returnTo = table === "requests" && S.modalId === id ? id : null;
    const ok = await guard(async () => { await store.setFollowUp(table, id, null, null); await refreshItem(table); return true; }, "Follow-up cleared");
    if (ok) finish();
  },
};

export const SUBMIT = {
  async notes(form) {
    const fd = Object.fromEntries(new FormData(form));
    const ok = await guard(async () => { await store.setNotes(fd.table, fd.id, fd.notes.trim()); await refreshItem(fd.table); return true; }, "Notes saved");
    if (ok) finish();
  },
  async "follow-up"(form) {
    const fd = Object.fromEntries(new FormData(form));
    const it = find(fd.table, fd.id);
    const ok = await guard(async () => {
      await store.setFollowUp(fd.table, fd.id, fd.on, fd.note.trim());
      if (fd.todo) {
        const label = fd.table === "requests" ? ticketLabel(it.ticket_no) : "";
        const item = await store.saveAction({
          title: `Follow up: ${fd.note.trim() || LISTS[fd.table].title(it)}`.slice(0, 200), status: "Not Started", priority: "Normal",
          due_date: fd.on, linked_ticket: label || null, category: it.sub_project || it.project || "Follow-up",
          notes: fd.table === "email_requests" ? `Email from ${it.from_name || it.from_email}: ${it.subject || ""}` : it.item_needed,
        });
        S.actions.push(item);
      }
      await refreshItem(fd.table);
      return true;
    }, fd.todo ? "Follow-up saved and added to your action items" : "Follow-up saved");
    if (ok) finish();
  },
};

// Floating tooltip for notes, positioned in the page so table scrolling can't clip it.
export function initNoteTips() {
  const tip = document.createElement("div");
  tip.className = "note-tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  const show = (el) => {
    tip.innerHTML = `<b>Notes</b><p>${esc(el.dataset.note)}</p>${el.dataset.noteMeta ? `<em>${esc(el.dataset.noteMeta)}</em>` : ""}`;
    tip.classList.add("on");
    const r = el.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    tip.style.width = `${w}px`;
    const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
    const below = r.bottom + 8 + tip.offsetHeight < window.innerHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 8 : r.top - tip.offsetHeight - 8}px`;
  };
  let current = null;
  const hide = () => { current = null; tip.classList.remove("on"); };
  const open = (el) => { current = el; show(el); };
  document.addEventListener("mouseover", (e) => { const el = e.target.closest?.("[data-note]"); if (el) open(el); });
  document.addEventListener("mouseout", (e) => {
    const from = e.target.closest?.("[data-note]");
    if (from && !from.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => { const el = e.target.closest?.("[data-note]"); if (el) open(el); else hide(); });
  // Follow the icon while the page scrolls; drop it if the icon is gone.
  document.addEventListener("scroll", () => { if (current) { if (current.isConnected) show(current); else hide(); } }, true);
  document.addEventListener("click", hide);
}
