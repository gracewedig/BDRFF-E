// Rule-based reader that pulls request details out of an email. The intake
// function prefers the AI assistant and uses this when no API key is set; Demo
// mode always uses it.
import { PRIORITIES, matchLocation, todayISO } from "./fields.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LIST = String.raw`[\w-]+(?:\s*(?:,|&|and|\/)\s*[\w-]*\d[\w-]*)*`; // later items need a number ("89, 90", not "89, room")

function iso(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return isNaN(dt) || dt.getUTCMonth() !== m - 1 ? "" : dt.toISOString().slice(0, 10);
}

function findDate(text, today) {
  const year = Number(today.slice(0, 4));
  const roll = (d) => (d && d < today ? iso(year + 1, Number(d.slice(5, 7)), Number(d.slice(8, 10))) : d);
  let m = text.match(/\b(?:by|before|due|needed by|need(?:ed)? it by|no later than)\s*:?\s*(\d{4})-(\d{2})-(\d{2})/i);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = text.match(/\b(?:by|before|due|needed by|no later than)\s*:?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year;
    const d = iso(y, +m[1], +m[2]);
    return m[3] ? d : roll(d);
  }
  m = text.match(/\b(?:by|before|due|needed by|no later than)\s*:?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i);
  if (m) return roll(iso(year, MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]));
  return "";
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

// Drop quoted replies and signatures so old thread text isn't re-read.
export function stripQuoted(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(On .+wrote:|-{2,}\s*Original Message|From:\s.+|Sent from my )/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// `hint`: the project to assume when the email only names a sub-project ambiguously.
export function parseEmailHeuristic({ subject = "", text = "", hint = "" }, today = todayISO()) {
  const body = stripQuoted(text);
  const all = `${subject}\n${body}`;
  const subj = clean(subject.replace(/^((re|fw|fwd)\s*:\s*)+/i, ""));
  const pick = (re) => clean(all.match(re)?.[1] || "");

  const tag = pick(/\b(FFE-[A-Z0-9-]+)/i)
    || pick(/\b(?:ff&?e|ffe)\s*(?:tag|#|number|no\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/i)
    || pick(/\btag\s*(?:#|number|no\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)/i);
  const qty = Number(pick(/\b(?:qty|quantity)\s*[:#]?\s*(\d+)/i)) || Number(pick(/\b(\d{1,3})\s*(?:x\s+|pcs\b|pieces\b|each\b)/i)) || 1;
  const low = all.toLowerCase();
  const priority = /\b(urgent|asap|emergency|immediately|right away)\b/.test(low) ? "Urgent"
    : /\bhigh priority\b|\bpriority:\s*high\b/.test(low) ? "High"
    : /\blow priority\b/.test(low) ? "Low" : "Normal";

  const firstSentence = clean(body.split(/\n\s*\n|(?<=[.!?])\s/)[0] || "").replace(/^(hi|hello|hey|good (morning|afternoon))[^,]*,\s*/i, "");
  const item = subj && !/^(request|ffe|ff&e|help|question|hi|hello)$/i.test(subj) ? subj : firstSentence;
  const hasSignal = /\b(need|needs|replace|repair|fix|broke|broken|damaged?|missing|order|request|stain|torn|rip|ripped|crack|leak|install|would like|we'd like|urgent)/i.test(all);
  const { project, sub_project } = matchLocation(all, hint);
  // "Building: Cabana row." keeps the whole label; "bldg 89 and 90" keeps the list.
  const labelled = (word) => pick(new RegExp(String.raw`\b(?:${word})[ \t]*:[ \t]*([^\n.;]{1,60})`, "i"));
  const rooms = labelled("rooms?|rm|units?|suites?")
    || pick(new RegExp(String.raw`\b(?:rooms?|rm|units?|suites?)\.?[ \t]*#?[ \t]*(${LIST})`, "i"))
    || pick(/\b(cabanas?\s*#?\s*\d[\w-]*)/i);
  const buildings = labelled("buildings?|bldgs?")
    || pick(new RegExp(String.raw`\b(?:buildings?|bldgs?)\.?[ \t]*#?[ \t]*(${LIST})`, "i"));

  return {
    project,
    sub_project,
    buildings: buildings.replace(/\s+(and|&)\s+/gi, ", "),
    rooms: rooms.replace(/\s+(and|&)\s+/gi, ", "),
    item_needed: item.slice(0, 300),
    ffe_tag: tag.toUpperCase(),
    spec: "",
    quantity: qty,
    priority: PRIORITIES.includes(priority) ? priority : "Normal",
    needed_by: findDate(all, today),
    details: body.slice(0, 4000),
    photo_kind: /damag|broken|crack|stain|torn|\brip|leak|missing|scratch|chip/i.test(all) ? "damage" : "concept",
    is_request: hasSignal || !!(sub_project && (rooms || tag)),
    summary: "Read with the built-in email reader.",
  };
}
