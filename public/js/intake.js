// Spreadsheet intake: read Excel/CSV files, match their columns, sort every row
// into a sub-project, flag duplicates, then import as inventory or as requests.
import { store } from "./store.js";
import { AREAS, CURRENT, STOCK_TYPES, matchSubProject, fulfillmentFrom, todayISO, addDaysISO, ticketLabel } from "./fields.js";
import { findMatches, rejectedMatch, DUP_THRESHOLD } from "./dedupe.js";
import { S, hooks } from "./state.js";
import { esc, opt, badge, toast, guard, icon } from "./ui.js";
import { downloadWorkbook } from "./export.js";
import { reloadInventory } from "./inventory.js";

const TARGETS = {
  inventory: {
    label: "Inventory & attic stock",
    fields: [
      { key: "item_name", label: "Item name", required: true, syn: ["item", "item name", "item description", "description", "name", "product", "ffe item", "ff&e item", "furniture"] },
      { key: "sub_project", label: "Sub-project", syn: ["sub project", "sub-project", "subproject", "project", "area", "property", "site", "resort area", "phase"] },
      { key: "stock_type", label: "Attic stock / inventory", syn: ["stock type", "type", "attic stock", "attic", "inventory type"] },
      { key: "ffe_tag", label: "FF&E tag", syn: ["ff&e tag", "ffe tag", "tag", "tag #", "tag number", "tag no", "item code", "code", "sku", "spec #", "spec number", "item #", "item number"] },
      { key: "category", label: "Category", syn: ["category", "group", "class", "item type", "room type"] },
      { key: "description", label: "Description / spec", syn: ["spec", "specification", "specs", "finish", "model", "size", "details", "color"] },
      { key: "location", label: "Storage location", syn: ["location", "storage location", "storage", "bin", "shelf", "where stored", "stored at", "building", "bldg"] },
      { key: "quantity", label: "Quantity on hand", syn: ["qty", "quantity", "on hand", "qty on hand", "quantity on hand", "count", "units", "total", "stock", "amount"] },
      { key: "unit", label: "Unit", syn: ["unit", "uom", "unit of measure"] },
      { key: "min_qty", label: "Par level", syn: ["par", "par level", "min", "minimum", "min qty", "reorder", "reorder point", "reorder level"] },
      { key: "vendor", label: "Vendor", syn: ["vendor", "supplier", "manufacturer", "mfr", "mfg"] },
      { key: "notes", label: "Notes", syn: ["notes", "note", "comments", "comment", "remarks"] },
    ],
  },
  requests: {
    label: "FF&E requests",
    fields: [
      { key: "item_needed", label: "What's needed", required: true, syn: ["what's needed", "whats needed", "item needed", "item", "request", "description", "issue", "need", "item description"] },
      { key: "sub_project", label: "Sub-project", syn: ["sub project", "sub-project", "subproject", "project", "area", "property", "site"] },
      { key: "buildings", label: "Building(s)", syn: ["building", "buildings", "bldg", "bldgs", "building #", "building number"] },
      { key: "rooms", label: "Room(s)", syn: ["room", "rooms", "room #", "room number", "unit", "unit #", "suite", "location"] },
      { key: "ffe_tag", label: "FF&E tag", syn: ["ff&e tag", "ffe tag", "tag", "tag #", "tag number", "item code", "code", "sku"] },
      { key: "spec", label: "Specification", syn: ["spec", "specification", "specs", "finish", "model"] },
      { key: "quantity", label: "Quantity", syn: ["qty", "quantity", "count", "units"] },
      { key: "fulfillment", label: "Attic stock or order new", syn: ["attic stock or order", "attic or order", "attic stock / order", "pull or order", "fulfillment", "source", "order new"] },
      { key: "needed_by", label: "Desired delivery date", syn: ["desired delivery", "desired delivery date", "delivery date", "delivery", "needed by", "need by", "due", "due date", "date needed", "deadline", "needed"] },
      { key: "requester_name", label: "Requested by", syn: ["requested by", "requester", "submitted by", "name", "contact"] },
      { key: "details", label: "Details / notes", syn: ["details", "notes", "comments", "remarks"] },
    ],
  },
  specs: {
    label: "Spec sheet (items and prices)",
    fields: [
      { key: "name", label: "Item", required: true, syn: ["item", "item name", "name", "description", "item description", "product", "ffe item", "ff&e item"] },
      { key: "sub_project", label: "Sub-project", syn: ["sub project", "sub-project", "subproject", "project", "area", "property", "site"] },
      { key: "ffe_tag", label: "FF&E tag", syn: ["ff&e tag", "ffe tag", "tag", "tag #", "tag number", "item code", "code", "sku", "spec #", "spec number", "item #", "item number"] },
      { key: "spec", label: "Spec", syn: ["spec", "specification", "specs", "finish", "model", "size", "details", "color"] },
      { key: "manufacturer", label: "Manufacturer", syn: ["manufacturer", "mfr", "mfg", "brand", "maker"] },
      { key: "vendor", label: "Vendor", syn: ["vendor", "supplier", "source", "dealer"] },
      { key: "unit_price", label: "Item price", syn: ["price", "unit price", "unit cost", "cost", "item price", "each", "price each", "cost each", "amount"] },
      { key: "unit", label: "Unit", syn: ["unit", "uom", "unit of measure"] },
      { key: "notes", label: "Notes", syn: ["notes", "note", "comments", "remarks"] },
    ],
  },
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const money = (v) => { const n = parseFloat(String(v ?? "").replace(/[$, ]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[, ]/g, "")); return Number.isFinite(n) ? Math.round(n) : null; };

function parseDate(v) {
  const s = clean(v);
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d) ? "" : todayISO(d);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Finds the header row (the first rows of a sheet are often titles or blank).
function sheetFromRows(name, aoa) {
  let hi = 0, best = -1;
  aoa.slice(0, 15).forEach((r, i) => {
    const n = r.filter((c) => clean(c) && isNaN(Number(c))).length;
    if (n > best) { best = n; hi = i; }
  });
  const seen = {};
  const headers = (aoa[hi] || []).map((h, i) => {
    let name = clean(h) || `Column ${i + 1}`;
    if (seen[name]) name = `${name} (${++seen[name]})`; else seen[name] = 1;
    return name;
  });
  const rows = aoa.slice(hi + 1)
    .filter((r) => r.some((c) => clean(c)))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { name, headers, rows };
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  if (/\.csv$/i.test(file.name)) return [sheetFromRows(file.name.replace(/\.csv$/i, ""), parseCsv(new TextDecoder().decode(buf).replace(/^﻿/, "")))];
  if (!window.XLSX) throw new Error("Excel support didn't load. Check your connection, or save the file as CSV and try again.");
  const wb = window.XLSX.read(buf, { type: "array", cellDates: true });
  return wb.SheetNames
    .map((n) => sheetFromRows(n, window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: "", raw: false, dateNF: "yyyy-mm-dd" })))
    .filter((s) => s.rows.length);
}

// Each field maps to a list of headers: tabs in one workbook often name the same
// column differently ("Item Description" on one tab, "Item" on another).
function guessMapping(sheets, fields) {
  const mapping = {};
  for (const sh of sheets) {
    for (const [k, h] of Object.entries(guessSheet(sh.headers, fields))) {
      mapping[k] = [...new Set([...(mapping[k] || []), h])];
    }
  }
  return mapping;
}

function guessSheet(headers, fields) {
  const mapping = {};
  const used = new Set();
  const nh = headers.map((h) => [h, norm(h)]);
  for (const pass of ["exact", "contains"]) {
    for (const f of fields) {
      if (mapping[f.key]) continue;
      const syns = [norm(f.label), ...f.syn.map(norm)];
      const hit = nh.find(([h, n]) => !used.has(h) && (pass === "exact" ? syns.includes(n) : syns.some((s) => s.length >= 3 && n.includes(s))));
      if (hit) { mapping[f.key] = hit[0]; used.add(hit[0]); }
    }
  }
  return mapping;
}

const stockTypeFrom = (v) => (/attic/i.test(v) ? "Attic Stock" : /inv/i.test(v) ? "Inventory" : "");
const normTag = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function existingItem(project, v) {
  const tag = normTag(v.ffe_tag);
  return S.inventory.find((it) => (it.sub_project || "") === project && (tag
    ? normTag(it.ffe_tag) === tag
    : !it.ffe_tag && it.item_name.toLowerCase() === v.item_name.toLowerCase() && String(it.location || "").toLowerCase() === v.location.toLowerCase()));
}

function buildRows() {
  const imp = S.imp;
  const fields = TARGETS[imp.target].fields;
  const out = [];
  const openRequests = S.requests.filter((r) => !["Rejected", "Cancelled", "Fulfilled"].includes(r.status));
  for (const sh of imp.sheets) {
    const sheetProject = matchSubProject(sh.name);
    const sheetType = stockTypeFrom(sh.name);
    sh.rows.forEach((raw, i) => {
      const key = `${sh.name}#${i}`;
      const v = {};
      for (const f of fields) v[f.key] = (imp.mapping[f.key] || []).map((h) => clean(raw[h])).find(Boolean) || "";
      // "project" here is the sub-project within the project being worked on.
      let project = AREAS.find((p) => norm(p) === norm(v.sub_project)) || matchSubProject(v.sub_project);
      let how = project ? "sub-project column" : "";
      if (!project && sheetProject) { project = sheetProject; how = "tab name"; }
      if (!project) {
        const guess = matchSubProject(Object.values(raw).join(" "));
        if (guess) { project = guess; how = "row text"; }
      }
      if (!project && imp.defaultProject) { project = imp.defaultProject; how = "default"; }
      const ov = imp.overrides[key] || {};
      if (ov.project !== undefined) { project = ov.project; how = "set by you"; }

      const row = { key, sheet: sh.name, project, how, v, issues: [], status: "new", note: "" };
      if (imp.target === "inventory") {
        v.stock_type = stockTypeFrom(v.stock_type) || sheetType || imp.defaultStockType;
        v.quantity = num(v.quantity) ?? 0;
        v.min_qty = num(v.min_qty);
        if (!v.item_name) row.issues.push("No item name");
        const ex = (project || !AREAS.length) && v.item_name ? existingItem(project, v) : null;
        if (ex) { row.status = "update"; row.existing = ex; row.note = `Updates existing · on hand ${ex.quantity} → ${v.quantity}`; }
      } else if (imp.target === "specs") {
        v.unit_price = money(v.unit_price);
        if (!v.name) row.issues.push("No item name");
        const tag = normTag(v.ffe_tag);
        const ex = v.name && S.specs.find((x) => (x.sub_project || "") === (project || "")
          && (tag ? normTag(x.ffe_tag) === tag : !x.ffe_tag && x.name.toLowerCase() === v.name.toLowerCase()));
        if (ex) { row.status = "update"; row.existing = ex; row.note = ex.unit_price !== v.unit_price && v.unit_price != null ? `Updates existing · price ${ex.unit_price ?? "none"} → ${v.unit_price}` : "Updates existing"; }
      } else {
        v.quantity = Math.max(1, num(v.quantity) ?? 1);
        v.fulfillment = fulfillmentFrom(v.fulfillment);
        v.needed_by = parseDate(v.needed_by);
        if (!v.item_needed) row.issues.push("Nothing described");
        if (!v.needed_by) row.note = "No date given · set to 30 days out";
        if ((project || !AREAS.length) && v.item_needed) {
          const [m] = findMatches({ ...v, sub_project: project }, openRequests, 1);
          if (m && m.score >= DUP_THRESHOLD) {
            row.status = "duplicate";
            row.note = `Already requested: ${ticketLabel(m.item.ticket_no)} (${m.reasons.join(", ")})`;
          } else {
            const again = rejectedMatch({ ...v, project: CURRENT.project, sub_project: project }, S.requests);
            if (again) { row.duplicateOf = again.root.id; row.note = `Like rejected ${ticketLabel(again.root.ticket_no)} · goes to Duplicate requests`; }
          }
        }
      }
      // Spec items without a sub-project apply to every sub-project.
      if (!project && AREAS.length && imp.target !== "specs") row.issues.push("No sub-project");
      row.include = ov.include !== undefined ? ov.include : !row.issues.length && row.status !== "duplicate";
      if (Object.values(v).some((x) => x !== "" && x != null && x !== 0) || Object.values(raw).some((c) => clean(c))) out.push(row);
    });
  }
  imp.rows = out;
}

/* -------------------------------------------------------------------- page */
function templateDownload(target) {
  if (target === "inventory") {
    const cols = ["Item Name", "FF&E Tag", "Type (Attic Stock / Inventory)", "Category", "Description / Spec", "Storage Location", "Quantity On Hand", "Unit", "Par Level", "Vendor", "Notes"]
      .map((label) => ({ key: label, label }));
    const tabs = AREAS.length ? AREAS : [CURRENT.project];
    downloadWorkbook(`${CURRENT.project} Inventory Import Template`, tabs.map((p) => ({ name: p, columns: cols, rows: [] })));
  } else if (target === "specs") {
    const cols = ["Sub-project", "Item", "FF&E Tag", "Spec", "Manufacturer", "Vendor", "Item Price", "Unit", "Notes"].map((label) => ({ key: label, label }));
    downloadWorkbook(`${CURRENT.project} Spec Sheet Import Template`, [{ name: "Spec Sheet", columns: cols, rows: [] }]);
  } else {
    const cols = ["Sub-project", "Building(s)", "Room(s)", "What's Needed", "FF&E Tag", "Specification", "Quantity", "Attic Stock or Order", "Desired Delivery Date", "Requested By", "Details"]
      .map((label) => ({ key: label, label }));
    downloadWorkbook(`${CURRENT.project} Request Import Template`, [{ name: "Requests", columns: cols, rows: [] }]);
  }
}

export function pageImport() {
  const imp = S.imp;
  if (!imp) {
    return `
    <div class="card intake-start">
      <h3>${icon("import")} Import a spreadsheet</h3>
      <p class="muted">Upload an Excel (.xlsx, .xls) or CSV file to bring it into <b>${esc(CURRENT.project)}</b>.${AREAS.length ? ` Rows are sorted into its sub-projects (<b>${esc(AREAS.join(", "))}</b>) using a Sub-project column, the tab name (e.g. a tab called “Cove”), or sub-project names written in the row.` : ""} You review everything before it's saved.</p>
      <label class="drop">
        ${icon("import", "ico lg")}
        <span>Choose a spreadsheet</span>
        <input type="file" accept=".xlsx,.xls,.xlsm,.csv" data-change="imp-file">
      </label>
      <p class="muted small">Need a starting point? Download a template:
        <button class="link-btn accent" data-act="imp-template" data-target="inventory">Inventory${AREAS.length ? " (one tab per sub-project)" : ""}</button> ·
        <button class="link-btn accent" data-act="imp-template" data-target="requests">Requests</button> ·
        <button class="link-btn accent" data-act="imp-template" data-target="specs">Spec sheet</button></p>
    </div>`;
  }
  const t = TARGETS[imp.target];
  const rows = imp.rows;
  const inc = rows.filter((r) => r.include);
  const byProject = AREAS.length ? [...AREAS, ""].map((p) => [p, rows.filter((r) => r.project === p).length]).filter(([, n]) => n) : [];
  const counts = {
    new: rows.filter((r) => r.status === "new" && !r.issues.length).length,
    update: rows.filter((r) => r.status === "update").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    issues: rows.filter((r) => r.issues.length).length,
  };
  const shown = rows.slice(0, 300);
  const cols = imp.target === "inventory"
    ? [["stock_type", "Type"], ["item_name", "Item"], ["ffe_tag", "FF&E Tag"], ["location", "Location"], ["quantity", "Qty"]]
    : imp.target === "specs" ? [["name", "Item"], ["ffe_tag", "FF&E Tag"], ["spec", "Spec"], ["unit_price", "Item price"]]
    : [["buildings", "Bldg"], ["rooms", "Room"], ["item_needed", "What's needed"], ["ffe_tag", "FF&E Tag"], ["needed_by", "Delivery"]];

  return `
  <div class="card intake-file">
    <div><h3>${icon("import")} ${esc(imp.fileName)}</h3>
      <p class="muted small">${imp.sheets.length} tab${imp.sheets.length === 1 ? "" : "s"} (${imp.sheets.map((s) => `${esc(s.name)}: ${s.rows.length}`).join(", ")}) · ${rows.length} rows</p></div>
    <button class="btn small" data-act="imp-reset">Choose a different file</button>
  </div>

  <div class="card">
    <div class="row3">
      <label>Import into<select data-change="imp-target">${Object.entries(TARGETS).map(([k, x]) => opt(k, x.label, imp.target === k)).join("")}</select></label>
      ${AREAS.length ? `<label>Rows with no sub-project go to<select data-change="imp-default-project">${opt("", imp.target === "specs" ? "Every sub-project" : "Nowhere — I'll pick")}${AREAS.map((p) => opt(p, p, imp.defaultProject === p)).join("")}</select></label>` : `<label>Project<input value="${esc(CURRENT.project)}" disabled></label>`}
      ${imp.target === "inventory" ? `<label>Type when the sheet doesn't say<select data-change="imp-default-type">${STOCK_TYPES.map((s) => opt(s, s, imp.defaultStockType === s)).join("")}</select></label>` : "<span></span>"}
    </div>
    <details ${Object.keys(imp.mapping).length < 2 ? "open" : ""}>
      <summary>Match columns <span class="muted small">(${Object.keys(imp.mapping).length} of ${t.fields.length} matched automatically)</span></summary>
      <div class="map-grid">${t.fields.map((f) => `
        <label>${esc(f.label)}${f.required ? " <em>*</em>" : ""}
          <select data-change="imp-map" data-key="${f.key}">${opt("", "— not in this file —")}${imp.headers.map((h) => opt(h, h, imp.mapping[f.key]?.[0] === h)).join("")}</select>
          ${imp.mapping[f.key]?.length > 1 ? `<span class="muted tiny">also: ${esc(imp.mapping[f.key].slice(1).join(", "))}</span>` : ""}
        </label>`).join("")}
      </div>
    </details>
  </div>

  <div class="imp-summary">
    ${byProject.map(([p, n]) => `<span class="pill ${p ? "" : "warn"}">${esc(p || "No sub-project")} <b>${n}</b></span>`).join("")}
    <span class="grow"></span>
    ${counts.new ? `<span class="pill ok">New <b>${counts.new}</b></span>` : ""}
    ${counts.update ? `<span class="pill info">Updates <b>${counts.update}</b></span>` : ""}
    ${counts.duplicate ? `<span class="pill warn">Already requested <b>${counts.duplicate}</b></span>` : ""}
    ${counts.issues ? `<span class="pill bad">Need attention <b>${counts.issues}</b></span>` : ""}
  </div>

  <div class="card flush">
    <div class="table-wrap"><table class="grid imp-grid">
      <thead><tr><th><input type="checkbox" data-change="imp-all" ${inc.length === rows.length ? "checked" : ""} aria-label="Select all"></th>${AREAS.length ? "<th>Sub-project</th>" : ""}${cols.map(([, l]) => `<th>${esc(l)}</th>`).join("")}<th>Status</th></tr></thead>
      <tbody>${shown.map((r, i) => `
        <tr class="${r.include ? "" : "off"}">
          <td><input type="checkbox" data-change="imp-include" data-idx="${i}" ${r.include ? "checked" : ""} aria-label="Include row"></td>
          ${AREAS.length ? `<td data-label="Sub-project"><select data-change="imp-row-project" data-idx="${i}" class="${r.project ? "" : "invalid"}">${opt("", "Choose…")}${AREAS.map((p) => opt(p, p, r.project === p)).join("")}</select>
            ${r.how && r.how !== "set by you" ? `<div class="muted tiny">from ${esc(r.how)}</div>` : ""}</td>` : ""}
          ${cols.map(([k, l]) => `<td data-label="${esc(l)}">${esc(r.v[k])}</td>`).join("")}
          <td data-label="Status">${r.issues.length ? badge(r.issues.join(", "), "rejected") : r.status === "update" ? badge("Update", "approved") : r.status === "duplicate" ? badge("Duplicate", "pending") : badge("New", "fulfilled")}
            ${r.note ? `<div class="muted tiny">${esc(r.note)}</div>` : ""}</td>
        </tr>`).join("")}
      </tbody></table></div>
    ${rows.length > shown.length ? `<p class="muted small more">Showing the first ${shown.length} rows; all ${rows.length} are imported according to your choices.</p>` : ""}
  </div>

  <div class="form-actions">
    <span class="muted small">${inc.filter((r) => r.issues.length).length ? "Rows marked “Need attention” are skipped until fixed." : ""}</span>
    <button class="btn primary lg" data-act="imp-run" ${imp.busy || !inc.length ? "disabled" : ""}>${imp.busy ? "Importing…" : `Import ${inc.filter((r) => !r.issues.length).length} row${inc.length === 1 ? "" : "s"}`}</button>
  </div>`;
}

async function runImport() {
  const imp = S.imp;
  const rows = imp.rows.filter((r) => r.include && !r.issues.length && (r.project || !AREAS.length || imp.target === "specs"));
  if (!rows.length) return;
  imp.busy = true;
  hooks.render();
  if (imp.target === "inventory") {
    const fresh = [], updates = [];
    for (const r of rows) {
      const v = { ...r.v, sub_project: r.project || null };
      const item = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "" && x != null));
      if (r.existing) updates.push({ ...r.existing, ...item, id: r.existing.id });
      else fresh.push({ unit: "ea", ...item, quantity: v.quantity, stock_type: v.stock_type });
    }
    const ok = await guard(async () => { await store.bulkSaveInventory(fresh, updates); await reloadInventory(); return true; });
    imp.busy = false;
    if (!ok) { hooks.render(); return; }
    toast(`Imported ${fresh.length} new item${fresh.length === 1 ? "" : "s"}${updates.length ? `, updated ${updates.length}` : ""}`);
    S.imp = null;
    location.hash = "#/inventory";
  } else if (imp.target === "specs") {
    const fresh = [], updates = [];
    for (const r of rows) {
      const item = Object.fromEntries(Object.entries({ ...r.v, sub_project: r.project || null }).filter(([k, x]) => (x !== "" && x != null) || k === "sub_project"));
      if (r.existing) updates.push({ ...r.existing, ...item, id: r.existing.id });
      else fresh.push({ unit: "ea", ...item });
    }
    const ok = await guard(async () => { await store.bulkSaveSpecItems(fresh, updates); S.specs = await store.listSpecItems(); return true; });
    imp.busy = false;
    if (!ok) { hooks.render(); return; }
    toast(`Added ${fresh.length} spec item${fresh.length === 1 ? "" : "s"}${updates.length ? `, updated ${updates.length}` : ""}`);
    S.imp = null;
    location.hash = "#/spec";
  } else {
    const later = addDaysISO(todayISO(), 30);
    const payload = rows.map((r) => ({
      sub_project: r.project || null, buildings: r.v.buildings || "TBD", rooms: r.v.rooms || "TBD", item_needed: r.v.item_needed,
      ffe_tag: r.v.ffe_tag || "TBD", spec: r.v.spec, quantity: r.v.quantity, fulfillment: r.v.fulfillment || null,
      needed_by: r.v.needed_by || later, details: r.v.details, source: "import",
      ...(r.duplicateOf ? { status: "Duplicate", duplicate_of: r.duplicateOf } : { status: "Pending" }),
      ...(r.v.requester_name ? { requester_name: r.v.requester_name } : {}),
    }));
    const created = await guard(() => store.insertRequests(payload));
    imp.busy = false;
    if (!created) { hooks.render(); return; }
    S.requests = await store.listRequests();
    toast(`Imported ${created.length} request${created.length === 1 ? "" : "s"} for review`);
    S.imp = null;
    location.hash = "#/requests";
  }
}

/* ---------------------------------------------------------------- handlers */
export const CLICK = {
  "imp-template"(el) { templateDownload(el.dataset.target); },
  "imp-reset"() { S.imp = null; hooks.render(); },
  "imp-run"() { runImport(); },
};

export const CHANGE = {
  async "imp-file"(el) {
    const file = el.files[0];
    el.value = "";
    if (!file) return;
    const sheets = await guard(() => readFile(file));
    if (!sheets) return;
    if (!sheets.length) { toast("That file doesn't have any rows", "err"); return; }
    const headers = [...new Set(sheets.flatMap((s) => s.headers))];
    // Guess the target: quantities/locations suggest inventory; rooms/needed-by suggest requests.
    const h = norm(headers.join(" "));
    const target = S.impTarget === "specs" || (/price|cost/.test(h) && !/room|onhand/.test(h)) ? "specs"
      : /neededby|duedate|delivery|room/.test(h) && !/onhand|par|storage/.test(h) ? "requests" : "inventory";
    S.impTarget = "";
    S.imp = {
      fileName: file.name, sheets, headers, target, mapping: guessMapping(sheets, TARGETS[target].fields),
      defaultProject: "", defaultStockType: "Attic Stock", overrides: {}, rows: [], busy: false,
    };
    buildRows();
    hooks.render();
  },
  "imp-target"(el) {
    S.imp.target = el.value;
    S.imp.mapping = guessMapping(S.imp.sheets, TARGETS[el.value].fields);
    buildRows();
    hooks.render();
  },
  "imp-default-project"(el) { S.imp.defaultProject = el.value; buildRows(); hooks.render(); },
  "imp-default-type"(el) { S.imp.defaultStockType = el.value; buildRows(); hooks.render(); },
  "imp-map"(el) {
    if (el.value) S.imp.mapping[el.dataset.key] = [el.value]; else delete S.imp.mapping[el.dataset.key];
    buildRows();
    hooks.render();
  },
  "imp-row-project"(el) {
    const r = S.imp.rows[Number(el.dataset.idx)];
    S.imp.overrides[r.key] = { ...S.imp.overrides[r.key], project: el.value, include: !!el.value };
    buildRows();
    hooks.render();
  },
  "imp-include"(el) {
    const r = S.imp.rows[Number(el.dataset.idx)];
    S.imp.overrides[r.key] = { ...S.imp.overrides[r.key], include: el.checked };
    buildRows();
    hooks.render();
  },
  "imp-all"(el) {
    for (const r of S.imp.rows) S.imp.overrides[r.key] = { ...S.imp.overrides[r.key], include: el.checked };
    buildRows();
    hooks.render();
  },
};

export const pages = { import: pageImport };
