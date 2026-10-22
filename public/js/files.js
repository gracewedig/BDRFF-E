// Files & Assistant: upload PDFs and spreadsheets to a project/sub-project, keep
// them to open later, and have the assistant turn them into requests sorted into
// the right sub-projects. People can chat with it about how to organize things.
import { store } from "./store.js";
import { AREAS, CURRENT, todayISO, addDaysISO, ticketLabel, PRIORITIES, matchSubProject } from "./fields.js";
import { parseEmailHeuristic } from "./emailparse.js";
import { findMatches, DUP_THRESHOLD } from "./dedupe.js";
import { S, isManager, hooks } from "./state.js";
import { modalRoot, esc, opt, badge, fmtDate, toast, guard, icon, openModal } from "./ui.js";

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const CHUNK_CHARS = 12000;
const MIN_SPLIT = 2500;
const MAX_SCANNED_PDF = 4e6;

const fresh = () => ({ session: null, defaultSub: "", instructions: "" });
export const FA = fresh();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const kindOf = (name) => (/\.pdf$/i.test(name) ? "pdf" : /\.(xlsx|xls|xlsm|csv)$/i.test(name) ? "spreadsheet" : "other");
const sizeLabel = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/* ------------------------------------------------------------ reading files */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`) && window.pdfjsLib) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("Couldn't load the PDF reader. Check your connection."));
    document.head.appendChild(el);
  });
}

async function pdfText(file) {
  await loadScript(PDFJS);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+\n/g, "\n").trim();
    pages.push(`--- Page ${n} ---\n${text}`);
  }
  return { text: pages.join("\n\n"), pages: pdf.numPages };
}

async function sheetText(file) {
  if (/\.csv$/i.test(file.name)) return { text: `--- Sheet: ${file.name} ---\n${await file.text()}` };
  if (!window.XLSX) throw new Error("Excel support didn't load. Check your connection, or save the file as CSV.");
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return {
    text: wb.SheetNames.map((n) => `--- Sheet: ${n} ---\n${window.XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false, dateNF: "yyyy-mm-dd" })}`).join("\n\n"),
  };
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(new Error("Couldn't read the file"));
  r.readAsDataURL(file);
});

// Splits text into pieces at line breaks; spreadsheet pieces repeat their sheet's
// header line so every piece still makes sense on its own.
function chunk(text, size = CHUNK_CHARS) {
  const out = [];
  let cur = "", header = "", sheetHead = "";
  for (const line of text.split("\n")) {
    if (/^--- (Sheet|Page)/.test(line)) { header = line; sheetHead = ""; }
    else if (header.startsWith("--- Sheet") && !sheetHead && line.trim()) sheetHead = line;
    if (cur.length + line.length + 1 > size && cur) {
      out.push(cur);
      cur = [header, header.startsWith("--- Sheet") && sheetHead && line !== sheetHead ? sheetHead : ""].filter((x) => x && x !== line).join("\n");
      if (cur) cur += "\n";
    }
    cur += line + "\n";
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function halves(text) {
  const mid = text.lastIndexOf("\n", Math.floor(text.length / 2));
  const at = mid > 0 ? mid : Math.floor(text.length / 2);
  return [text.slice(0, at), text.slice(at)];
}

/* ------------------------------------------------------------ the assistant */
const RETRYABLE = new Set([413, 500, 502, 503, 504]);

function basePayload(s) {
  return {
    project: CURRENT.project, subprojects: [...AREAS], default_sub_project: s.defaultSub, today: todayISO(),
    file_name: s.name, messages: s.messages.filter((m) => m.role === "user" || m.role === "assistant").slice(-20),
  };
}

// Reads one piece; if the server runs out of time or room, splits it and tries again.
async function readPiece(s, text, label, depth = 0) {
  try {
    return (await store.askAssistant({ ...basePayload(s), mode: "extract", text, part: label.part, parts: label.parts })).items || [];
  } catch (e) {
    const timedOut = e instanceof TypeError || RETRYABLE.has(e.status);
    if (e.status === 503 && /isn't set up|Demo/i.test(e.message)) throw e;
    if (timedOut && text.length > MIN_SPLIT && depth < 4) {
      const [a, b] = halves(text);
      return [...await readPiece(s, a, label, depth + 1), ...await readPiece(s, b, label, depth + 1)];
    }
    throw e;
  }
}

// Built-in reader used when the AI assistant isn't connected: one request per line
// that looks like FF&E work.
function ruleBasedItems(s) {
  const items = [];
  let where = "", headingSub = "", headingBldg = "";
  for (const raw of s.fullText.split("\n")) {
    const line = raw.trim();
    if (/^--- (Sheet|Page)/.test(line)) { where = line.replace(/-/g, "").trim(); continue; }
    if (line.length < 8) continue;
    const f = parseEmailHeuristic({ subject: "", text: line.replace(/,/g, ", "), hint: CURRENT.project });
    // A line naming a sub-project without asking for anything is a heading for the lines below it.
    if (!f.is_request) {
      const sub = matchSubProject(line);
      if (sub) { headingSub = sub; headingBldg = f.buildings; }
      continue;
    }
    items.push({
      sub_project: f.sub_project || headingSub || s.defaultSub, buildings: f.buildings || (f.sub_project ? "" : headingBldg), rooms: f.rooms,
      item_needed: line.replace(/\s*,\s*/g, " · ").slice(0, 160), ffe_tag: f.ffe_tag, spec: "", quantity: f.quantity,
      priority: f.priority, needed_by: f.needed_by, details: "", where,
    });
  }
  return items;
}

function decorate(items, s) {
  const open = S.requests.filter((r) => !["Rejected", "Cancelled"].includes(r.status));
  return items.map((it) => {
    const item = { ...it, _id: uid(), sub_project: AREAS.includes(it.sub_project) ? it.sub_project : (it.sub_project ? "" : s.defaultSub) };
    const [m] = findMatches({ ...item, project: CURRENT.project }, open, 1);
    item._dup = m && m.score >= DUP_THRESHOLD ? `${ticketLabel(m.item.ticket_no)} (${m.reasons.join(", ")})` : "";
    item._include = !item._dup;
    return item;
  });
}

async function startSession(file) {
  const s = {
    file, name: file.name, kind: kindOf(file.name), size: file.size, defaultSub: FA.defaultSub, fullText: "", parts: [],
    messages: [], items: [], busy: true, step: "Reading the file…", ai: true, doc: null, created: null,
  };
  if (FA.instructions.trim()) s.messages.push({ role: "user", content: FA.instructions.trim() });
  FA.session = s;
  hooks.render();
  try {
    // Keep a copy of the file with the project so anyone can open it later.
    const path = await guard(() => store.uploadDocument(file));
    s.doc = await guard(() => store.saveDocument({
      name: file.name, kind: s.kind, path: path || null, size_bytes: file.size, sub_project: s.defaultSub || null,
    }));
    if (s.doc) S.docs = [s.doc, ...S.docs.filter((d) => d.id !== s.doc.id)];

    let pdfBase64 = "";
    if (s.kind === "pdf") {
      const { text, pages } = await pdfText(file);
      s.fullText = text;
      s.pages = pages;
      if (text.replace(/--- Page \d+ ---/g, "").trim().length < 200) {
        if (file.size > MAX_SCANNED_PDF) throw new Error("This PDF looks scanned (no text inside) and is too large to read. Try a smaller or text-based PDF.");
        pdfBase64 = await toBase64(file);
      }
    } else if (s.kind === "spreadsheet") {
      s.fullText = (await sheetText(file)).text;
    } else {
      throw new Error("Upload a PDF, Excel (.xlsx/.xls) or CSV file.");
    }
    s.parts = pdfBase64 ? [""] : chunk(s.fullText);

    let items = [];
    try {
      for (let i = 0; i < s.parts.length; i++) {
        s.step = s.parts.length > 1 ? `The assistant is reading part ${i + 1} of ${s.parts.length}…` : "The assistant is reading the file…";
        hooks.render();
        if (pdfBase64) {
          items.push(...((await store.askAssistant({ ...basePayload(s), mode: "extract", pdf_base64: pdfBase64, part: 1, parts: 1 })).items || []));
        } else {
          items.push(...await readPiece(s, s.parts[i], { part: i + 1, parts: s.parts.length }));
        }
      }
      s.items = decorate(items, s);
      s.messages.push({ role: "assistant", content: summary(s) });
    } catch (e) {
      if (!(e.status === 503 || e.status === 404 || store.mode === "demo") || pdfBase64) throw e;
      // No AI connected: fall back to the built-in reader.
      s.ai = false;
      s.items = decorate(ruleBasedItems(s), s);
      s.messages.push({ role: "assistant", content: `${summary(s)} (The AI assistant isn't connected, so I used the built-in reader. Results are rougher and chat is limited.${s.kind === "spreadsheet" ? " For spreadsheets, Import Spreadsheet also works well." : ""})` });
    }
  } catch (e) {
    s.error = e.message || "Couldn't read the file";
  }
  s.busy = false;
  s.step = "";
  hooks.render();
}

function summary(s) {
  if (!s.items.length) return `I didn't find any FF&E requests in ${s.name}. Tell me what to look for, e.g. "every line marked 'replace'".`;
  const by = {};
  for (const it of s.items) by[it.sub_project || "No sub-project"] = (by[it.sub_project || "No sub-project"] || 0) + 1;
  const dups = s.items.filter((i) => i._dup).length;
  return `I found ${s.items.length} request${s.items.length === 1 ? "" : "s"}: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(", ")}.`
    + `${dups ? ` ${dups} look${dups === 1 ? "s" : ""} already requested and ${dups === 1 ? "is" : "are"} unchecked.` : ""}`
    + " Check them over, or tell me how to change them.";
}

async function chat(text) {
  const s = FA.session;
  s.messages.push({ role: "user", content: text });
  if (!s.ai) {
    s.messages.push({ role: "assistant", content: "Chat needs the AI assistant, which isn't connected on this site yet. You can still edit, uncheck or move requests yourself on the right." });
    hooks.render();
    return;
  }
  s.busy = true;
  s.step = "Thinking…";
  hooks.render();
  try {
    const compact = s.items.map(({ _id, _dup, _include, ...it }) => it);
    const res = await store.askAssistant({ ...basePayload(s), mode: "chat", text: s.fullText.slice(0, 40000), items: compact });
    s.items = decorate(res.items || [], s);
    s.messages.push({ role: "assistant", content: res.reply || summary(s) });
  } catch (e) {
    s.messages.push({ role: "assistant", content: `Sorry, I couldn't do that: ${e.message}` });
  }
  s.busy = false;
  s.step = "";
  hooks.render();
  document.querySelector(".fa-chat-log")?.scrollTo({ top: 1e6 });
}

async function createRequests() {
  const s = FA.session;
  const chosen = s.items.filter((i) => i._include);
  if (!chosen.length) { toast("Check at least one request", "err"); return; }
  if (AREAS.length && chosen.some((i) => !i.sub_project)) { toast("Pick a sub-project for every checked request", "err"); return; }
  s.busy = true;
  s.step = `Creating ${chosen.length} request${chosen.length === 1 ? "" : "s"}…`;
  hooks.render();
  const later = addDaysISO(todayISO(), 30);
  const rows = chosen.map((i) => ({
    project: CURRENT.project, sub_project: i.sub_project || null, buildings: i.buildings || "TBD", rooms: i.rooms || "TBD",
    item_needed: i.item_needed, ffe_tag: i.ffe_tag || "TBD", spec: i.spec || "", quantity: Math.max(1, Number(i.quantity) || 1),
    priority: PRIORITIES.includes(i.priority) ? i.priority : "Normal", needed_by: i.needed_by || later, status: "Pending",
    details: [i.details, i.where && `From ${s.name}, ${i.where}`].filter(Boolean).join("\n"), source: "document", source_ref: s.doc?.id || null,
  }));
  const created = await guard(() => store.insertRequests(rows));
  if (created) {
    const subs = [...new Set(chosen.map((i) => i.sub_project).filter(Boolean))];
    if (s.doc) {
      const doc = await guard(() => store.saveDocument({ id: s.doc.id, sub_projects: subs, requests_created: (s.doc.requests_created || 0) + created.length, summary: s.messages.filter((m) => m.role === "assistant").pop()?.content || null }));
      if (doc) { s.doc = doc; S.docs = S.docs.map((d) => (d.id === doc.id ? doc : d)); }
    }
    S.requests = await store.listRequests();
    const by = {};
    for (const i of chosen) by[i.sub_project || "No sub-project"] = (by[i.sub_project || "No sub-project"] || 0) + 1;
    s.created = { count: created.length, by };
    s.items = s.items.filter((i) => !i._include);
    toast(`Created ${created.length} request${created.length === 1 ? "" : "s"} for review`);
  }
  s.busy = false;
  s.step = "";
  hooks.render();
}

/* --------------------------------------------------------------- files list */
export function filesListHTML({ sub = "", limit = 0, empty = "No files yet." } = {}) {
  let docs = S.docs.filter((d) => !sub || d.sub_project === sub || (d.sub_projects || []).includes(sub));
  const total = docs.length;
  if (limit) docs = docs.slice(0, limit);
  if (!docs.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="file-list">${docs.map((d) => {
    const subs = [...new Set([d.sub_project, ...(d.sub_projects || [])].filter(Boolean))];
    const mine = d.uploaded_by === S.me?.id;
    return `<div class="file-row">
      <span class="file-icon ${d.kind}">${d.kind === "pdf" ? "PDF" : d.kind === "spreadsheet" ? "XLS" : "FILE"}</span>
      <div class="file-main">
        <button class="link-btn" data-act="doc-view" data-id="${esc(d.id)}">${esc(d.name)}</button>
        <div class="muted small">${esc(d.uploaded_by_name || "")} · ${esc(fmtDate((d.created_at || "").slice(0, 10)))}${d.size_bytes ? ` · ${sizeLabel(d.size_bytes)}` : ""}${d.requests_created ? ` · ${d.requests_created} request${d.requests_created === 1 ? "" : "s"} created` : ""}</div>
        ${subs.length ? `<div class="file-tags">${subs.map((x) => `<span class="tag small-tag">${esc(x)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="btn-row">
        <button class="btn small" data-act="doc-view" data-id="${esc(d.id)}">Open</button>
        ${mine || isManager() ? `<button class="icon-btn" data-act="doc-delete" data-id="${esc(d.id)}" aria-label="Delete ${esc(d.name)}">${icon("trash")}</button>` : ""}
      </div>
    </div>`;
  }).join("")}</div>${limit && total > limit ? `<p class="muted small more"><a href="#/files">See all ${total} files</a></p>` : ""}`;
}

async function viewDoc(id) {
  const d = S.docs.find((x) => x.id === id);
  if (!d) return;
  openModal(`<header class="modal-head"><div><span class="muted small">${esc(d.kind === "pdf" ? "PDF" : "Spreadsheet")}</span><h2>${esc(d.name)}</h2></div>
    <button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></header>
    <div class="doc-view" id="doc-view"><div class="busy"><span class="spinner"></span> Opening…</div></div>`, { wide: true });
  const url = await guard(() => store.documentUrl(d));
  const box = modalRoot.querySelector("#doc-view");
  if (!box) return;
  if (!url) { box.innerHTML = `<div class="empty">This file's contents aren't available here${store.mode === "demo" ? " (Demo mode only keeps small files)" : ""}.</div>`; return; }
  const blob = await fetch(url).then((r) => r.blob()).catch(() => null);
  if (!blob) { box.innerHTML = '<div class="empty">Couldn\'t open the file.</div>'; return; }
  const local = URL.createObjectURL(blob);
  const download = `<p class="btn-row end"><a class="btn small" href="${local}" download="${esc(d.name)}">${icon("download")} Download</a></p>`;
  if (d.kind === "pdf") {
    box.innerHTML = `${download}<iframe class="pdf-frame" src="${local}" title="${esc(d.name)}"></iframe>`;
  } else if (d.kind === "spreadsheet" && window.XLSX) {
    const wb = window.XLSX.read(await blob.arrayBuffer(), { type: "array", cellDates: true });
    const sheet = (name) => {
      const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false }).slice(0, 300);
      return `<div class="table-wrap sheet-preview"><table class="grid">${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("")}</table></div>`;
    };
    box.innerHTML = `${download}${wb.SheetNames.length > 1 ? `<div class="seg-row">${wb.SheetNames.map((n, i) => `<button class="seg ${i ? "" : "on"}" data-sheet="${esc(n)}">${esc(n)}</button>`).join("")}</div>` : ""}<div id="sheet-body">${sheet(wb.SheetNames[0])}</div>`;
    box.querySelectorAll("[data-sheet]").forEach((b) => b.addEventListener("click", () => {
      box.querySelectorAll("[data-sheet]").forEach((x) => x.classList.toggle("on", x === b));
      box.querySelector("#sheet-body").innerHTML = sheet(b.dataset.sheet);
    }));
  } else {
    box.innerHTML = `${download}<div class="empty">Preview isn't available for this file type.</div>`;
  }
}

/* --------------------------------------------------------------------- page */
function itemsHTML(s) {
  const groups = [...AREAS, ""].map((sub) => [sub, s.items.filter((i) => (i.sub_project || "") === sub)]).filter(([, list]) => list.length);
  const n = s.items.filter((i) => i._include).length;
  return `
  <div class="fa-items-head">
    <div><h3>Proposed requests</h3><p class="muted small">${s.items.length} found · ${n} checked. They're created as Pending for approval.</p></div>
    <button class="btn primary" data-act="fa-create" ${s.busy || !n ? "disabled" : ""}>Create ${n} request${n === 1 ? "" : "s"}</button>
  </div>
  ${groups.map(([sub, list]) => `
    <div class="fa-group"><h4>${esc(sub || (AREAS.length ? "Needs a sub-project" : CURRENT.project))} <span class="muted">· ${list.length}</span></h4>
    ${list.map((i) => `
      <div class="fa-item ${i._include ? "" : "off"}">
        <input type="checkbox" data-change="fa-include" data-id="${i._id}" ${i._include ? "checked" : ""} aria-label="Include">
        <div class="fa-item-main">
          <input class="fa-title" value="${esc(i.item_needed)}" data-change="fa-field" data-field="item_needed" data-id="${i._id}" aria-label="What's needed">
          <div class="muted small">${[i.buildings && `Bldg ${i.buildings}`, i.rooms && `Rm ${i.rooms}`, i.ffe_tag && `Tag ${i.ffe_tag}`, i.quantity > 1 && `Qty ${i.quantity}`, i.needed_by && `By ${fmtDate(i.needed_by)}`, i.priority !== "Normal" && i.priority].filter(Boolean).map(esc).join(" · ")}${i.where ? ` <span class="tiny">(${esc(i.where)})</span>` : ""}</div>
          ${i._dup ? `<div class="small">${badge(`Already requested: ${i._dup}`, "pending")}</div>` : ""}
        </div>
        ${AREAS.length ? `<select data-change="fa-sub" data-id="${i._id}" aria-label="Sub-project">${opt("", "Sub-project…")}${AREAS.map((a) => opt(a, a, i.sub_project === a)).join("")}</select>` : ""}
      </div>`).join("")}
    </div>`).join("") || '<div class="empty">No requests proposed yet.</div>'}`;
}

function sessionHTML(s) {
  return `
  <div class="fa-head">
    <button class="back-link" data-act="fa-close">${icon("back")}<span>Files</span></button>
    <div class="grow"><strong>${esc(s.name)}</strong> <span class="muted small">${s.kind === "pdf" ? `PDF${s.pages ? ` · ${s.pages} page${s.pages === 1 ? "" : "s"}` : ""}` : "Spreadsheet"} · ${sizeLabel(s.size)}${s.defaultSub ? ` · uploaded to ${esc(s.defaultSub)}` : ""}</span></div>
  </div>
  ${s.error ? `<div class="card"><p class="notice bad-notice">${esc(s.error)}</p><button class="btn" data-act="fa-close">Back</button></div>` : `
  ${s.created ? `<div class="card callout ok fa-done">${icon("approvals")}<div><b>Created ${s.created.count} request${s.created.count === 1 ? "" : "s"}</b>
    <span class="muted small">${esc(Object.entries(s.created.by).map(([k, n]) => `${k}: ${n}`).join(" · "))}. The file is saved under Files.</span></div>
    <div class="btn-row"><button class="btn small" data-act="fa-close">Upload another file</button><a class="btn small primary" href="#/approvals">Review them now</a></div></div>` : ""}
  <div class="fa-layout">
    <section class="card fa-chat">
      <h3>${icon("sparkle")} Assistant</h3>
      <div class="fa-chat-log">${s.messages.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join("")}
        ${s.busy ? `<div class="msg assistant busy"><span class="spinner"></span> ${esc(s.step)}</div>` : ""}</div>
      <form class="fa-chat-form" data-form="fa-chat">
        <textarea name="text" rows="2" placeholder="e.g. Only include soft goods · Put everything in building 12 under The Terrace · Combine the lamp shades" ${s.busy ? "disabled" : ""}></textarea>
        <button class="btn primary" type="submit" ${s.busy ? "disabled" : ""}>Send</button>
      </form>
    </section>
    <section class="card fa-items">${s.busy && !s.items.length ? `<div class="busy"><span class="spinner"></span> ${esc(s.step)}</div>` : itemsHTML(s)}</section>
  </div>`}`;
}

export function pageFiles() {
  const s = FA.session;
  if (s) return sessionHTML(s);
  return `
  <div class="card fa-upload" data-tour="files-upload">
    <h3>${icon("import")} Upload a spreadsheet or PDF</h3>
    <p class="muted small">Punch lists, inspection reports, spec books, schedules… The file is saved with <b>${esc(CURRENT.project)}</b> so anyone can open it later,
      and the assistant reads it and proposes requests${AREAS.length ? ", each in the sub-project it belongs to" : ""}. Nothing is created until you confirm.</p>
    <div class="row2">
      ${AREAS.length ? `<label>Mostly about<select data-change="fa-default-sub">${opt("", "Several sub-projects (let the assistant sort it)")}${AREAS.map((a) => opt(a, a, FA.defaultSub === a)).join("")}</select></label>` : "<span></span>"}
      <label>How should it be organized? <span class="muted">(optional)</span>
        <input data-input="fa-instructions" value="${esc(FA.instructions)}" placeholder="e.g. Only items marked replace; skip paint touch-ups"></label>
    </div>
    <label class="drop">${icon("import", "ico lg")}<span>Choose a PDF, Excel or CSV file</span>
      <input type="file" accept=".pdf,.xlsx,.xls,.xlsm,.csv" data-change="fa-file"></label>
  </div>
  <div class="section-head"><h2 class="section">Files for ${esc(CURRENT.project)}</h2></div>
  <div class="card flush">${filesListHTML({ empty: "No files uploaded yet." })}</div>`;
}

/* ----------------------------------------------------------------- handlers */
const itemById = (id) => FA.session?.items.find((i) => i._id === id);

export const CLICK = {
  "fa-close"() {
    if (FA.session?.items.some((i) => i._include) && !FA.session.created && !confirm("Leave without creating these requests? The file stays saved under Files.")) return;
    Object.assign(FA, fresh());
    hooks.render();
  },
  "fa-create"() { createRequests(); },
  "doc-view"(el) { viewDoc(el.dataset.id); },
  async "doc-delete"(el) {
    const d = S.docs.find((x) => x.id === el.dataset.id);
    if (!confirm(`Delete ${d.name}? Requests created from it stay.`)) return;
    const ok = await guard(async () => { await store.deleteDocument(d); return true; }, "File deleted");
    if (ok) { S.docs = S.docs.filter((x) => x.id !== d.id); hooks.render(); }
  },
  "upload-here"(el) { FA.defaultSub = el.dataset.sub || ""; location.hash = "#/files"; },
};

export const CHANGE = {
  "fa-file"(el) { const f = el.files[0]; el.value = ""; if (f) startSession(f); },
  "fa-default-sub"(el) { FA.defaultSub = el.value; },
  "fa-include"(el) { const i = itemById(el.dataset.id); if (i) { i._include = el.checked; hooks.render(); } },
  "fa-sub"(el) { const i = itemById(el.dataset.id); if (i) { i.sub_project = el.value; hooks.render(); } },
  "fa-field"(el) { const i = itemById(el.dataset.id); if (i) i[el.dataset.field] = el.value; },
};

export const INPUT = {
  "fa-instructions"(el) { FA.instructions = el.value; },
};

export const SUBMIT = {
  "fa-chat"(form) {
    const text = form.querySelector("textarea").value.trim();
    if (text) chat(text);
  },
};

export const pages = { files: pageFiles };
