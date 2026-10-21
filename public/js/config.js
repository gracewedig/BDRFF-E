// Paste your Supabase project's URL and anon (public) key here to turn on shared,
// multi-user mode. Both values are safe to publish: data is protected by the
// row-level security rules in supabase/schema.sql.
//
// Leave them blank to run in Demo mode (data stays in each person's browser).
export const CONFIG = {
  SUPABASE_URL: "https://yrmbhxnlfqpmkiwwemmf.supabase.co",
  // Publishable key (Supabase → Project Settings → API Keys). Safe to publish.
  SUPABASE_ANON_KEY: "sb_publishable_Yp-S4Hx-DZi5sNyufiSXNA_i9XgeU1R",
  // Storage bucket created by supabase/schema.sql
  PHOTO_BUCKET: "ffe-photos",
  // Netlify functions (see netlify/functions)
  AI_ENDPOINT: "/.netlify/functions/ai-sheet",
  EMAIL_ENDPOINT: "/.netlify/functions/email-inbound",
  USERS_ENDPOINT: "/.netlify/functions/manage-users",
  REPORT_ENDPOINT: "/.netlify/functions/email-report",
  // Outlook connection (My Outlook Report). Register the app in Microsoft Entra ID
  // and paste its Application (client) ID and Directory (tenant) ID; see README.
  MS_CLIENT_ID: "",
  MS_TENANT_ID: "organizations",
  // Show "Create account" on the sign-in page. Set to false once managers invite
  // everyone by email (and turn off sign-ups in Supabase, see README).
  ALLOW_SIGNUP: true,
};
