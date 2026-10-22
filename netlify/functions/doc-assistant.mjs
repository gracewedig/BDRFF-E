// Document assistant: reads part of an uploaded PDF or spreadsheet (sent as text,
// or a small scanned PDF as a file) and proposes FF&E requests sorted into
// sub-projects. In chat mode it answers the person and updates the proposed list
// following their instructions. Nothing is saved here; the browser creates the
// requests after the person confirms.
// Needs ANTHROPIC_API_KEY, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Netlify.
import Anthropic from "@anthropic-ai/sdk";
import { PRIORITIES } from "../../public/js/fields.js";
import { isSignedIn, json } from "../lib/server.mjs";

const MAX_TEXT = 60000;
const MAX_PDF_BASE64 = 5.5e6;
const MAX_ITEMS = 200;

const clean = (v, n = 200) => String(v ?? "").slice(0, n);

function schema(subprojects) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "items"],
    properties: {
      reply: { type: "string", description: "Short, friendly message to the person: what you found or changed, and anything you weren't sure about" },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sub_project", "buildings", "rooms", "item_needed", "ffe_tag", "spec", "quantity", "priority", "needed_by", "details", "where"],
          properties: {
            sub_project: { type: "string", enum: [...subprojects, "Unassigned"] },
            buildings: { type: "string" },
            rooms: { type: "string" },
            item_needed: { type: "string", description: "Short ticket-style description of what is needed" },
            ffe_tag: { type: "string" },
            spec: { type: "string" },
            quantity: { type: "integer" },
            priority: { type: "string", enum: PRIORITIES },
            needed_by: { type: "string", description: "YYYY-MM-DD or empty" },
            details: { type: "string" },
            where: { type: "string", description: "Where in the document this came from, e.g. 'page 3' or 'Sheet1 row 12'" },
          },
        },
      },
    },
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "The AI assistant isn't set up (ANTHROPIC_API_KEY missing in Netlify)" }, 503);
  if (!(await isSignedIn(req))) return json({ error: "Please sign in" }, 401);

  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const mode = b.mode === "chat" ? "chat" : "extract";
  const project = clean(b.project, 80);
  const subprojects = (Array.isArray(b.subprojects) ? b.subprojects : []).map((s) => clean(s, 80)).filter(Boolean).slice(0, 50);
  const fallbackSub = subprojects.includes(b.default_sub_project) ? b.default_sub_project : "";
  const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today || "") ? b.today : new Date().toISOString().slice(0, 10);
  const text = clean(b.text, MAX_TEXT);
  const pdf = typeof b.pdf_base64 === "string" && b.pdf_base64.length <= MAX_PDF_BASE64 ? b.pdf_base64 : "";
  const conversation = (Array.isArray(b.messages) ? b.messages : []).slice(-20)
    .map((m) => `${m.role === "assistant" ? "Assistant" : "Person"}: ${clean(m.content, 2000)}`).join("\n");
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS);
  if (mode === "extract" && !text && !pdf) return json({ error: "Nothing to read in that part of the file" }, 400);

  const system = `You help the FF&E (furniture, fixtures & equipment) team at the resort project "${project}" turn documents
(punch lists, inspection reports, spec books, spreadsheets) into request tickets.
Sub-projects of ${project}: ${subprojects.join(", ") || "(none)"}.
Put each request in the sub-project the document indicates (by name, building, area, sheet or section heading).
${fallbackSub ? `If nothing indicates a sub-project, use "${fallbackSub}" (where the person uploaded it).` : `If nothing indicates a sub-project, use "Unassigned".`}
One request per distinct item/location that needs FF&E work (replace, repair, order, install). Merge exact repeats.
Fill only what the document states or clearly implies; leave text empty when unknown. Quantity defaults to 1.
Resolve relative dates against today's date (${today}). Follow the person's instructions about what to include and how to organize.
Keep "reply" brief and plain; mention anything you skipped or weren't sure about.`;

  let content;
  if (mode === "extract") {
    content = [
      ...(pdf ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } }] : []),
      { type: "text", text: [
        `File: ${clean(b.file_name, 200)}${b.parts > 1 ? ` (part ${b.part} of ${b.parts})` : ""}`,
        conversation ? `Conversation so far (follow the person's instructions):\n${conversation}` : "",
        text ? `Document text:\n${text}` : "Read the attached PDF.",
        "List the requests found in this part.",
      ].filter(Boolean).join("\n\n") },
    ];
  } else {
    content = [{ type: "text", text: [
      `File: ${clean(b.file_name, 200)}`,
      text ? `Document text (may be shortened):\n${text}` : "",
      `Current proposed requests (JSON):\n${JSON.stringify(items)}`,
      `Conversation:\n${conversation}`,
      "Answer the person's latest message. Return the full updated list of requests (unchanged if they only asked a question).",
    ].filter(Boolean).join("\n\n") }];
  }

  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: schema(subprojects) } },
      system,
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal") return json({ error: "The assistant couldn't read this document" }, 422);
    if (response.stop_reason === "max_tokens") return json({ error: "That part was too long to finish", retry_smaller: true }, 413);
    const out = JSON.parse(response.content.find((x) => x.type === "text")?.text || "{}");
    for (const it of out.items || []) {
      if (it.sub_project === "Unassigned") it.sub_project = "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.needed_by)) it.needed_by = "";
      it.quantity = Math.max(1, it.quantity || 1);
    }
    return json({ reply: out.reply || "", items: out.items || [] });
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The assistant is busy, try again in a moment" }, 429);
    if (err instanceof Anthropic.APIError) return json({ error: "The assistant had a problem reading this" }, 502);
    if (err instanceof SyntaxError) return json({ error: "The assistant's answer was incomplete", retry_smaller: true }, 502);
    return json({ error: "The assistant is unavailable" }, 500);
  }
};
