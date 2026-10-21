// Duplicate detection between requests (app tickets, email requests, imported rows).
// Shared by the browser and the email-intake function.

const STOP = new Set(
  ("the and for with from this that are was were has have need needs needed please thanks thank you can could would "
  + "replace replaced replacement new item items room rooms building bldg unit units fix fixed repair repaired broken "
  + "damaged request requesting asap hello team get got also our its it's will just").split(" "),
);

function words(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/ies$/, "y").replace(/([^s])s$/, "$1")));
}

function places(s) {
  return new Set(String(s || "").toLowerCase().split(/[\s,&/;+]+|\band\b/)
    .map((t) => t.replace(/^(room|rm|bldg|building|unit|suite|#)+/, "").replace(/[^a-z0-9-]/g, ""))
    .filter((t) => t && !["n", "na", "tbd", "the"].includes(t)));
}

const normTag = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const overlap = (a, b) => [...a].some((x) => b.has(x));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

export const DUP_THRESHOLD = 0.6;
export const POSSIBLE_THRESHOLD = 0.4;

// Score 0–1 for how likely two requests describe the same need.
export function similarity(a, b) {
  if (a.project && b.project && a.project !== b.project) return { score: 0, reasons: [] };
  let score = 0;
  const reasons = [];
  if (a.project && a.project === b.project) score += 0.1;
  const ta = normTag(a.ffe_tag);
  if (ta.length >= 3 && ta === normTag(b.ffe_tag)) { score += 0.5; reasons.push("same FF&E tag"); }
  if (overlap(places(a.rooms), places(b.rooms))) { score += 0.25; reasons.push("same room"); }
  if (overlap(places(a.buildings), places(b.buildings))) { score += 0.1; reasons.push("same building"); }
  const j = jaccard(words(`${a.item_needed} ${a.spec || ""}`), words(`${b.item_needed} ${b.spec || ""}`));
  if (j > 0) {
    score += 0.35 * Math.min(1, j * 1.5);
    if (j >= 0.25) reasons.push("similar description");
  }
  if (a.needed_by && b.needed_by && Math.abs(Date.parse(a.needed_by) - Date.parse(b.needed_by)) <= 14 * 864e5) score += 0.05;
  return { score: Math.min(1, Math.round(score * 100) / 100), reasons };
}

// Best matches for `candidate` within `pool`, highest score first.
export function findMatches(candidate, pool, limit = 5, min = 0.25) {
  return pool
    .map((item) => ({ item, ...similarity(candidate, item) }))
    .filter((m) => m.score >= min)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}
