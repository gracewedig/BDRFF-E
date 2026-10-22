// Spec sheet: the FF&E items (with item prices) people pick from on the request
// form. Everyone can browse it; managers add, edit, delete and import items.
import { store } from "./store.js";
import { AREAS, CURRENT, PRICE_DISCLAIMER, money, todayISO } from "./fields.js";
import { S, isManager, hooks } from "./state.js";
import { esc, opt, toast, guard, icon, openModal } from "./ui.js";
import { downloadWorkbook } from "./export.js";

export const specById = (id) => S.specs.find((x) => x.id === id);
const normTag = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Items that apply to a sub-project: its own plus project-wide ones.
export const specsFor = (sub) => S.specs
  .filter((x) => !x.sub_project || !sub || x.sub_project === sub)
  .sort((a, b) => (a.sub_project ? 0 : 1) - (b.sub_project ? 0 : 1) || a.name.localeCompare(b.name));

/* ---------------------------------------------------- request form pieces */
export function specSelectHTML(sub, selected = "") {
  if (AREAS.length && !sub) return '<p class="muted small">Choose a sub-project above to see its spec sheet.</p>';
  const list = specsFor(sub);
  if (!list.length) {
    return `<p class="muted small">No spec sheet items for ${esc(sub || CURRENT.project)} yet.${isManager() ? ' Add them on the <a href="#/spec">Spec Sheet</a> page.' : ""} Describe the item below.</p>
      <input type="hidden" name="spec_item_id" value="">`;
  }
  return `<label>FF&amp;E spec <span class="muted">(pick the item, or “Not listed”)</span>
    <select name="spec_item_id" data-change="spec-pick">
      ${opt("", "Choose from the spec sheet…", !selected)}
      ${list.map((x) => opt(x.id, `${x.name}${x.ffe_tag ? ` · ${x.ffe_tag}` : ""}${x.unit_price != null && x.unit_price !== "" ? ` · ${money(x.unit_price)}` : ""}`, selected === x.id)).join("")}
      ${opt("other", "Not listed / something else", selected === "other")}
    </select></label>`;
}

export function priceHTML(item, qty) {
  if (!item) return "";
  const n = Math.max(1, Number(qty) || 1);
  const has = item.unit_price != null && item.unit_price !== "";
  return `<div class="spec-card">
    <div class="spec-card-main">
      <strong>${esc(item.name)}</strong>
      <div class="muted small">${[item.ffe_tag && `Tag ${item.ffe_tag}`, item.manufacturer, item.vendor && `Vendor: ${item.vendor}`].filter(Boolean).map(esc).join(" · ")}</div>
      ${item.spec ? `<div class="small">${esc(item.spec)}</div>` : ""}
    </div>
    ${has ? `<div class="spec-price"><span class="muted small">${esc(money(item.unit_price))} ${esc(item.unit || "ea")} × ${n}</span><strong>${esc(money(Number(item.unit_price) * n))}</strong></div>` : '<div class="spec-price muted small">No price on file</div>'}
    ${has ? `<p class="disclaimer">${esc(PRICE_DISCLAIMER)}</p>` : ""}
  </div>`;
}

// Attic stock on hand for an FF&E tag (shown when pulling from attic stock).
export function atticHTML(tag, sub) {
  const t = normTag(tag);
  if (t.length < 3) return "";
  const hits = S.inventory.filter((i) => i.stock_type === "Attic Stock" && normTag(i.ffe_tag) === t);
  if (!hits.length) return `<p class="attic-hint none">No attic stock recorded for tag ${esc(tag)}.</p>`;
  const total = hits.reduce((n, i) => n + Number(i.quantity || 0), 0);
  return `<p class="attic-hint ${total ? "" : "none"}">${icon("inventory", "ico xs")} Attic stock: <b>${total}</b> on hand${hits.map((i) => ` · ${esc(i.location || i.sub_project || "")}${i.sub_project && i.sub_project !== sub ? ` (${esc(i.sub_project)})` : ""}: ${esc(i.quantity)}`).join("")}</p>`;
}

/* -------------------------------------------------------------------- page */
export function pageSpec() {
  const f = S.specFilter || { sub: "", q: "" };
  const n = f.q.trim().toLowerCase();
  const list = S.specs.filter((x) => (!f.sub || x.sub_project === f.sub || (f.sub === "_all" && !x.sub_project))
    && (!n || [x.name, x.ffe_tag, x.spec, x.manufacturer, x.vendor].some((v) => String(v || "").toLowerCase().includes(n))));
  const groups = [...AREAS, ""].map((sub) => [sub, list.filter((x) => (x.sub_project || "") === sub)]).filter(([, l]) => l.length);
  return `
  <p class="muted">The FF&amp;E spec items people choose from on the request form, with item prices. ${esc(PRICE_DISCLAIMER)}</p>
  <div class="toolbar">
    <input type="search" class="grow" placeholder="Search item, tag, spec, manufacturer…" value="${esc(f.q)}" data-input="spec-search">
    ${AREAS.length ? `<select data-change="spec-sub">${opt("", "All sub-projects")}${AREAS.map((a) => opt(a, a, f.sub === a)).join("")}${opt("_all", "Every sub-project (project-wide)", f.sub === "_all")}</select>` : ""}
    <button class="btn" data-act="spec-export">${icon("download")} Export</button>
    ${isManager() ? `<a class="btn" href="#/import" data-act="spec-import">${icon("import")} Import</a><button class="btn primary" data-act="spec-new">${icon("new")} Add item</button>` : ""}
  </div>
  <div class="card flush" id="spec-body">${groups.length ? `<div class="table-wrap"><table class="grid">
    <thead><tr><th>Item</th><th>FF&amp;E Tag</th><th>Spec</th><th>Manufacturer / vendor</th><th class="num">Item price</th>${isManager() ? "<th></th>" : ""}</tr></thead>
    <tbody>${groups.map(([sub, l]) => `<tr class="group"><td colspan="${isManager() ? 6 : 5}"><strong>${esc(sub || (AREAS.length ? "Every sub-project" : CURRENT.project))}</strong> <span class="muted">· ${l.length}</span></td></tr>
      ${l.map((x) => `<tr>
        <td data-label="Item"><strong>${esc(x.name)}</strong></td>
        <td data-label="FF&E Tag" class="mono">${esc(x.ffe_tag || "")}</td>
        <td data-label="Spec" class="small">${esc(x.spec || "")}</td>
        <td data-label="Manufacturer / vendor" class="small">${esc([x.manufacturer, x.vendor].filter(Boolean).join(" · "))}</td>
        <td data-label="Item price" class="num">${esc(money(x.unit_price))}${x.unit_price != null && x.unit_price !== "" ? ` <span class="muted small">/${esc(x.unit || "ea")}</span>` : ""}</td>
        ${isManager() ? `<td class="row-actions"><button class="btn small" data-act="spec-edit" data-id="${esc(x.id)}">Edit</button></td>` : ""}
      </tr>`).join("")}`).join("")}</tbody></table></div>`
    : `<div class="empty">${S.specs.length ? "No items match." : `No spec sheet items yet.${isManager() ? " Add items, or import a spreadsheet (Import Spreadsheet → Spec sheet)." : ""}`}</div>`}</div>`;
}

function openSpecForm(id) {
  const x = id ? specById(id) : { sub_project: S.specFilter?.sub && S.specFilter.sub !== "_all" ? S.specFilter.sub : "", unit: "ea" };
  openModal(`
    <header class="modal-head"><h2>${id ? "Edit spec item" : "Add spec item"}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></header>
    <form class="stack" data-form="spec-item">
      <input type="hidden" name="id" value="${esc(id || "")}">
      ${AREAS.length ? `<label>Sub-project<select name="sub_project">${opt("", "Every sub-project", !x.sub_project)}${AREAS.map((a) => opt(a, a, x.sub_project === a)).join("")}</select></label>` : ""}
      <label>Item <em>*</em><input name="name" required value="${esc(x.name || "")}" placeholder="e.g. Balcony lounge chair cushion"></label>
      <div class="row2"><label>FF&amp;E tag<input name="ffe_tag" value="${esc(x.ffe_tag || "")}"></label>
        <label>Item price (each)<input name="unit_price" type="number" min="0" step="0.01" value="${esc(x.unit_price ?? "")}" placeholder="0.00"></label></div>
      <label>Spec <span class="muted">(finish, size, fabric, model)</span><input name="spec" value="${esc(x.spec || "")}"></label>
      <div class="row3"><label>Manufacturer<input name="manufacturer" value="${esc(x.manufacturer || "")}"></label>
        <label>Vendor<input name="vendor" value="${esc(x.vendor || "")}"></label>
        <label>Unit<input name="unit" value="${esc(x.unit || "ea")}"></label></div>
      <label>Notes<input name="notes" value="${esc(x.notes || "")}"></label>
      <div class="btn-row end">${id ? `<button type="button" class="btn reject" data-act="spec-delete" data-id="${esc(id)}">Delete</button><span class="grow"></span>` : ""}
        <button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`);
}

export const CLICK = {
  "spec-new"() { openSpecForm(null); },
  "spec-edit"(el) { openSpecForm(el.dataset.id); },
  async "spec-delete"(el) {
    const x = specById(el.dataset.id);
    if (!confirm(`Delete ${x.name} from the spec sheet? Existing requests keep their details.`)) return;
    const ok = await guard(async () => { await store.deleteSpecItem(x.id); return true; }, "Removed from the spec sheet");
    if (!ok) return;
    S.specs = S.specs.filter((s) => s.id !== x.id);
    hooks.closeModal();
    hooks.render();
  },
  "spec-import"() { S.impTarget = "specs"; location.hash = "#/import"; },
  "spec-export"() {
    const cols = [["sub_project", "Sub-project"], ["name", "Item"], ["ffe_tag", "FF&E Tag"], ["spec", "Spec"], ["manufacturer", "Manufacturer"], ["vendor", "Vendor"], ["unit_price", "Item Price"], ["unit", "Unit"], ["notes", "Notes"]]
      .map(([key, label]) => ({ key, label }));
    downloadWorkbook(`${CURRENT.project} Spec Sheet ${todayISO()}`, [{ name: "Spec Sheet", columns: cols, rows: S.specs.map((x) => ({ ...x, sub_project: x.sub_project || "Every sub-project" })) }]);
  },
};

export const CHANGE = {
  "spec-sub"(el) { S.specFilter = { ...(S.specFilter || { q: "" }), sub: el.value }; hooks.render(); },
};

export const INPUT = {
  "spec-search"(el) {
    S.specFilter = { ...(S.specFilter || { sub: "" }), q: el.value };
    const body = document.getElementById("spec-body");
    if (body) body.outerHTML = pageSpec().match(/<div class="card flush" id="spec-body">[\s\S]*$/)[0];
  },
};

export const SUBMIT = {
  async "spec-item"(form) {
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.name.trim()) { toast("Give the item a name", "err"); return; }
    const item = {
      ...fd, id: fd.id || undefined, name: fd.name.trim(), sub_project: fd.sub_project || null,
      unit_price: fd.unit_price === "" ? null : Math.round(Number(fd.unit_price) * 100) / 100, unit: fd.unit || "ea",
    };
    const saved = await guard(() => store.saveSpecItem(item), "Spec sheet updated");
    if (!saved) return;
    S.specs = item.id ? S.specs.map((x) => (x.id === saved.id ? saved : x)) : [...S.specs, saved];
    hooks.closeModal();
    hooks.render();
  },
};

export const pages = { spec: pageSpec };
