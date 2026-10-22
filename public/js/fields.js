// Shared definitions for the FF&E tracker. Also imported by the Netlify AI function,
// so keep this file free of browser-only APIs.

// Projects (resorts) each have sub-projects (areas). Managers edit both, plus the
// option lists, in the app; they're stored in the database. These are the
// starting values.
export const DEFAULT_SETTINGS = {
  projects: [
    { name: "Black Desert Resort", aliases: ["BDR"], subprojects: ["The Terrace", "The Cove", "Resort Center", "Pickleball", "Waterpark"] },
    { name: "Cornerstone", aliases: [], subprojects: [] },
    { name: "Sweetens Cove", aliases: [], subprojects: [] },
    { name: "Marcella", aliases: [], subprojects: [] },
  ],
  options: {
    categories: ["Seating", "Tables", "Case Goods", "Lighting", "Textiles", "Outdoor", "Bath", "Hardware", "Decor", "Equipment"],
    locations: [],
    units: ["ea", "set", "pair", "box", "yd"],
  },
};
export const OPTION_LISTS = {
  categories: "Item categories",
  locations: "Storage locations",
  units: "Units",
};

// Live lists, updated in place so every module that imported them sees changes:
// PROJECTS = active projects; AREAS = sub-projects of the project being worked on.
export const PROJECTS = DEFAULT_SETTINGS.projects.map((p) => p.name);
export const AREAS = [];
export const CURRENT = { project: "" };
export const SETTINGS = structuredClone(DEFAULT_SETTINGS);

export function applySettings(next) {
  const s = next && Array.isArray(next.projects) && next.projects.length ? next : DEFAULT_SETTINGS;
  SETTINGS.projects = s.projects.map((p) => ({ subprojects: [], aliases: [], archived: false, ...p }));
  SETTINGS.options = { ...DEFAULT_SETTINGS.options, ...(s.options || {}) };
  PROJECTS.length = 0;
  PROJECTS.push(...SETTINGS.projects.filter((p) => !p.archived).map((p) => p.name));
  setCurrentProject(CURRENT.project);
}

export function setCurrentProject(name) {
  CURRENT.project = name || "";
  AREAS.length = 0;
  AREAS.push(...subProjects(CURRENT.project));
}

export const projectDef = (name) => SETTINGS.projects.find((p) => p.name === name);
export const subProjects = (project) => projectDef(project)?.subprojects || [];
export const STATUSES = ["Pending", "Approved", "In Progress", "Completed", "Rejected", "Cancelled"];
export const OPEN_STATUSES = ["Pending", "Approved", "In Progress"];
export const CLOSED_STATUSES = ["Completed", "Rejected", "Cancelled"];
export const PRIORITIES = ["Low", "Normal", "High", "Urgent"];
export const ACTION_STATUSES = ["Not Started", "In Progress", "Waiting", "Done"];
export const PHOTO_KINDS = { concept: "Concept image", damage: "Proof of damage" };
export const STOCK_TYPES = ["Attic Stock", "Inventory"];
export const SOURCES = { app: "App", email: "Email", import: "Spreadsheet", document: "Document" };

// How a name tends to be written in emails and spreadsheets: "The Cove" also
// matches "cove", "Waterpark" also matches "water park".
function namePattern(name) {
  const words = String(name).replace(/^the\s+/i, "").trim().split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/(center|centre)$/i, "cent(er|re)"));
  return words.join("\\s*").replace(/^(water|pickle)(park|ball)$/i, "$1\\s*$2");
}

const nameRe = (names) => new RegExp(`\\b(?:${names.filter(Boolean).map(namePattern).join("|")})\\b`, "i");
export const projectPattern = (name) => nameRe([name, ...(projectDef(name)?.aliases || [])]);
export const subProjectPattern = (name) => nameRe([name]);

// The sub-project of `project` (default: the current one) named in a piece of
// text, or "" when it names none or several.
export function matchSubProject(text, project = CURRENT.project) {
  const s = String(text ?? "");
  const hits = subProjects(project).filter((sp) => subProjectPattern(sp).test(s));
  return hits.length === 1 ? hits[0] : "";
}

// Works out project and sub-project from free text (emails, spreadsheets),
// preferring `hint` when the text could fit more than one project.
export function matchLocation(text, hint = "") {
  const s = String(text ?? "");
  const named = PROJECTS.filter((p) => projectPattern(p).test(s));
  let project = named.length === 1 ? named[0] : "";
  const pool = project ? [project] : hint ? [hint, ...PROJECTS.filter((p) => p !== hint)] : PROJECTS;
  for (const p of pool) {
    const sub = matchSubProject(s, p);
    if (sub) return { project: project || p, sub_project: sub };
  }
  return { project: project || hint || "", sub_project: "" };
}

// Columns available in the overall spreadsheet and in custom views.
export const FIELDS = [
  { key: "ticket", label: "Ticket #", type: "text" },
  { key: "sub_project", label: "Sub-project", type: "enum", options: AREAS },
  { key: "buildings", label: "Building(s)", type: "text" },
  { key: "rooms", label: "Room(s)", type: "text" },
  { key: "item_needed", label: "What's Needed", type: "text" },
  { key: "ffe_tag", label: "FF&E Tag", type: "text" },
  { key: "spec", label: "Specification", type: "text" },
  { key: "quantity", label: "Qty", type: "number" },
  { key: "priority", label: "Priority", type: "enum", options: PRIORITIES },
  { key: "needed_by", label: "Needed By", type: "date" },
  { key: "days_until_due", label: "Days Until Due", type: "number" },
  { key: "status", label: "Status", type: "enum", options: STATUSES },
  { key: "details", label: "Additional Details", type: "text" },
  { key: "requester_name", label: "Requested By", type: "text" },
  { key: "created_at", label: "Submitted", type: "date" },
  { key: "reviewer_name", label: "Reviewed By", type: "text" },
  { key: "review_note", label: "Review Note", type: "text" },
  { key: "reviewed_at", label: "Reviewed On", type: "date" },
  { key: "concept_photos", label: "Concept Photos", type: "number" },
  { key: "damage_photos", label: "Damage Photos", type: "number" },
  { key: "source", label: "Source", type: "enum", options: Object.values(SOURCES) },
  { key: "notes", label: "Notes", type: "text" },
  { key: "follow_up_on", label: "Follow-up Date", type: "date" },
];
export const FIELD_KEYS = FIELDS.map((f) => f.key);
export const FIELD_MAP = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// Filter operators understood by applyView() and the AI assistant.
export const OPS = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  in: "is any of",
  not_in: "is none of",
  before: "is before",
  after: "is after",
  on_or_before: "is on or before",
  on_or_after: "is on or after",
  greater_than: "is greater than",
  less_than: "is less than",
  due_within_days: "due within (days)",
  overdue: "is overdue",
  is_empty: "is empty",
  not_empty: "is not empty",
  is_me: "is me",
};
export const OP_KEYS = Object.keys(OPS);
export const VALUELESS_OPS = ["overdue", "is_empty", "not_empty", "is_me"];

export const DEFAULT_COLUMNS = [
  "ticket", "sub_project", "buildings", "rooms", "item_needed", "ffe_tag", "needed_by", "priority", "status", "requester_name",
];

export function ticketLabel(n) {
  return n == null ? "" : `REQ-${String(n).padStart(4, "0")}`;
}

export function todayISO(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function addDaysISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDiff(fromISO, toISO) {
  return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / 86400000);
}

// Flatten a stored request into a spreadsheet row keyed by FIELDS.
export function toRow(r, today = todayISO()) {
  const photos = Array.isArray(r.photos) ? r.photos : [];
  const neededBy = (r.needed_by || "").slice(0, 10);
  return {
    _raw: r,
    ticket: ticketLabel(r.ticket_no),
    project: r.project || "",
    sub_project: r.sub_project || "",
    buildings: r.buildings || "",
    rooms: r.rooms || "",
    item_needed: r.item_needed || "",
    ffe_tag: r.ffe_tag || "",
    spec: r.spec || "",
    quantity: r.quantity ?? 1,
    priority: r.priority || "Normal",
    needed_by: neededBy,
    days_until_due: neededBy ? dayDiff(today, neededBy) : "",
    status: r.status || "Pending",
    details: r.details || "",
    requester_name: r.requester_name || "",
    created_at: (r.created_at || "").slice(0, 10),
    reviewer_name: r.reviewer_name || "",
    review_note: r.review_note || "",
    reviewed_at: (r.reviewed_at || "").slice(0, 10),
    concept_photos: photos.filter((p) => p.kind === "concept").length,
    damage_photos: photos.filter((p) => p.kind === "damage").length,
    source: SOURCES[r.source] || SOURCES.app,
    notes: r.notes || "",
    follow_up_on: (r.follow_up_on || "").slice(0, 10),
  };
}

export function isOverdue(row, today = todayISO()) {
  return !!row.needed_by && row.needed_by < today && !CLOSED_STATUSES.includes(row.status);
}
