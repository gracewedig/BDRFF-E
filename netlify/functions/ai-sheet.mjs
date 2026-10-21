// AI spreadsheet assistant: turns a plain-English request into a view spec
// (columns, filters, sort, grouping) over the FF&E request list.
// Requires the ANTHROPIC_API_KEY environment variable in Netlify.
import Anthropic from "@anthropic-ai/sdk";
import { FIELDS, FIELD_KEYS, OPS, OP_KEYS, PROJECTS, STATUSES, PRIORITIES } from "../../public/js/fields.js";

const client = new Anthropic();

const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "columns", "filters", "sort_field", "sort_dir", "group_by", "explanation"],
  properties: {
    name: { type: "string", description: "Short sheet title, under 50 characters" },
    columns: { type: "array", items: { type: "string", enum: FIELD_KEYS } },
    filters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "op", "value"],
        properties: {
          field: { type: "string", enum: FIELD_KEYS },
          op: { type: "string", enum: OP_KEYS },
          value: { type: "string" },
        },
      },
    },
    sort_field: { type: "string", enum: FIELD_KEYS },
    sort_dir: { type: "string", enum: ["asc", "desc"] },
    group_by: { type: "string", enum: [...FIELD_KEYS, "none"] },
    explanation: { type: "string", description: "One friendly sentence describing what the sheet shows" },
  },
};

const SYSTEM = `You build custom spreadsheet views for the Black Desert Resort FF&E (furniture, fixtures & equipment) tracker.
Each row is one FF&E request. You never see the data; you only return a view definition that the app applies.

Columns (key: label, type):
${FIELDS.map((f) => `- ${f.key}: ${f.label} (${f.type}${f.options ? `: ${f.options.join(" | ")}` : ""})`).join("\n")}

Filter operators (op: meaning):
${Object.entries(OPS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Rules:
- All filters are combined with AND. For "A or B" on one field use op "in" with a comma-separated value, e.g. "The Cove, The Terrace".
- Enum values must be spelled exactly: projects ${PROJECTS.join(", ")}; statuses ${STATUSES.join(", ")}; priorities ${PRIORITIES.join(", ")}.
- "Open" means status in Pending, Approved, In Progress.
- Dates are YYYY-MM-DD. Resolve relative dates ("this month", "next week") against today's date. Use due_within_days (value = number of days) for "due in the next N days" and overdue (field needed_by, empty value) for late items.
- is_me (field requester_name, empty value) means requests submitted by the person asking ("my requests").
- For overdue, is_empty, not_empty and is_me, set value to "".
- Always include "ticket" as the first column. Pick columns that answer the request; when unsure include project, buildings, rooms, item_needed, needed_by and status.
- Use group_by "none" unless the user asks to group/organize by something.
- If a current view is provided, modify it according to the request instead of starting over.`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function isSignedIn(req) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return process.env.ALLOW_ANON_AI === "true";
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, { headers: { apikey: key, authorization: auth } });
  return res.ok;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "AI assistant is not configured (ANTHROPIC_API_KEY missing)" }, 503);
  if (!(await isSignedIn(req))) return json({ error: "Please sign in to use the AI assistant" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const prompt = String(body.prompt || "").trim().slice(0, 2000);
  if (!prompt) return json({ error: "Describe the sheet you want" }, 400);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || "") ? body.today : new Date().toISOString().slice(0, 10);

  const userText = [
    `Today is ${today}.`,
    body.current ? `Current view:\n${JSON.stringify(body.current)}` : "",
    `Request: ${prompt}`,
  ].filter(Boolean).join("\n\n");

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SPEC_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: userText }],
    });
    if (response.stop_reason === "refusal") return json({ error: "The assistant couldn't build that sheet" }, 422);
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return json({ error: "The assistant returned no sheet" }, 502);
    return json({ spec: JSON.parse(text) });
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "AI assistant is busy, try again in a moment" }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "AI assistant API key is invalid" }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: "AI assistant error" }, 502);
    if (err instanceof SyntaxError) return json({ error: "The assistant returned an unreadable sheet" }, 502);
    return json({ error: "AI assistant unavailable" }, 500);
  }
};
