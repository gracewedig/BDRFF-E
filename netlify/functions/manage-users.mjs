// Managers invite people by email, re-send invites, and remove people.
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify.
import { adminClient, callerProfile, json } from "../lib/server.mjs";

const ROLES = ["manager", "owner_relations"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const admin = adminClient();
  if (!admin) return json({ error: "User admin isn't set up yet (SUPABASE_SERVICE_ROLE_KEY missing in Netlify)" }, 503);
  const caller = await callerProfile(admin, req);
  if (!caller) return json({ error: "Please sign in again" }, 401);
  if (caller.role !== "manager") return json({ error: "Only managers can manage users" }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  if (body.action === "invite") {
    const email = String(body.email || "").trim().toLowerCase();
    const fullName = String(body.full_name || "").trim().slice(0, 120);
    const role = ROLES.includes(body.role) ? body.role : "owner_relations";
    if (!EMAIL.test(email)) return json({ error: "Enter a valid email address" }, 400);
    const redirectTo = /^https?:\/\//.test(body.redirectTo || "") ? body.redirectTo : undefined;

    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName }, redirectTo });
    if (error) {
      const taken = /already|registered|exists/i.test(error.message);
      return json({ error: taken ? "That email already has an account" : error.message }, taken ? 409 : 400);
    }
    // The sign-up trigger creates the profile; set the role and invite details here
    // (never from user-supplied sign-up data).
    const { error: pErr } = await admin.from("profiles").upsert({
      id: data.user.id, email, full_name: fullName || email.split("@")[0], role,
      invited_at: new Date().toISOString(), invited_by: caller.id,
    });
    if (pErr) return json({ error: pErr.message }, 500);
    return json({ user: { id: data.user.id, email, full_name: fullName, role } });
  }

  if (body.action === "remove") {
    const id = String(body.id || "");
    if (!id) return json({ error: "Missing user" }, 400);
    if (id === caller.id) return json({ error: "You can't remove yourself" }, 400);
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
