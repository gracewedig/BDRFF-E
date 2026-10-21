// Data layer. Uses Supabase (shared database, logins, photo storage, live updates)
// when config.js has keys; otherwise a single-browser Demo store in localStorage.
import { CONFIG } from "./config.js";
import { todayISO, addDaysISO } from "./fields.js";

const cloudReady = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase);
export const store = cloudReady ? createCloudStore() : createDemoStore();

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

/* ---------------------------------------------------------------- Supabase */
function createCloudStore() {
  const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const bucket = CONFIG.PHOTO_BUCKET;
  let me = null;

  async function loadProfile(user) {
    const profile = check(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
    me = profile || { id: user.id, email: user.email, full_name: user.email, role: "owner_relations" };
    return me;
  }

  return {
    mode: "cloud",
    async currentUser() {
      const { data } = await sb.auth.getSession();
      return data.session ? loadProfile(data.session.user) : null;
    },
    async signIn(email, password) {
      const data = check(await sb.auth.signInWithPassword({ email, password }));
      return loadProfile(data.user);
    },
    async signUp(name, email, password) {
      const data = check(await sb.auth.signUp({ email, password, options: { data: { full_name: name } } }));
      return data.session ? loadProfile(data.user) : null; // null => email confirmation required
    },
    async resetPassword(email) {
      check(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin }));
    },
    async signOut() { await sb.auth.signOut(); },
    async accessToken() {
      const { data } = await sb.auth.getSession();
      return data.session?.access_token || "";
    },

    async listRequests() {
      return check(await sb.from("requests").select("*").order("created_at", { ascending: false }));
    },
    async createRequest(fields, photos) {
      const uploaded = [];
      for (const p of photos) {
        const path = `${me.id}/${crypto.randomUUID()}.jpg`;
        check(await sb.storage.from(bucket).upload(path, p.blob, { contentType: p.blob.type || "image/jpeg" }));
        uploaded.push({ path, kind: p.kind, name: p.name });
      }
      return check(await sb.from("requests")
        .insert({ ...fields, photos: uploaded, requested_by: me.id, requester_name: me.full_name || me.email })
        .select().single());
    },
    async updateRequest(id, patch) {
      return check(await sb.from("requests").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single());
    },
    async photoUrls(photos) {
      const paths = (photos || []).map((p) => p.path).filter(Boolean);
      if (!paths.length) return {};
      const data = check(await sb.storage.from(bucket).createSignedUrls(paths, 60 * 60));
      return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
    },

    async listActions() {
      return check(await sb.from("action_items").select("*").eq("owner", me.id).order("sort_order").order("created_at"));
    },
    async saveAction(item) {
      const { id, owner, created_at, ...fields } = item;
      fields.updated_at = new Date().toISOString();
      return id
        ? check(await sb.from("action_items").update(fields).eq("id", id).select().single())
        : check(await sb.from("action_items").insert({ ...fields, owner: me.id }).select().single());
    },
    async deleteAction(id) { check(await sb.from("action_items").delete().eq("id", id)); },

    async listViews() {
      return check(await sb.from("saved_views").select("*").eq("owner", me.id).order("created_at"));
    },
    async saveView(view) {
      const { id, owner, created_at, ...fields } = view;
      return id
        ? check(await sb.from("saved_views").update(fields).eq("id", id).select().single())
        : check(await sb.from("saved_views").insert({ ...fields, owner: me.id }).select().single());
    },
    async deleteView(id) { check(await sb.from("saved_views").delete().eq("id", id)); },

    async listProfiles() {
      return check(await sb.from("profiles").select("*").order("full_name"));
    },
    async setRole(id, role) {
      return check(await sb.from("profiles").update({ role }).eq("id", id).select().single());
    },

    subscribe(onChange) {
      const ch = sb.channel("ffe-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, () => onChange("requests"))
        .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => onChange("profiles"))
        .subscribe();
      return () => sb.removeChannel(ch);
    },
  };
}

/* -------------------------------------------------------------------- Demo */
function createDemoStore() {
  const KEY = "bdr-ffe-demo-v1";
  const USER_KEY = "bdr-ffe-demo-user";
  const listeners = new Set();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

  function seed() {
    const t = todayISO();
    const users = [
      { id: "u-mgr", full_name: "Morgan Hale", email: "morgan@example.com", role: "manager", created_at: new Date().toISOString() },
      { id: "u-or1", full_name: "Riley Chen", email: "riley@example.com", role: "owner_relations", created_at: new Date().toISOString() },
      { id: "u-or2", full_name: "Jordan Ruiz", email: "jordan@example.com", role: "owner_relations", created_at: new Date().toISOString() },
    ];
    const mk = (n, p, extra) => ({
      id: uid(), ticket_no: n, quantity: 1, priority: "Normal", spec: "", details: "", photos: [],
      status: "Pending", requested_by: "u-or1", requester_name: "Riley Chen",
      created_at: new Date(Date.now() - (10 - n) * 86400000).toISOString(), project: p, ...extra,
    });
    const requests = [
      mk(1, "The Cove", { buildings: "89", rooms: "8902, 8904", item_needed: "Replace torn lounge chair cushions on balcony", ffe_tag: "FFE-COV-OD-114", spec: "Sunbrella Canvas Navy, 24x24x4", quantity: 4, needed_by: addDaysISO(t, 5), priority: "High" }),
      mk(2, "The Terrace", { buildings: "12", rooms: "1207", item_needed: "Nightstand drawer pull broken", ffe_tag: "FFE-TER-GR-031", needed_by: addDaysISO(t, -2), status: "Approved", reviewer_name: "Morgan Hale", reviewed_at: new Date().toISOString(), review_note: "Approved – vendor has stock." }),
      mk(3, "Waterpark", { buildings: "Cabana row", rooms: "Cabana 6", item_needed: "Replace faded cabana curtains", ffe_tag: "FFE-WP-CB-006", needed_by: addDaysISO(t, 21), requested_by: "u-or2", requester_name: "Jordan Ruiz" }),
      mk(4, "Resort Center", { buildings: "Main lobby", rooms: "Lobby lounge", item_needed: "Area rug stain – deep clean or replace", ffe_tag: "FFE-RC-LB-002", needed_by: addDaysISO(t, 12), status: "In Progress", priority: "Urgent", reviewer_name: "Morgan Hale", reviewed_at: new Date().toISOString() }),
      mk(5, "Pickleball", { buildings: "Pavilion", rooms: "Court 3", item_needed: "Two replacement spectator benches", ffe_tag: "FFE-PB-BN-003", quantity: 2, needed_by: addDaysISO(t, 30), status: "Completed", reviewer_name: "Morgan Hale", reviewed_at: new Date().toISOString() }),
    ];
    return { users, requests, actions: [], views: [], seq: requests.length };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* storage blocked or corrupt */ }
    const db = seed();
    save(db, false);
    return db;
  }
  function save(db, notify = true) {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch { throw new Error("This browser's storage is full. In Demo mode photos are kept in the browser — remove some or connect Supabase."); }
    if (notify) listeners.forEach((fn) => fn("requests"));
  }
  const meId = () => { try { return sessionStorage.getItem(USER_KEY); } catch { return null; } };
  const me = () => load().users.find((u) => u.id === meId()) || null;

  window.addEventListener("storage", (e) => { if (e.key === KEY) listeners.forEach((fn) => fn("requests")); });

  return {
    mode: "demo",
    demoUsers: () => load().users,
    async currentUser() { return me(); },
    async signInAs(id) { try { sessionStorage.setItem(USER_KEY, id); } catch { /* ignore */ } return me(); },
    async signOut() { try { sessionStorage.removeItem(USER_KEY); } catch { /* ignore */ } },
    async accessToken() { return ""; },
    resetDemo() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },

    async listRequests() { return [...load().requests].sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    async createRequest(fields, photos) {
      const db = load();
      const u = me();
      const r = {
        ...fields, id: uid(), ticket_no: ++db.seq, status: "Pending", requested_by: u.id, requester_name: u.full_name,
        photos: photos.map((p) => ({ path: uid(), kind: p.kind, name: p.name, data: p.dataUrl })),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      db.requests.push(r);
      save(db);
      return r;
    },
    async updateRequest(id, patch) {
      const db = load();
      const r = db.requests.find((x) => x.id === id);
      Object.assign(r, patch, { updated_at: new Date().toISOString() });
      save(db);
      return r;
    },
    async photoUrls(photos) {
      return Object.fromEntries((photos || []).filter((p) => p.data).map((p) => [p.path, p.data]));
    },

    async listActions() { return load().actions.filter((a) => a.owner === meId()); },
    async saveAction(item) {
      const db = load();
      const now = new Date().toISOString();
      let a = item.id && db.actions.find((x) => x.id === item.id);
      if (a) Object.assign(a, item, { updated_at: now });
      else { a = { ...item, id: uid(), owner: meId(), created_at: now, updated_at: now }; db.actions.push(a); }
      save(db, false);
      return { ...a };
    },
    async deleteAction(id) { const db = load(); db.actions = db.actions.filter((a) => a.id !== id); save(db, false); },

    async listViews() { return load().views.filter((v) => v.owner === meId()); },
    async saveView(view) {
      const db = load();
      let v = view.id && db.views.find((x) => x.id === view.id);
      if (v) Object.assign(v, view);
      else { v = { ...view, id: uid(), owner: meId(), created_at: new Date().toISOString() }; db.views.push(v); }
      save(db, false);
      return { ...v };
    },
    async deleteView(id) { const db = load(); db.views = db.views.filter((v) => v.id !== id); save(db, false); },

    async listProfiles() { return load().users; },
    async setRole(id, role) { const db = load(); const u = db.users.find((x) => x.id === id); u.role = role; save(db); return u; },

    subscribe(onChange) { listeners.add(onChange); return () => listeners.delete(onChange); },
  };
}
