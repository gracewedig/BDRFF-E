// Spreadsheet export (Excel via SheetJS, CSV fallback).
import { FIELDS } from "./fields.js";

const ACTION_COLUMNS = [
  { key: "title", label: "Action Item" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "due_date", label: "Due Date" },
  { key: "linked_ticket", label: "Linked Ticket" },
  { key: "category", label: "Category" },
  { key: "notes", label: "Notes" },
  { key: "updated_at", label: "Last Updated" },
];

function toObjects(columns, rows) {
  return rows.map((r) => Object.fromEntries(columns.map((c) => [c.label, r[c.key] ?? ""])));
}

function sheetName(name, used) {
  let base = String(name).replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let out = base, i = 2;
  while (used.has(out.toLowerCase())) out = `${base.slice(0, 28)} ${i++}`;
  used.add(out.toLowerCase());
  return out;
}

export function requestsTab(name, rows) {
  return { name, columns: FIELDS, rows };
}

export function viewTab(name, view) {
  const { spec, rows, columns } = view;
  const cols = spec.group_by !== "none" && !spec.columns.includes(spec.group_by)
    ? [FIELDS.find((f) => f.key === spec.group_by), ...columns]
    : columns;
  return { name, columns: cols, rows };
}

export function actionsTab(name, actions) {
  const rows = actions.map((a) => ({ ...a, updated_at: (a.updated_at || "").slice(0, 10), due_date: a.due_date || "" }));
  return { name, columns: ACTION_COLUMNS, rows };
}

export function downloadWorkbook(filename, tabs) {
  if (!window.XLSX) {
    // Spreadsheet library didn't load; fall back to one CSV per tab.
    tabs.forEach((t) => downloadCsv(`${filename} - ${t.name}`, t.columns, t.rows));
    return;
  }
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const used = new Set();
  for (const t of tabs) {
    const objs = toObjects(t.columns, t.rows);
    const ws = XLSX.utils.json_to_sheet(objs, { header: t.columns.map((c) => c.label) });
    ws["!cols"] = t.columns.map((c) => ({
      wch: Math.min(48, Math.max(c.label.length, ...objs.map((o) => String(o[c.label]).length)) + 2),
    }));
    ws["!autofilter"] = { ref: ws["!ref"] || "A1" };
    XLSX.utils.book_append_sheet(wb, ws, sheetName(t.name, used));
  }
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

export function downloadCsv(filename, columns, rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(","))];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
