// Custom spreadsheet views: a "spec" describes columns, filters, sort and grouping
// over the overall request list. Specs come from the AI assistant, the offline
// builder below, or manual edits in the Sheet Builder.
import {
  FIELDS, FIELD_KEYS, FIELD_MAP, OP_KEYS, VALUELESS_OPS, DEFAULT_COLUMNS, PROJECTS, STATUSES,
  OPEN_STATUSES, PRIORITIES, toRow, todayISO, addDaysISO, isOverdue,
} from "./fields.js";

export function defaultSpec() {
  return {
    name: "All requests",
    columns: [...DEFAULT_COLUMNS],
    filters: [],
    sort_field: "needed_by",
    sort_dir: "asc",
    group_by: "none",
    explanation: "",
  };
}

// Drop anything unknown so a bad spec can never break the page.
export function sanitizeSpec(spec) {
  const base = defaultSpec();
  if (!spec || typeof spec !== "object") return base;
  const columns = (Array.isArray(spec.columns) ? spec.columns : []).filter((c) => FIELD_KEYS.includes(c));
  const filters = (Array.isArray(spec.filters) ? spec.filters : [])
    .filter((f) => f && OP_KEYS.includes(f.op) && (f.op === "overdue" || FIELD_KEYS.includes(f.field)))
    .map((f) => ({ field: f.field || "needed_by", op: f.op, value: String(f.value ?? "") }));
  return {
    name: String(spec.name || base.name).slice(0, 80),
    columns: columns.length ? [...new Set(columns)] : base.columns,
    filters,
    sort_field: FIELD_KEYS.includes(spec.sort_field) ? spec.sort_field : base.sort_field,
    sort_dir: spec.sort_dir === "desc" ? "desc" : "asc",
    group_by: FIELD_KEYS.includes(spec.group_by) ? spec.group_by : "none",
    explanation: String(spec.explanation || ""),
  };
}

const norm = (v) => String(v ?? "").trim().toLowerCase();
const list = (v) => String(v ?? "").split(",").map(norm).filter(Boolean);

function matches(row, f, me, today) {
  const v = row[f.field];
  const field = FIELD_MAP[f.field];
  switch (f.op) {
    case "equals": return norm(v) === norm(f.value);
    case "not_equals": return norm(v) !== norm(f.value);
    case "contains": return norm(v).includes(norm(f.value));
    case "in": return list(f.value).includes(norm(v));
    case "not_in": return !list(f.value).includes(norm(v));
    case "before": return !!v && v < f.value;
    case "after": return !!v && v > f.value;
    case "on_or_before": return !!v && v <= f.value;
    case "on_or_after": return !!v && v >= f.value;
    case "greater_than": return v !== "" && Number(v) > Number(f.value);
    case "less_than": return v !== "" && Number(v) < Number(f.value);
    case "due_within_days": {
      const n = Number(f.value) || 0;
      return !!row.needed_by && row.needed_by >= today && row.needed_by <= addDaysISO(today, n);
    }
    case "overdue": return isOverdue(row, today);
    case "is_empty": return v === "" || v == null || (field?.type === "number" && Number(v) === 0);
    case "not_empty": return !(v === "" || v == null || (field?.type === "number" && Number(v) === 0));
    case "is_me": return row._raw.requested_by === me?.id;
    default: return true;
  }
}

function compare(a, b, type) {
  if (type === "number") return (a === "" ? Infinity : Number(a)) - (b === "" ? Infinity : Number(b));
  if (a === "" && b !== "") return 1;
  if (b === "" && a !== "") return -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

const ORDER = {
  priority: ["Urgent", "High", "Normal", "Low"],
  status: STATUSES,
  project: PROJECTS,
};

export function applyView(rawSpec, requests, me) {
  const spec = sanitizeSpec(rawSpec);
  const today = todayISO();
  let rows = requests.map((r) => toRow(r, today));
  rows = rows.filter((row) => spec.filters.every((f) => matches(row, f, me, today)));
  const dir = spec.sort_dir === "desc" ? -1 : 1;
  const cmp = (key, a, b) => {
    if (ORDER[key]) return ORDER[key].indexOf(a[key]) - ORDER[key].indexOf(b[key]);
    return compare(a[key], b[key], FIELD_MAP[key]?.type);
  };
  rows.sort((a, b) => {
    if (spec.group_by !== "none") {
      const g = cmp(spec.group_by, a, b);
      if (g) return g;
    }
    return dir * cmp(spec.sort_field, a, b);
  });
  return { spec, rows, columns: spec.columns.map((k) => FIELD_MAP[k]) };
}

// Offline builder: turns plain English into a spec with keyword rules. Used when the
// AI function is not configured or unreachable.
export function localSpecFromPrompt(prompt) {
  const p = " " + norm(prompt) + " ";
  const spec = defaultSpec();
  spec.name = prompt.trim().replace(/^(show|give|list|build|make|create)( me)?\s+/i, "").slice(0, 60) || "Custom view";
  spec.name = spec.name.charAt(0).toUpperCase() + spec.name.slice(1);
  const filters = [];
  const notes = [];

  const projectWords = {
    "The Terrace": /terrace/, "The Cove": /\bcove\b/, "Resort Center": /resort cent(er|re)/,
    "Pickleball": /pickle\s?ball/, "Waterpark": /water\s?park/,
  };
  const projects = PROJECTS.filter((x) => projectWords[x].test(p));
  if (projects.length) { filters.push({ field: "project", op: "in", value: projects.join(", ") }); notes.push(projects.join(" / ")); }

  const statusWords = {
    Pending: /pending|awaiting approval|needs? approval|unapproved/, Approved: /\bapproved\b/,
    "In Progress": /in progress|being worked/, Completed: /completed|\bdone\b|finished|closed/,
    Rejected: /rejected|denied/, Cancelled: /cancel/,
  };
  let statuses = STATUSES.filter((s) => statusWords[s].test(p));
  if (/\bopen\b|outstanding|active/.test(p)) statuses = [...new Set([...statuses, ...OPEN_STATUSES])];
  if (statuses.length) { filters.push({ field: "status", op: "in", value: statuses.join(", ") }); notes.push(statuses.join(" / ")); }

  const prios = PRIORITIES.filter((x) => new RegExp(`\\b${x.toLowerCase()}\\b`).test(p) && /priority|urgent/.test(p));
  if (/urgent/.test(p) && !prios.includes("Urgent")) prios.push("Urgent");
  if (prios.length) filters.push({ field: "priority", op: "in", value: prios.join(", ") });

  if (/overdue|past due|\blate\b|behind/.test(p)) { filters.push({ field: "needed_by", op: "overdue", value: "" }); notes.push("overdue"); }
  const days = p.match(/next (\d+) days?/);
  if (days) filters.push({ field: "needed_by", op: "due_within_days", value: days[1] });
  else if (/this week|next week|7 days/.test(p)) filters.push({ field: "needed_by", op: "due_within_days", value: "7" });
  else if (/this month|30 days/.test(p)) filters.push({ field: "needed_by", op: "due_within_days", value: "30" });

  if (/\b(my|mine|i submitted|i requested|i made)\b/.test(p)) filters.push({ field: "requester_name", op: "is_me", value: "" });
  if (/damage/.test(p)) { filters.push({ field: "damage_photos", op: "greater_than", value: "0" }); spec.columns.push("damage_photos"); }

  const bldg = p.match(/building[s]?\s*#?\s*([\w-]+)/);
  if (bldg) filters.push({ field: "buildings", op: "contains", value: bldg[1] });
  const room = p.match(/room[s]?\s*#?\s*([\w-]+)/);
  if (room && room[1] !== "number" && room[1] !== "numbers") filters.push({ field: "rooms", op: "contains", value: room[1] });
  const tag = p.match(/tag\s*#?\s*([a-z0-9-]*\d[a-z0-9-]*)/);
  if (tag) filters.push({ field: "ffe_tag", op: "contains", value: tag[1] });

  const by = p.match(/(?:group(?:ed)? by|by|per)\s+(project|status|building|priority|requester|person|room)/);
  if (by) {
    const key = { project: "project", status: "status", building: "buildings", priority: "priority", requester: "requester_name", person: "requester_name", room: "rooms" }[by[1]];
    spec.group_by = key;
  }
  if (/newest|most recent|latest|recently submitted/.test(p)) { spec.sort_field = "created_at"; spec.sort_dir = "desc"; }
  else if (/priority/.test(p) && !prios.length) { spec.sort_field = "priority"; }

  // Columns the user explicitly mentions.
  const colWords = {
    spec: /spec/, quantity: /\bqty\b|quantity/, details: /details|description/, review_note: /note|comment|reason/,
    reviewer_name: /reviewer|approved by|reviewed by/, created_at: /submitted|created/, days_until_due: /days (left|until|remaining)/,
    concept_photos: /concept/, reviewed_at: /reviewed on|approval date/,
  };
  for (const [k, re] of Object.entries(colWords)) if (re.test(p) && !spec.columns.includes(k)) spec.columns.push(k);
  const onlyMatch = p.match(/only (?:show )?(?:the )?([a-z ,&#']+?)(?: columns?)?\s*$/);
  if (onlyMatch) {
    const picked = FIELDS.filter((f) => onlyMatch[1].includes(f.label.toLowerCase().replace(/\(s\)/, "")) || onlyMatch[1].includes(f.key.replace(/_/g, " ")));
    if (picked.length) spec.columns = ["ticket", ...picked.map((f) => f.key).filter((k) => k !== "ticket")];
  }

  spec.filters = filters;
  spec.explanation = filters.length || spec.group_by !== "none"
    ? `Built with the offline builder${notes.length ? ": " + notes.join(", ") : ""}. Adjust anything below.`
    : "The offline builder didn't find specific filters, so this shows everything. Try naming a project, status, building, or date range.";
  return sanitizeSpec(spec);
}
