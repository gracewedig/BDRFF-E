// Outlook FF&E report: reads a batch of someone's recent emails (sent from their
// browser after they connect Outlook) and pulls out the FF&E requests coming up.
// Nothing is stored here; the browser builds and keeps the report.
// Needs ANTHROPIC_API_KEY, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Netlify.
import Anthropic from "@anthropic-ai/sdk";
import { PRIORITIES } from "../../public/js/fields.js";
import { isSignedIn, json } from "../lib/server.mjs";

const MAX_EMAILS = 60;
const MAX_CHARS = 3000;

function schema(projects) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["overview", "items"],
    properties: {
      overview: { type: "string", description: "2-4 sentences: what FF&E work is coming up, what is most urgent, anything unusual" },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "is_request", "project", "sub_project", "buildings", "rooms", "item_needed", "ffe_tag", "quantity", "priority", "needed_by", "summary"],
          properties: {
            id: { type: "string" },
            is_request: { type: "boolean", description: "True if the email asks for FF&E to be fixed, replaced, ordered, installed or moved" },
            project: { type: "string", enum: [...projects, "Unknown"] },
            sub_project: { type: "string" },
            buildings: { type: "string" },
            rooms: { type: "string" },
            item_needed: { type: "string", description: "Short ticket-style description" },
            ffe_tag: { type: "string" },
            quantity: { type: "integer" },
            priority: { type: "string", enum: PRIORITIES },
            needed_by: { type: "string", description: "YYYY-MM-DD or empty" },
            summary: { type: "string", description: "One sentence: who needs what, by when" },
          },
        },
      },
    },
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "AI reading isn't set up (ANTHROPIC_API_KEY missing)" }, 503);
  if (!(await isSignedIn(req))) return json({ error: "Please sign in" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const projects = (Array.isArray(body.projects) ? body.projects : []).slice(0, 50)
    .map((p) => ({ name: String(p?.name || "").slice(0, 80), subprojects: (p?.subprojects || []).map(String).slice(0, 50), aliases: (p?.aliases || []).map(String).slice(0, 20) }))
    .filter((p) => p.name);
  const emails = (Array.isArray(body.emails) ? body.emails : []).slice(0, MAX_EMAILS).map((e) => ({
    id: String(e.id || ""), from: String(e.from || "").slice(0, 200), received: String(e.received || "").slice(0, 40),
    subject: String(e.subject || "").slice(0, 300), text: String(e.text || "").slice(0, MAX_CHARS),
  })).filter((e) => e.id);
  if (!emails.length) return json({ overview: "No emails to read.", items: [] });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || "") ? body.today : new Date().toISOString().slice(0, 10);

  const system = `You review a staff member's recent emails for the Black Desert Resort FF&E (furniture, fixtures & equipment) team
and report which FF&E requests are coming up. Return one item per email id you were given.
Projects: ${projects.map((p) => `${p.name}${p.subprojects.length ? ` [sub-projects: ${p.subprojects.join(", ")}]` : ""}${p.aliases.length ? ` (also called ${p.aliases.join(", ")})` : ""}`).join("; ") || "unknown"}.
Use "Unknown" when the project isn't stated. Fill only what the email states or clearly implies; leave text empty otherwise.
Resolve relative dates against today's date. Ignore quoted earlier messages, signatures and marketing emails (is_request false).`;

  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: schema(projects.map((p) => p.name)) } },
      system,
      messages: [{ role: "user", content: `Today is ${today}.\n\nEmails (JSON):\n${JSON.stringify(emails)}` }],
    });
    if (response.stop_reason === "refusal") return json({ error: "The assistant couldn't read these emails" }, 422);
    if (response.stop_reason === "max_tokens") return json({ error: "Too many emails at once; try a shorter period" }, 413);
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return json({ error: "No report returned" }, 502);
    const out = JSON.parse(text);
    for (const it of out.items) {
      if (it.project === "Unknown") it.project = "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.needed_by)) it.needed_by = "";
    }
    return json(out);
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The assistant is busy, try again in a moment" }, 429);
    if (err instanceof Anthropic.APIError) return json({ error: "AI reading error" }, 502);
    return json({ error: "Couldn't build the report" }, 500);
  }
};
