// Inventory & attic stock: per-project views, taking stock out (and where it went),
// returns, and the movement log.
import { store } from "./store.js";
import { PROJECTS, STOCK_TYPES, todayISO, ticketLabel } from "./fields.js";
import { S, isManager, hooks } from "./state.js";
import { app, esc, opt, badge, fmtDate, toast, guard, icon, openModal } from "./ui.js";
import { downloadWorkbook } from "./export.js";

export const isLow = (it) => it.min_qty != null && it.min_qty !== "" && Number(it.quantity) <= Number(it.min_qty);
const itemById = (id) => S.inventory.find((x) => x.id === id);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const where = (m) => [m.dest_project, m.dest_building && `Bldg ${m.dest_building}`, m.dest_room && `Rm ${m.dest_room}`].filter(Boolean).join(" · ");

function filtered() {
  const { project, type, q, lowOnly } = S.inv;
  const n = q.trim().toLowerCase();
  return S.inventory.filter((it) =>
    (!project || it.project === project) && (!type || it.stock_type === type) && (!lowOnly || isLow(it)) &&
    (!n || [it.item_name, it.ffe_tag, it.category, it.location, it.description, it.vendor].some((v) => String(v || "").toLowerCase().includes(n))));
}

function lastMoves() {
  const m = {};
  for (const mv of S.moves) if (!m[mv.item_id]) m[mv.item_id] = mv;
  return m;
}

function summaryHTML() {
  return `<div class="projects">${PROJECTS.map((p) => {
    const items = S.inventory.filter((i) => i.project === p);
    const units = (t) => items.filter((i) => i.stock_type === t).reduce((n, i) => n + Number(i.quantity || 0), 0);
    const low = items.filter(isLow).length;
    return `<button class="project-card" data-act="inv-project" data-project="${esc(p)}">
      <span class="pc-name">${esc(p)}</span>
      <span class="inv-split"><span><b>${units("Attic Stock")}</b> attic stock</span><span><b>${units("Inventory")}</b> inventory</span></span>
      <span class="pc-meta">${items.length} item${items.length === 1 ? "" : "s"}${low ? ` · <b class="overdue">${low} low</b>` : ""}</span>
    </button>`;
  }).join("")}</div>`;
}

function itemsHTML() {
  const items = filtered();
  if (!items.length) {
    return `<div class="empty">${S.inventory.length ? "No items match these filters." : `No inventory yet.${isManager() ? " Import a spreadsheet or add items one at a time." : ""}`}</div>`;
  }
  const groupKey = S.inv.project ? "category" : "project";
  const order = (i) => (groupKey === "project" ? PROJECTS.indexOf(i.project) : 0);
  items.sort((a, b) => order(a) - order(b) || String(a[groupKey] || "~").localeCompare(String(b[groupKey] || "~")) || a.item_name.localeCompare(b.item_name));
  const last = lastMoves();
  let group = null;
  const rows = items.map((it) => {
    let head = "";
    const g = it[groupKey] || (groupKey === "category" ? "Uncategorized" : "");
    if (g !== group) {
      group = g;
      const n = items.filter((x) => (x[groupKey] || (groupKey === "category" ? "Uncategorized" : "")) === g).length;
      head = `<tr class="group"><td colspan="8"><strong>${esc(g)}</strong> <span class="muted">· ${n}</span></td></tr>`;
    }
    const lm = last[it.id];
    return head + `<tr class="click" data-act="open-item" data-id="${esc(it.id)}">
      <td data-label="Item"><strong>${esc(it.item_name)}</strong>${it.description ? `<div class="muted small">${esc(it.description)}</div>` : ""}</td>
      <td data-label="FF&E tag"><span class="mono">${esc(it.ffe_tag || "")}</span></td>
      <td data-label="Location">${esc(it.location || "")}</td>
      <td data-label="Type">${badge(it.stock_type, it.stock_type === "Attic Stock" ? "attic" : "inv")}</td>
      <td data-label="On hand" class="num"><strong class="${isLow(it) ? "overdue" : ""}">${esc(it.quantity)}</strong> <span class="muted small">${esc(it.unit || "ea")}</span>${isLow(it) ? ` ${badge("Low", "p-high")}` : ""}</td>
      <td data-label="Par" class="num muted">${esc(it.min_qty ?? "")}</td>
      <td data-label="Last moved" class="small muted">${lm ? `${lm.direction === "out" ? "Out" : "In"} ${lm.quantity} · ${esc(fmtDate(lm.moved_at.slice(0, 10)))}` : ""}</td>
      <td class="row-actions"><button class="btn small" data-act="inv-take" data-id="${esc(it.id)}" ${Number(it.quantity) > 0 ? "" : "disabled"}>${icon("out")} Take out</button></td>
    </tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="grid inv-grid">
    <thead><tr><th>Item</th><th>FF&amp;E Tag</th><th>Location</th><th>Type</th><th>On hand</th><th>Par</th><th>Last moved</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function movesFor(project) {
  return S.moves.filter((m) => !project || itemById(m.item_id)?.project === project || m.dest_project === project);
}

function movesHTML(moves, limit = 12) {
  if (!moves.length) return `<div class="empty">Nothing has been taken out or returned yet.</div>`;
  return `<div class="table-wrap"><table class="grid">
    <thead><tr><th>When</th><th>Item</th><th></th><th>Qty</th><th>Where it went</th><th>Ticket</th><th>By</th><th>Note</th></tr></thead>
    <tbody>${moves.slice(0, limit).map((m) => {
      const it = itemById(m.item_id);
      return `<tr>
        <td data-label="When" class="small">${esc(fmtTime(m.moved_at))}</td>
        <td data-label="Item">${it ? `<button class="link-btn" data-act="open-item" data-id="${esc(it.id)}">${esc(it.item_name)}</button><div class="muted small">${esc(it.project)}</div>` : '<span class="muted">Deleted item</span>'}</td>
        <td data-label="">${m.direction === "out" ? badge("Out", "out") : badge("Returned", "completed")}</td>
        <td data-label="Qty" class="num">${esc(m.quantity)} <span class="muted small">→ ${esc(m.qty_after)} left</span></td>
        <td data-label="Where it went">${esc(where(m)) || '<span class="muted">—</span>'}</td>
        <td data-label="Ticket" class="mono">${esc(m.linked_ticket || "")}</td>
        <td data-label="By">${esc(m.moved_by_name || "")}</td>
        <td data-label="Note" class="small">${esc(m.note || "")}</td>
      </tr>`;
    }).join("")}</tbody></table></div>
    ${moves.length > limit ? `<p class="muted small more">Showing the latest ${limit} of ${moves.length}. Export for the full log.</p>` : ""}`;
}

export function pageInventory() {
  const f = S.inv;
  const count = (p) => S.inventory.filter((i) => i.project === p).length;
  const low = S.inventory.filter((i) => (!f.project || i.project === f.project) && isLow(i)).length;
  return `
  <div class="seg-row" role="tablist" aria-label="Project">
    <button class="seg ${!f.project ? "on" : ""}" data-act="inv-project" data-project="">All projects <span>${S.inventory.length}</span></button>
    ${PROJECTS.map((p) => `<button class="seg ${f.project === p ? "on" : ""}" data-act="inv-project" data-project="${esc(p)}">${esc(p)} <span>${count(p)}</span></button>`).join("")}
  </div>
  <div class="toolbar">
    <input type="search" class="grow" placeholder="Search item, tag, location, vendor…" value="${esc(f.q)}" data-input="inv-search">
    <select data-change="inv-type">${opt("", "Attic stock & inventory")}${STOCK_TYPES.map((t) => opt(t, t, f.type === t)).join("")}</select>
    <label class="check-label"><input type="checkbox" data-change="inv-low" ${f.lowOnly ? "checked" : ""}> Low stock only${low ? ` (${low})` : ""}</label>
    <button class="btn" data-act="inv-export">${icon("download")} Export</button>
    ${isManager() ? `<a class="btn" href="#/import">${icon("import")} Import spreadsheet</a>
    <button class="btn primary" data-act="inv-new">${icon("new")} Add item</button>` : ""}
  </div>
  ${f.project ? "" : summaryHTML()}
  <h2 class="section">${esc(f.project || "All projects")}${f.type ? ` · ${esc(f.type)}` : ""}</h2>
  <div class="card flush" id="inv-body">${itemsHTML()}</div>
  <div class="section-head">
    <h2 class="section">Movement log${f.project ? ` · ${esc(f.project)}` : ""}</h2>
    <button class="btn small" data-act="inv-export-moves">${icon("download")} Export log</button>
  </div>
  <div class="card flush">${movesHTML(movesFor(f.project))}</div>`;
}

/* ------------------------------------------------------------------ modals */
function ticketOptions(project, selected) {
  const reqs = S.requests.filter((r) => !project || r.project === project).sort((a, b) => b.ticket_no - a.ticket_no);
  return opt("", "—") + reqs.map((r) => opt(ticketLabel(r.ticket_no), `${ticketLabel(r.ticket_no)} · ${String(r.item_needed).slice(0, 40)}`, selected === ticketLabel(r.ticket_no))).join("");
}

function openMove(id, direction) {
  const it = itemById(id);
  if (!it) return;
  const out = direction === "out";
  openModal(`
    <header class="modal-head">
      <div><span class="muted small">${esc(it.project)} · ${esc(it.stock_type)}</span><h2>${out ? "Take out" : "Return / add stock"}: ${esc(it.item_name)}</h2>
      <p class="muted small">${esc(it.quantity)} ${esc(it.unit || "ea")} on hand${it.location ? ` · ${esc(it.location)}` : ""}</p></div>
      <button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button>
    </header>
    <form class="stack" data-form="inv-move">
      <input type="hidden" name="item_id" value="${esc(it.id)}">
      <input type="hidden" name="direction" value="${out ? "out" : "in"}">
      <label>Quantity <em>*</em><input name="quantity" type="number" min="1" ${out ? `max="${esc(it.quantity)}"` : ""} value="1" required></label>
      <fieldset class="sub">
        <legend>${out ? "Where did it go?" : "Where did it come from?"} <span class="muted">(optional)</span></legend>
        <div class="row3">
          <label>Project<select name="dest_project">${opt("", "—")}${PROJECTS.map((p) => opt(p, p, out && p === it.project)).join("")}</select></label>
          <label>Building<input name="dest_building" placeholder="e.g. 89"></label>
          <label>Room<input name="dest_room" placeholder="e.g. 8902"></label>
        </div>
        <label>For ticket<select name="linked_ticket">${ticketOptions(it.project)}</select></label>
        <label>Note<input name="note" placeholder="${out ? "e.g. Replaced torn cushion" : "e.g. Vendor delivery"}"></label>
      </fieldset>
      <div class="btn-row end">
        <button type="button" class="btn" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${out ? "Take out" : "Add to stock"}</button>
      </div>
    </form>`);
}

function openItem(id) {
  const it = itemById(id);
  if (!it) return;
  const moves = S.moves.filter((m) => m.item_id === id);
  const f = (label, v) => (v === "" || v == null ? "" : `<div><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>`);
  openModal(`
    <header class="modal-head">
      <div><span class="mono muted">${esc(it.ffe_tag || "")}</span><h2>${esc(it.item_name)}</h2>
        <div class="btn-row">${badge(it.project, "proj")} ${badge(it.stock_type, it.stock_type === "Attic Stock" ? "attic" : "inv")} ${isLow(it) ? badge("Low stock", "p-high") : ""}</div></div>
      <button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button>
    </header>
    <dl class="facts">
      <div><dt>On hand</dt><dd class="big">${esc(it.quantity)} <span class="muted small">${esc(it.unit || "ea")}</span></dd></div>
      ${f("Par level", it.min_qty)}${f("Category", it.category)}${f("Storage location", it.location)}${f("Vendor", it.vendor)}${f("Description / spec", it.description)}
    </dl>
    ${it.notes ? `<div class="note-block"><dt>Notes</dt><p>${esc(it.notes)}</p></div>` : ""}
    <h3 class="ph-head">History <span class="muted">(${moves.length})</span></h3>
    ${movesHTML(moves, 50)}
    <footer class="modal-foot">
      ${isManager() ? `<button class="btn reject" data-act="inv-delete" data-id="${esc(id)}">Delete</button><button class="btn" data-act="inv-edit" data-id="${esc(id)}">Edit</button><span class="grow"></span>` : ""}
      <button class="btn" data-act="inv-add-stock" data-id="${esc(id)}">Return / add stock</button>
      <button class="btn primary" data-act="inv-take" data-id="${esc(id)}" ${Number(it.quantity) > 0 ? "" : "disabled"}>${icon("out")} Take out</button>
    </footer>`, { wide: true });
}

function openItemForm(id) {
  const it = id ? itemById(id) : { project: S.inv.project || "", stock_type: S.inv.type || "Attic Stock", quantity: 0, unit: "ea" };
  openModal(`
    <header class="modal-head"><h2>${id ? "Edit item" : "Add inventory item"}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></header>
    <form class="stack" data-form="inv-item">
      <input type="hidden" name="id" value="${esc(id || "")}">
      <div class="row2">
        <label>Project <em>*</em><select name="project" required>${opt("", "Choose…")}${PROJECTS.map((p) => opt(p, p, it.project === p)).join("")}</select></label>
        <label>Type<select name="stock_type">${STOCK_TYPES.map((t) => opt(t, t, it.stock_type === t)).join("")}</select></label>
      </div>
      <label>Item name <em>*</em><input name="item_name" required value="${esc(it.item_name || "")}"></label>
      <div class="row2">
        <label>FF&amp;E tag<input name="ffe_tag" value="${esc(it.ffe_tag || "")}"></label>
        <label>Category<input name="category" value="${esc(it.category || "")}" placeholder="e.g. Seating, Lighting" list="inv-cats"></label>
      </div>
      <datalist id="inv-cats">${[...new Set(S.inventory.map((i) => i.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <label>Description / spec<input name="description" value="${esc(it.description || "")}" placeholder="manufacturer, model, finish, size"></label>
      <label>Storage location<input name="location" value="${esc(it.location || "")}" placeholder="e.g. Bldg 89 attic, shelf B"></label>
      <div class="row3">
        <label>On hand<input name="quantity" type="number" min="0" value="${esc(it.quantity ?? 0)}"></label>
        <label>Unit<input name="unit" value="${esc(it.unit || "ea")}"></label>
        <label>Par level <span class="muted">(warn at)</span><input name="min_qty" type="number" min="0" value="${esc(it.min_qty ?? "")}"></label>
      </div>
      <label>Vendor<input name="vendor" value="${esc(it.vendor || "")}"></label>
      <label>Notes<textarea name="notes" rows="2">${esc(it.notes || "")}</textarea></label>
      <div class="btn-row end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`);
}

function exportInventory(movesOnly = false) {
  const p = S.inv.project;
  const cols = [
    { key: "project", label: "Project" }, { key: "stock_type", label: "Type" }, { key: "item_name", label: "Item" },
    { key: "ffe_tag", label: "FF&E Tag" }, { key: "category", label: "Category" }, { key: "description", label: "Description / Spec" },
    { key: "location", label: "Storage Location" }, { key: "quantity", label: "On Hand" }, { key: "unit", label: "Unit" },
    { key: "min_qty", label: "Par Level" }, { key: "low", label: "Low Stock" }, { key: "vendor", label: "Vendor" }, { key: "notes", label: "Notes" },
  ];
  const moveCols = [
    { key: "when", label: "Date" }, { key: "item", label: "Item" }, { key: "project", label: "From Project" }, { key: "tag", label: "FF&E Tag" },
    { key: "dir", label: "Out / In" }, { key: "quantity", label: "Qty" }, { key: "qty_after", label: "Left After" },
    { key: "dest_project", label: "To Project" }, { key: "dest_building", label: "Building" }, { key: "dest_room", label: "Room" },
    { key: "linked_ticket", label: "Ticket" }, { key: "moved_by_name", label: "By" }, { key: "note", label: "Note" },
  ];
  const moveRows = movesFor(p).map((m) => {
    const it = itemById(m.item_id) || {};
    return { ...m, when: (m.moved_at || "").slice(0, 10), item: it.item_name || "(deleted)", project: it.project || "", tag: it.ffe_tag || "", dir: m.direction === "out" ? "Out" : "In" };
  });
  const tabs = [];
  if (!movesOnly) {
    const items = filtered();
    for (const proj of p ? [p] : PROJECTS) {
      const rows = items.filter((i) => i.project === proj).map((i) => ({ ...i, low: isLow(i) ? "LOW" : "" }));
      if (rows.length) tabs.push({ name: proj, columns: cols, rows });
    }
  }
  tabs.push({ name: "Movement Log", columns: moveCols, rows: moveRows });
  downloadWorkbook(`BDR ${movesOnly ? "Inventory Movement Log" : "Inventory"}${p ? ` - ${p}` : ""} ${todayISO()}`, tabs);
}

export async function reloadInventory() {
  const [inv, moves] = await Promise.all([store.listInventory(), store.listMoves()]);
  S.inventory = inv;
  S.moves = moves;
}

/* ---------------------------------------------------------------- handlers */
export const CLICK = {
  "inv-project"(el) { S.inv.project = el.dataset.project; hooks.render(); },
  "inv-take"(el) { openMove(el.dataset.id, "out"); },
  "inv-add-stock"(el) { openMove(el.dataset.id, "in"); },
  "open-item"(el) { openItem(el.dataset.id); },
  "inv-new"() { openItemForm(null); },
  "inv-edit"(el) { openItemForm(el.dataset.id); },
  async "inv-delete"(el) {
    const it = itemById(el.dataset.id);
    if (!confirm(`Delete “${it.item_name}” and its history?`)) return;
    const ok = await guard(async () => { await store.deleteInventoryItem(it.id); return true; }, "Item deleted");
    if (!ok) return;
    S.inventory = S.inventory.filter((x) => x.id !== it.id);
    S.moves = S.moves.filter((m) => m.item_id !== it.id);
    hooks.closeModal();
    hooks.render();
  },
  "inv-export"() { exportInventory(false); },
  "inv-export-moves"() { exportInventory(true); },
};

export const CHANGE = {
  "inv-type"(el) { S.inv.type = el.value; hooks.render(); },
  "inv-low"(el) { S.inv.lowOnly = el.checked; hooks.render(); },
};

export const INPUT = {
  "inv-search"(el) { S.inv.q = el.value; const body = app.querySelector("#inv-body"); if (body) body.innerHTML = itemsHTML(); },
};

export const SUBMIT = {
  async "inv-move"(form) {
    const fd = Object.fromEntries(new FormData(form));
    const move = { ...fd, quantity: parseInt(fd.quantity, 10) };
    const it = itemById(move.item_id);
    if (!(move.quantity >= 1)) { toast("Enter a quantity of at least 1", "err"); return; }
    if (move.direction === "out" && move.quantity > Number(it.quantity)) { toast(`Only ${it.quantity} on hand`, "err"); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const saved = await guard(() => store.recordMove(move));
    btn.disabled = false;
    if (!saved) return;
    await guard(reloadInventory);
    hooks.closeModal();
    hooks.render();
    toast(move.direction === "out"
      ? `Took out ${move.quantity} · ${saved.quantity} left${where(move) ? ` · to ${where(move)}` : ""}`
      : `Added ${move.quantity} · ${saved.quantity} on hand`);
  },
  async "inv-item"(form) {
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.project || !fd.item_name.trim()) { toast("Project and item name are required", "err"); return; }
    const item = {
      ...fd, id: fd.id || undefined, item_name: fd.item_name.trim(), quantity: Math.max(0, parseInt(fd.quantity, 10) || 0),
      min_qty: fd.min_qty === "" ? null : Math.max(0, parseInt(fd.min_qty, 10) || 0),
    };
    const saved = await guard(() => store.saveInventoryItem(item), "Item saved");
    if (!saved) return;
    S.inventory = item.id ? S.inventory.map((x) => (x.id === saved.id ? saved : x)) : [...S.inventory, saved];
    hooks.closeModal();
    hooks.render();
  },
};

export const pages = { inventory: pageInventory };
