// Email intake. Receives emails (from a forwarding service, a Power Automate /
// Zapier flow, or the app's "Paste an email" box), reads them into request
// fields, checks for duplicates, and files them under Email Requests.
//
// Needs in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INBOUND_EMAIL_SECRET.
// ANTHROPIC_API_KEY is optional; without it the built-in reader is used.
import Anthropic from "@anthropic-ai/sdk";
import { adminClient, callerProfile, json } from "../lib/server.mjs";
import { PROJECTS, PRIORITIES, todayISO } from "../../public/js/fields.js";
import { parseEmailHeuristic, htmlToText, stripQuoted } from "../../public/js/emailparse.js";
import { findMatches, DUP_THRESHOLD } from "../../public/js/dedupe.js";

const BUCKET = "ffe-photos";
const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_request", "project", "buildings", "rooms", "item_needed", "ffe_tag", "spec", "quantity", "priority",
    "needed_by", "details", "photo_kind", "summary", "duplicate_of", "duplicate_reason"],
  properties: {
    is_request: { type: "boolean", description: "True if this email asks for FF&E to be fixed, replaced, ordered or installed" },
    project: { type: "string", enum: [...PROJECTS, "Unknown"] },
    buildings: { type: "string" },
    rooms: { type: "string" },
    item_needed: { type: "string", description: "Short description of what is needed, like a ticket title" },
    ffe_tag: { type: "string" },
    spec: { type: "string" },
    quantity: { type: "integer" },
    priority: { type: "string", enum: PRIORITIES },
    needed_by: { type: "string", description: "YYYY-MM-DD, or empty if not stated" },
    details: { type: "string", description: "Any other useful detail from the email, without greetings or signatures" },
    photo_kind: { type: "string", enum: ["damage", "concept"] },
    summary: { type: "string", description: "One short sentence for the reviewing manager" },
    duplicate_of: { type: "string", description: "The id of the candidate that describes the same need, or \"none\"" },
    duplicate_reason: { type: "string" },
  },
};

const SYSTEM = `You read emails sent to the Black Desert Resort FF&E (furniture, fixtures & equipment) team and turn them into request tickets.
Projects: ${PROJECTS.join(", ")}. Use "Unknown" if the email doesn't say.
Fill only what the email states or clearly implies; leave text fields empty when unknown. Quantity defaults to 1.
Resolve relative dates against today's date. Ignore quoted earlier messages and signatures.
photo_kind is "damage" when attachments would show damage or a problem, otherwise "concept".
You will also get candidate existing requests. Set duplicate_of to a candidate's id only if it is clearly the same need
(same place and same item/problem), otherwise "none". A follow-up asking about an existing request is a duplicate.`;

// Normalizes the payloads sent by Postmark, SendGrid Inbound Parse, Mailgun, and
// simple JSON from Power Automate / Zapier / Make / the app.
async function readEmail(req) {
  const type = req.headers.get("content-type") || "";
  const out = { attachments: [] };
  if (type.includes("application/json")) {
    const b = await req.json();
    out.from_email = b.from_email || b.FromFull?.Email || b.From || b.from || b.sender || "";
    out.from_name = b.from_name || b.FromFull?.Name || b.FromName || "";
    out.subject = b.subject || b.Subject || "";
    out.text = b.text || b.body || b.TextBody || b["body-plain"] || "";
    out.html = b.html || b.HtmlBody || b["body-html"] || "";
    out.message_id = b.message_id || b.MessageID || b["Message-Id"] || "";
    for (const a of b.attachments || b.Attachments || []) {
      const content = a.content || a.Content || a.contentBytes || a.ContentBytes;
      if (!content) continue;
      out.attachments.push({
        name: a.name || a.Name || a.filename || "photo",
        type: a.content_type || a.contentType || a.ContentType || "application/octet-stream",
        bytes: Buffer.from(String(content), "base64"),
      });
    }
  } else {
    const f = await req.formData();
    out.from_email = String(f.get("from") || f.get("sender") || "");
    out.subject = String(f.get("subject") || "");
    out.text = String(f.get("text") || f.get("body-plain") || "");
    out.html = String(f.get("html") || f.get("body-html") || "");
    out.message_id = String(f.get("Message-Id") || f.get("message-id") || "");
    for (const [, v] of f.entries()) {
      if (typeof v === "object" && v && "arrayBuffer" in v) {
        out.attachments.push({ name: v.name || "photo", type: v.type, bytes: Buffer.from(await v.arrayBuffer()) });
      }
    }
  }
  // "Jane Doe <jane@x.com>"
  const m = String(out.from_email).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) { out.from_name = out.from_name || m[1].trim(); out.from_email = m[2].trim(); }
  out.from_email = String(out.from_email).trim().toLowerCase();
  if (!out.text && out.html) out.text = htmlToText(out.html);
  return out;
}

async function extractWithAI(email, candidates, today) {
  const client = new Anthropic();
  const content = [
    `Today is ${today}.`,
    `From: ${email.from_name} <${email.from_email}>`,
    `Subject: ${email.subject}`,
    `Attachments: ${email.attachments.length} image(s)`,
    `Body:\n${stripQuoted(email.text).slice(0, 12000)}`,
    `Candidate existing requests (JSON):\n${JSON.stringify(candidates.map(({ item, score }) => ({
      id: item.id, project: item.project, buildings: item.buildings, rooms: item.rooms, item_needed: item.item_needed,
      ffe_tag: item.ffe_tag, status: item.status, match_hint: score,
    })))}`,
  ].join("\n\n");
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("refused");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("empty");
  const r = JSON.parse(text);
  if (r.project === "Unknown") r.project = "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.needed_by)) r.needed_by = "";
  r.quantity = Math.max(1, r.quantity || 1);
  return r;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const admin = adminClient();
  if (!admin) return json({ error: "Email intake isn't set up yet (SUPABASE_SERVICE_ROLE_KEY missing in Netlify)" }, 503);

  // Either a mail service presenting the shared secret, or a signed-in staff member pasting an email.
  const url = new URL(req.url);
  const secret = process.env.INBOUND_EMAIL_SECRET;
  const presented = url.searchParams.get("key") || req.headers.get("x-inbound-secret");
  let createdBy = null;
  if (!(secret && presented && presented === secret)) {
    const caller = await callerProfile(admin, req);
    if (!caller) return json({ error: "Not authorized" }, 401);
    createdBy = caller.id;
  }

  let email;
  try { email = await readEmail(req); } catch { return json({ error: "Couldn't read that email" }, 400); }
  if (!email.text && !email.subject) return json({ error: "The email is empty" }, 400);

  if (email.message_id) {
    const { data: seen } = await admin.from("email_requests").select("id, status").eq("message_id", email.message_id).maybeSingle();
    if (seen) return json({ ok: true, already_received: true, email_request: seen });
  }

  const today = todayISO();
  const since = new Date(Date.now() - 180 * 864e5).toISOString();
  const [{ data: requests }, { data: emails }] = await Promise.all([
    admin.from("requests").select("id, ticket_no, project, buildings, rooms, item_needed, ffe_tag, spec, needed_by, status")
      .not("status", "in", "(Rejected,Cancelled)").gte("created_at", since),
    admin.from("email_requests").select("id, project, buildings, rooms, item_needed, ffe_tag, spec, needed_by, status, from_email, subject")
      .eq("status", "New").gte("received_at", since),
  ]);

  // Read the email: AI when configured, otherwise the built-in rules.
  const rough = parseEmailHeuristic({ subject: email.subject, text: email.text }, today);
  const candidates = findMatches(rough, requests || [], 8, 0.15);
  let fields = rough;
  let aiDuplicate = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const ai = await extractWithAI(email, candidates, today);
      fields = { ...ai, details: ai.details || rough.details };
      aiDuplicate = ai.duplicate_of && ai.duplicate_of !== "none" ? { id: ai.duplicate_of, reason: ai.duplicate_reason } : null;
    } catch (err) {
      console.error("AI email reading failed, using built-in reader:", err.message);
    }
  }

  // Decide whether this is new, a duplicate of a ticket, or a repeat of an earlier email.
  const record = {
    message_id: email.message_id || null, from_email: email.from_email, from_name: email.from_name, subject: email.subject,
    body: stripQuoted(email.text).slice(0, 20000), project: fields.project || null, buildings: fields.buildings || null,
    rooms: fields.rooms || null, item_needed: fields.item_needed || null, ffe_tag: fields.ffe_tag || null, spec: fields.spec || null,
    quantity: fields.quantity || 1, priority: fields.priority || "Normal", needed_by: fields.needed_by || null,
    details: fields.details || null, ai_summary: fields.summary || null, created_by: createdBy, status: "New",
  };
  const [best] = findMatches(fields, requests || [], 1);
  const aiPick = aiDuplicate && (requests || []).find((r) => r.id === aiDuplicate.id);
  if (fields.is_request === false) {
    Object.assign(record, { status: "Dismissed", duplicate_reason: "Doesn't look like an FF&E request" });
  } else if (aiPick) {
    const score = findMatches(fields, [aiPick], 1, 0)[0]?.score ?? null;
    Object.assign(record, { status: "Duplicate", duplicate_of: aiPick.id, match_score: score, duplicate_reason: aiDuplicate.reason || "Same request as an existing ticket" });
  } else if (best && best.score >= DUP_THRESHOLD) {
    Object.assign(record, { status: "Duplicate", duplicate_of: best.item.id, match_score: best.score, duplicate_reason: `Matches an existing ticket: ${best.reasons.join(", ")}` });
  } else {
    const [prior] = findMatches(fields, emails || [], 1);
    if (prior && prior.score >= DUP_THRESHOLD) {
      Object.assign(record, { status: "Duplicate", duplicate_of_email: prior.item.id, match_score: prior.score, duplicate_reason: `Same as an earlier email: ${prior.reasons.join(", ")}` });
    }
  }

  const { data: saved, error } = await admin.from("email_requests").insert(record).select().single();
  if (error) {
    console.error(error);
    return json({ error: "Couldn't save the email" }, 500);
  }

  // Keep image attachments as ticket photos.
  const photos = [];
  for (const a of email.attachments.filter((x) => /^image\//.test(x.type) && x.bytes.length <= MAX_PHOTO_BYTES).slice(0, MAX_PHOTOS)) {
    const path = `email/${saved.id}/${photos.length + 1}-${a.name.replace(/[^\w.-]+/g, "_").slice(-60)}`;
    const { error: upErr } = await admin.storage.from(BUCKET).upload(path, a.bytes, { contentType: a.type, upsert: true });
    if (!upErr) photos.push({ path, name: a.name, kind: fields.photo_kind || "damage" });
  }
  let result = saved;
  if (photos.length) {
    const { data } = await admin.from("email_requests").update({ attachments: photos }).eq("id", saved.id).select().single();
    result = data || saved;
  }
  return json({ ok: true, email_request: result });
};
