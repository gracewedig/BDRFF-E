// Helpers shared by the Netlify functions.
import { createClient } from "@supabase/supabase-js";

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Server-side Supabase client with full access. Only ever used inside functions;
// the service role key must never be put in the website code.
export function adminClient() {
  const url = process.env.SUPABASE_URL;
  // Supabase's newer name (secret key) or the older one (service_role).
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// The signed-in staff member making this request (from their login token), with their profile.
export async function callerProfile(admin, req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
  return profile || null;
}

// True when the request carries a valid staff login (checked against Supabase
// with the public anon key, so functions that only need "is this staff?" don't
// need the service role key).
export async function isSignedIn(req) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return process.env.ALLOW_ANON_AI === "true";
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, { headers: { apikey: key, authorization: auth } });
  return res.ok;
}

// Project names sent by the browser (managers can add projects), cleaned up.
export function projectsFrom(list) {
  return (Array.isArray(list) ? list : []).map((p) => String(typeof p === "string" ? p : p?.name || "").trim().slice(0, 80)).filter(Boolean).slice(0, 50);
}
