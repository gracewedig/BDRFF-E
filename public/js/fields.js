// Shared definitions for the FF&E tracker. Also imported by the Netlify AI function,
// so keep this file free of browser-only APIs.

export const PROJECTS = ["The Terrace", "The Cove", "Resort Center", "Pickleball", "Waterpark"];
export const STATUSES = ["Pending", "Approved", "In Progress", "Completed", "Rejected", "Cancelled"];
export const OPEN_STATUSES = ["Pending", "Approved", "In Progress"];
export const CLOSED_STATUSES = ["Completed", "Rejected", "Cancelled"];
export const PRIORITIES = ["Low", "Normal", "High", "Urgent"];
export const ACTION_STATUSES = ["Not Started", "In Progress", "Waiting", "Done"];
export const PHOTO_KINDS = { concept: "Concept image", damage: "Proof of damage" };

// Columns available in the overall spreadsheet and in custom views.
export const FIELDS = [
  { key: "ticket", label: "Ticket #", type: "text" },
  { key: "project", label: "Project", type: "enum", options: PROJECTS },
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
  "ticket", "project", "buildings", "rooms", "item_needed", "ffe_tag", "needed_by", "priority", "status", "requester_name",
];

export function ticketLabel(n) {
  return n == null ? "" : `BDR-${String(n).padStart(4, "0")}`;
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
  };
}

export function isOverdue(row, today = todayISO()) {
  return !!row.needed_by && row.needed_by < today && !CLOSED_STATUSES.includes(row.status);
}
