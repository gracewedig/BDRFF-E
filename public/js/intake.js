// Spreadsheet intake: read Excel/CSV files, match their columns, sort every row
// into a project, flag duplicates, then import as inventory or as requests.
import { store } from "./store.js";
import { PROJECTS, STOCK_TYPES, PRIORITIES, matchProject, todayISO, addDaysISO, ticketLabel } from "./fields.js";
import { findMatches, DUP_THRESHOLD } from "./dedupe.js";
import { S, hooks } from "./state.js";
import { esc, opt, badge, toast, guard, icon } from "./ui.js";
import { downloadWorkbook } from "./export.js";
import { reloadInventory } from "./inventory.js";

const TARGETS = {
  inventory: {
    label: "Inventory & attic stock",
    fields: [
      { key: "item_name", label: "Item name", required: true, syn: ["item", "item name", "item description", "description", "name", "product", "ffe item", "ff&e item", "furniture"] },
      { key: "project", label: "Project", syn: ["project", "property", "site", "area", "resort area", "phase"] },
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
      { key: "project", label: "Project", syn: ["project", "property", "site", "area"] },
      { key: "buildings", label: "Building(s)", syn: ["building", "buildings", "bldg", "bldgs", "building #", "building number"] },
      { key: "rooms", label: "Room(s)", syn: ["room", "rooms", "room #", "room number", "unit", "unit #", "suite", "location"] },
      { key: "ffe_tag", label: "FF&E tag", syn: ["ff&e tag", "ffe tag", "tag", "tag #", "tag number", "item code", "code", "sku"] },
      { key: "spec", label: "Specification", syn: ["spec", "specification", "specs", "finish", "model"] },
      { key: "quantity", label: "Quantity", syn: ["qty", "quantity", "count", "units"] },
      { key: "priority", label: "Priority", syn: ["priority", "urgency"] },
      { key: "needed_by", label: "Needed by", syn: ["needed by", "need by", "due", "due date", "date needed", "deadline", "needed"] },
      { key: "requester_name", label: "Requested by", syn: ["requested by", "requester", "submitted by", "name", "contact"] },
      { key: "details", label: "Details / notes", syn: ["details", "notes", "comments", "remarks"] },
    ],
  },
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
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
  return S.inventory.find((it) => it.project === project && (tag
    ? normTag(it.ffe_tag) === tag
    : !it.ffe_tag && it.item_name.toLowerCase() === v.item_name.toLowerCase() && String(it.location || "").toLowerCase() === v.location.toLowerCase()));
}

function buildRows() {
  const imp = S.imp;
  const fields = TARGETS[imp.target].fields;
  const out = [];
  const openRequests = S.requests.filter((r) => !["Rejected", "Cancelled"].includes(r.status));
  for (const sh of imp.sheets) {
    const sheetProject = matchProject(sh.name);
    const sheetType = stockTypeFrom(sh.name);
    sh.rows.forEach((raw, i) => {
      const key = `${sh.name}#${i}`;
      const v = {};
      for (const f of fields) v[f.key] = (imp.mapping[f.key] || []).map((h) => clean(raw[h])).find(Boolean) || "";
      let project = PROJECTS.find((p) => norm(p) === norm(v.project)) || matchProject(v.project);
      let how = project ? "project column" : "";
      if (!project && sheetProject) { project = sheetProject; how = "tab name"; }
      if (!project) {
        const guess = matchProject(Object.values(raw).join(" "));
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
        const ex = project && v.item_name ? existingItem(project, v) : null;
        if (ex) { row.status = "update"; row.existing = ex; row.note = `Updates existing · on hand ${ex.quantity} → ${v.quantity}`; }
      } else {
        v.quantity = Math.max(1, num(v.quantity) ?? 1);
        v.priority = PRIORITIES.find((p) => norm(p) === norm(v.priority)) || (/urgent|asap/i.test(v.priority) ? "Urgent" : "Normal");
        v.needed_by = parseDate(v.needed_by);
        if (!v.item_needed) row.issues.push("Nothing described");
        if (!v.needed_by) row.note = "No date given · set to 30 days out";
        if (project && v.item_needed) {
          const [m] = findMatches({ ...v, project }, openRequests, 1);
          if (m && m.score >= DUP_THRESHOLD) {
            row.status = "duplicate";
            row.note = `Already requested: ${ticketLabel(m.item.ticket_no)} (${m.reasons.join(", ")})`;
          }
        }
      }
      if (!project) row.issues.push("No project");
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
    downloadWorkbook("BDR Inventory Import Template", PROJECTS.map((p) => ({ name: p, columns: cols, rows: [] })));
  } else {
    const cols = ["Project", "Building(s)", "Room(s)", "What's Needed", "FF&E Tag", "Specification", "Quantity", "Priority", "Needed By", "Requested By", "Details"]
      .map((label) => ({ key: label, label }));
    downloadWorkbook("BDR Request Import Template", [{ name: "Requests", columns: cols, rows: [] }]);
  }
}

export function pageImport() {
  const imp = S.imp;
  if (!imp) {
    return `
    <div class="card intake-start">
      <h3>${icon("import")} Import a spreadsheet</h3>
      <p class="muted">Upload an Excel (.xlsx, .xls) or CSV file. Rows are sorted into <b>The Terrace, The Cove, Resort Center, Pickleball or Waterpark</b> using a Project column, the tab name (e.g. a tab called “Cove”), or project names written in the row. You review everything before it's saved.</p>
      <label class="drop">
        ${icon("import", "ico lg")}
        <span>Choose a spreadsheet</span>
        <input type="file" accept=".xlsx,.xls,.xlsm,.csv" data-change="imp-file">
      </label>
      <p class="muted small">Need a starting point? Download a template:
        <button class="link-btn accent" data-act="imp-template" data-target="inventory">Inventory (one tab per project)</button> ·
        <button class="link-btn accent" data-act="imp-template" data-target="requests">Requests</button></p>
    </div>`;
  }
  const t = TARGETS[imp.target];
  const rows = imp.rows;
  const inc = rows.filter((r) => r.include);
  const byProject = [...PROJECTS, ""].map((p) => [p, rows.filter((r) => r.project === p).length]).filter(([, n]) => n);
  const counts = {
    new: rows.filter((r) => r.status === "new" && !r.issues.length).length,
    update: rows.filter((r) => r.status === "update").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    issues: rows.filter((r) => r.issues.length).length,
  };
  const shown = rows.slice(0, 300);
  const cols = imp.target === "inventory"
    ? [["stock_type", "Type"], ["item_name", "Item"], ["ffe_tag", "FF&E Tag"], ["location", "Location"], ["quantity", "Qty"]]
    : [["buildings", "Bldg"], ["rooms", "Room"], ["item_needed", "What's needed"], ["ffe_tag", "FF&E Tag"], ["needed_by", "Needed by"]];

  return `
  <div class="card intake-file">
    <div><h3>${icon("import")} ${esc(imp.fileName)}</h3>
      <p class="muted small">${imp.sheets.length} tab${imp.sheets.length === 1 ? "" : "s"} (${imp.sheets.map((s) => `${esc(s.name)}: ${s.rows.length}`).join(", ")}) · ${rows.length} rows</p></div>
    <button class="btn small" data-act="imp-reset">Choose a different file</button>
  </div>

  <div class="card">
    <div class="row3">
      <label>Import into<select data-change="imp-target">${Object.entries(TARGETS).map(([k, x]) => opt(k, x.label, imp.target === k)).join("")}</select></label>
      <label>Rows with no project go to<select data-change="imp-default-project">${opt("", "Nowhere — I'll pick")}${PROJECTS.map((p) => opt(p, p, imp.defaultProject === p)).join("")}</select></label>
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
    ${byProject.map(([p, n]) => `<span class="pill ${p ? "" : "warn"}">${esc(p || "No project")} <b>${n}</b></span>`).join("")}
    <span class="grow"></span>
    ${counts.new ? `<span class="pill ok">New <b>${counts.new}</b></span>` : ""}
    ${counts.update ? `<span class="pill info">Updates <b>${counts.update}</b></span>` : ""}
    ${counts.duplicate ? `<span class="pill warn">Already requested <b>${counts.duplicate}</b></span>` : ""}
    ${counts.issues ? `<span class="pill bad">Need attention <b>${counts.issues}</b></span>` : ""}
  </div>

  <div class="card flush">
    <div class="table-wrap"><table class="grid imp-grid">
      <thead><tr><th><input type="checkbox" data-change="imp-all" ${inc.length === rows.length ? "checked" : ""} aria-label="Select all"></th><th>Project</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join("")}<th>Status</th></tr></thead>
      <tbody>${shown.map((r, i) => `
        <tr class="${r.include ? "" : "off"}">
          <td><input type="checkbox" data-change="imp-include" data-idx="${i}" ${r.include ? "checked" : ""} aria-label="Include row"></td>
          <td data-label="Project"><select data-change="imp-row-project" data-idx="${i}" class="${r.project ? "" : "invalid"}">${opt("", "Choose…")}${PROJECTS.map((p) => opt(p, p, r.project === p)).join("")}</select>
            ${r.how && r.how !== "set by you" ? `<div class="muted tiny">from ${esc(r.how)}</div>` : ""}</td>
          ${cols.map(([k, l]) => `<td data-label="${esc(l)}">${esc(r.v[k])}</td>`).join("")}
          <td data-label="Status">${r.issues.length ? badge(r.issues.join(", "), "rejected") : r.status === "update" ? badge("Update", "approved") : r.status === "duplicate" ? badge("Duplicate", "pending") : badge("New", "completed")}
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
  const rows = imp.rows.filter((r) => r.include && !r.issues.length && r.project);
  if (!rows.length) return;
  imp.busy = true;
  hooks.render();
  if (imp.target === "inventory") {
    const fresh = [], updates = [];
    for (const r of rows) {
      const v = { ...r.v, project: r.project };
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
  } else {
    const later = addDaysISO(todayISO(), 30);
    const payload = rows.map((r) => ({
      project: r.project, buildings: r.v.buildings || "TBD", rooms: r.v.rooms || "TBD", item_needed: r.v.item_needed,
      ffe_tag: r.v.ffe_tag || "TBD", spec: r.v.spec, quantity: r.v.quantity, priority: r.v.priority,
      needed_by: r.v.needed_by || later, details: r.v.details, source: "import", status: "Pending",
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
    const target = /neededby|duedate|room/.test(h) && !/onhand|par|storage/.test(h) ? "requests" : "inventory";
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
