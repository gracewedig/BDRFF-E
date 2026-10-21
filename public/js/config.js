// Paste your Supabase project's URL and anon (public) key here to turn on shared,
// multi-user mode. Both values are safe to publish: data is protected by the
// row-level security rules in supabase/schema.sql.
//
// Leave them blank to run in Demo mode (data stays in each person's browser).
export const CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  // Storage bucket created by supabase/schema.sql
  PHOTO_BUCKET: "ffe-photos",
  // Netlify function that powers the AI spreadsheet assistant
  AI_ENDPOINT: "/.netlify/functions/ai-sheet",
};
