// Data layer. Uses Supabase (shared database, logins, photo storage, live updates)
// when config.js has keys; otherwise a single-browser Demo store in localStorage.
import { CONFIG } from "./config.js";
import { todayISO, addDaysISO, DEFAULT_SETTINGS } from "./fields.js";
import { parseEmailHeuristic } from "./emailparse.js";
import { findMatches, DUP_THRESHOLD } from "./dedupe.js";

const cloudReady = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase);
// Invite and password-reset links land with "#...type=invite" in the URL; note it
// before the Supabase client reads and clears the address bar.
const AUTH_LINK_TYPE = new URLSearchParams(location.hash.replace(/^#/, "")).get("type") || "";
export const store = cloudReady ? createCloudStore() : createDemoStore();

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

// The project (resort) being worked on; lists only return its records.
let SCOPE = "";
const inScope = (r) => !SCOPE || r.project === SCOPE;

const CHUNK = 200;
const chunks = (arr) => Array.from({ length: Math.ceil(arr.length / CHUNK) }, (_, i) => arr.slice(i * CHUNK, (i + 1) * CHUNK));

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
      const data = check(await sb.auth.signUp({ email, password, options: { data: { full_name: name }, emailRedirectTo: location.origin } }));
      // Supabase answers a sign-up for an already-confirmed email with an empty user (no identities).
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new Error("This email already has an account. Use Sign in instead, or Forgot password.");
      }
      return data.session ? loadProfile(data.user) : null; // null => email confirmation required
    },
    // Confirms a new account with the code from its confirmation email.
    async verifyEmailCode(email, code) {
      let res = await sb.auth.verifyOtp({ email, token: code, type: "email" });
      if (res.error) res = await sb.auth.verifyOtp({ email, token: code, type: "signup" });
      if (res.error) throw new Error(/expired|invalid/i.test(res.error.message) ? "That code is wrong or has expired. Check it, or send a new one." : res.error.message);
      return loadProfile(res.data.user);
    },
    async resendConfirmation(email) {
      check(await sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: location.origin } }));
    },
    async resetPassword(email) {
      check(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin }));
    },
    async signOut() { await sb.auth.signOut(); },
    // "invite" or "recovery" when the person arrived from an emailed link and needs to choose a password.
    passwordSetupNeeded: () => ["invite", "recovery"].includes(AUTH_LINK_TYPE),
    async setPassword(password) { check(await sb.auth.updateUser({ password })); },
    async accessToken() {
      const { data } = await sb.auth.getSession();
      return data.session?.access_token || "";
    },

    setScope(project) { SCOPE = project || ""; },
    async listRequests() {
      let q = sb.from("requests").select("*").order("created_at", { ascending: false });
      if (SCOPE) q = q.eq("project", SCOPE);
      return check(await q);
    },
    // Counts for the Projects page (all projects).
    async projectSummary() {
      const [requests, inventory, emails] = await Promise.all([
        sb.from("requests").select("project, sub_project, status, needed_by").then(check),
        sb.from("inventory_items").select("project, sub_project, quantity, min_qty").then(check),
        sb.from("email_requests").select("project, status").eq("status", "New").then(check),
      ]);
      return { requests, inventory, emails };
    },
    async createRequest(fields, photos) {
      const uploaded = [];
      for (const p of photos) {
        const path = `${me.id}/${crypto.randomUUID()}.jpg`;
        check(await sb.storage.from(bucket).upload(path, p.blob, { contentType: p.blob.type || "image/jpeg" }));
        uploaded.push({ path, kind: p.kind, name: p.name });
      }
      return check(await sb.from("requests")
        .insert({ project: SCOPE, ...fields, photos: uploaded, requested_by: me.id, requester_name: me.full_name || me.email })
        .select().single());
    },
    // Insert prepared tickets (email conversions, spreadsheet imports); photos are already stored.
    async insertRequests(rows) {
      const out = [];
      const stamp = { requested_by: me.id };
      for (const part of chunks(rows)) {
        out.push(...check(await sb.from("requests").insert(part.map((r) => ({ project: SCOPE, requester_name: me.full_name || me.email, ...r, ...stamp }))).select()));
      }
      return out;
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
    async manageUser(action, payload) {
      const { data } = await sb.auth.getSession();
      const res = await fetch(CONFIG.USERS_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token || ""}` },
        body: JSON.stringify({ action, ...payload, redirectTo: location.origin + location.pathname }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `User admin unavailable (${res.status}). Check the Netlify setup in the README.`);
      return body;
    },
    inviteUser(p) { return this.manageUser("invite", p); },
    removeUser(id) { return this.manageUser("remove", { id }); },

    async getSettings() {
      return check(await sb.from("app_settings").select("projects, options").eq("id", 1).maybeSingle()) || DEFAULT_SETTINGS;
    },
    async saveSettings(settings) {
      return check(await sb.from("app_settings").update({ projects: settings.projects, options: settings.options, updated_at: new Date().toISOString() }).eq("id", 1).select("projects, options").single());
    },
    async renameProject(oldName, newName, subOld = null, subNew = null) {
      check(await sb.rpc("rename_project", { p_old: oldName, p_new: newName, p_sub_old: subOld, p_sub_new: subNew }));
    },
    // table: "requests" | "inventory_items" | "email_requests"
    async setNotes(table, id, notes) {
      check(await sb.rpc("set_item_notes", { p_table: table, p_id: id, p_notes: notes }));
    },
    async setFollowUp(table, id, on, note) {
      check(await sb.rpc("set_follow_up", { p_table: table, p_id: id, p_on: on || null, p_note: note || null }));
    },

    async listDocuments() {
      let q = sb.from("documents").select("*").order("created_at", { ascending: false });
      if (SCOPE) q = q.eq("project", SCOPE);
      return check(await q);
    },
    async uploadDocument(file) {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
      const path = `${me.id}/${crypto.randomUUID()}.${ext}`;
      check(await sb.storage.from(CONFIG.DOCS_BUCKET).upload(path, file, { contentType: file.type || undefined }));
      return path;
    },
    async saveDocument(doc) {
      const { id, created_at, ...fields } = doc;
      return id
        ? check(await sb.from("documents").update(fields).eq("id", id).select().single())
        : check(await sb.from("documents").insert({ project: SCOPE, uploaded_by: me.id, uploaded_by_name: me.full_name || me.email, ...fields }).select().single());
    },
    async documentUrl(doc) {
      if (!doc.path) return "";
      return check(await sb.storage.from(CONFIG.DOCS_BUCKET).createSignedUrl(doc.path, 60 * 60)).signedUrl;
    },
    async deleteDocument(doc) {
      if (doc.path) await sb.storage.from(CONFIG.DOCS_BUCKET).remove([doc.path]);
      check(await sb.from("documents").delete().eq("id", doc.id));
    },
    // Document assistant (Netlify function). Errors carry .status so callers can retry smaller pieces.
    async askAssistant(payload) {
      const { data } = await sb.auth.getSession();
      const res = await fetch(CONFIG.DOC_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token || ""}` },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error || `Assistant unavailable (${res.status})`), { status: res.status });
      return body;
    },

    async listInventory() {
      let q = sb.from("inventory_items").select("*").order("sub_project").order("category").order("item_name");
      if (SCOPE) q = q.eq("project", SCOPE);
      return check(await q);
    },
    async listMoves() {
      let q = sb.from("inventory_moves").select("*, inventory_items!inner(project)").order("moved_at", { ascending: false }).limit(1000);
      if (SCOPE) q = q.eq("inventory_items.project", SCOPE);
      return check(await q).map(({ inventory_items, ...m }) => m);
    },
    async saveInventoryItem(item) {
      const { id, created_at, created_by, ...fields } = item;
      fields.updated_at = new Date().toISOString();
      return id
        ? check(await sb.from("inventory_items").update(fields).eq("id", id).select().single())
        : check(await sb.from("inventory_items").insert({ project: SCOPE, ...fields }).select().single());
    },
    async bulkSaveInventory(newItems, updates) {
      const out = [];
      for (const part of chunks(newItems)) out.push(...check(await sb.from("inventory_items").insert(part.map((i) => ({ project: SCOPE, ...i }))).select()));
      for (const u of updates) out.push(await this.saveInventoryItem(u));
      return out;
    },
    async deleteInventoryItem(id) { check(await sb.from("inventory_items").delete().eq("id", id)); },
    async recordMove(m) {
      return check(await sb.rpc("record_inventory_move", {
        p_item: m.item_id, p_direction: m.direction, p_qty: m.quantity, p_dest_sub_project: m.dest_sub_project || null,
        p_dest_building: m.dest_building || null, p_dest_room: m.dest_room || null, p_ticket: m.linked_ticket || null, p_note: m.note || null,
      }));
    },

    async listEmailRequests() {
      let q = sb.from("email_requests").select("*").order("received_at", { ascending: false }).limit(500);
      // Emails that didn't name a project show up in every project so they aren't missed.
      if (SCOPE) q = q.or(`project.eq."${SCOPE.replace(/"/g, "")}",project.is.null`);
      return check(await q);
    },
    async updateEmailRequest(id, patch) {
      return check(await sb.from("email_requests").update(patch).eq("id", id).select().single());
    },
    async linkEmailDuplicate(emailId, requestId, reason) {
      check(await sb.rpc("link_email_duplicate", { p_email: emailId, p_request: requestId, p_reason: reason }));
    },
    // Runs a pasted email through the same intake as forwarded mail.
    async submitEmail(email) {
      const { data } = await sb.auth.getSession();
      const res = await fetch(CONFIG.EMAIL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token || ""}` },
        body: JSON.stringify({ ...email, project_hint: SCOPE }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Email intake unavailable (${res.status})`);
      return body.email_request;
    },

    subscribe(onChange) {
      const ch = sb.channel("ffe-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, () => onChange("requests"))
        .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => onChange("profiles"))
        .on("postgres_changes", { event: "*", schema: "public", table: "inventory_items" }, () => onChange("inventory"))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "inventory_moves" }, () => onChange("inventory"))
        .on("postgres_changes", { event: "*", schema: "public", table: "email_requests" }, () => onChange("email"))
        .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => onChange("settings"))
        .on("postgres_changes", { event: "*", schema: "public", table: "documents" }, () => onChange("documents"))
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
    const BDR = "Black Desert Resort";
    const mk = (n, p, extra) => ({
      id: uid(), ticket_no: n, quantity: 1, priority: "Normal", spec: "", details: "", photos: [],
      status: "Pending", requested_by: "u-or1", requester_name: "Riley Chen",
      created_at: new Date(Date.now() - (10 - n) * 86400000).toISOString(), project: BDR, sub_project: p, ...extra,
    });
    const requests = [
      mk(1, "The Cove", { buildings: "89", rooms: "8902, 8904", item_needed: "Replace torn lounge chair cushions on balcony", ffe_tag: "FFE-COV-OD-114", spec: "Sunbrella Canvas Navy, 24x24x4", quantity: 4, needed_by: addDaysISO(t, 5), priority: "High" }),
      mk(2, "The Terrace", { buildings: "12", rooms: "1207", item_needed: "Nightstand drawer pull broken", ffe_tag: "FFE-TER-GR-031", needed_by: addDaysISO(t, -2), status: "Approved", reviewer_name: "Morgan Hale", reviewed_at: new Date().toISOString(), review_note: "Approved – vendor has stock." }),
      mk(3, "Waterpark", { buildings: "Cabana row", rooms: "Cabana 6", item_needed: "Replace faded cabana curtains", ffe_tag: "FFE-WP-CB-006", needed_by: addDaysISO(t, 21), requested_by: "u-or2", requester_name: "Jordan Ruiz" }),
      mk(4, "Resort Center", { buildings: "Main lobby", rooms: "Lobby lounge", item_needed: "Area rug stain – deep clean or replace", ffe_tag: "FFE-RC-LB-002", needed_by: addDaysISO(t, 12), status: "In Progress", priority: "Urgent", reviewer_name: "Morgan Hale", reviewed_at: new Date().toISOString() }),
      mk(5, "Pickleball", { buildings: "Pavilion", rooms: "Court 3", item_needed: "Two replacement spectator benches", ffe_tag: "FFE-PB-BN-003", quantity: 2, needed_by: addDaysISO(t, 30), status: "Completed", reviewer_name: "Morgan Hale", reviewed_at: new Date().toISOString() }),
    ];
    const inv = (sub_project, stock_type, item_name, ffe_tag, category, location, quantity, min_qty, extra = {}) => ({
      id: uid(), project: BDR, sub_project, stock_type, item_name, ffe_tag, category, location, quantity, min_qty, unit: "ea",
      description: "", vendor: "", notes: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra,
    });
    const inventory = [
      inv("The Cove", "Attic Stock", "Balcony lounge chair cushion – Navy", "FFE-COV-OD-114", "Outdoor", "Bldg 89 attic", 12, 6, { description: "Sunbrella Canvas Navy 24x24x4", vendor: "Sunbrella" }),
      inv("The Cove", "Attic Stock", "Dining chair", "FFE-COV-DN-210", "Dining", "Bldg 89 attic", 3, 4),
      inv("The Cove", "Inventory", "Area rug 8x10", "FFE-COV-LV-050", "Living", "Bldg 90 storage", 2, 1),
      inv("The Terrace", "Attic Stock", "Nightstand drawer pull – brass", "FFE-TER-GR-031", "Hardware", "Bldg 12 attic, shelf B", 40, 10),
      inv("The Terrace", "Attic Stock", "Table lamp shade – linen", "FFE-TER-LT-012", "Lighting", "Bldg 12 attic, shelf C", 6, 4),
      inv("Resort Center", "Inventory", "Lobby lounge chair", "FFE-RC-LB-010", "Seating", "Main warehouse", 4, 2),
      inv("Waterpark", "Attic Stock", "Cabana curtain panel – white", "FFE-WP-CB-006", "Textiles", "Waterpark storage room", 8, 4),
      inv("Pickleball", "Inventory", "Spectator bench", "FFE-PB-BN-003", "Seating", "Pavilion storage", 1, 1),
    ];
    const moves = [{
      id: uid(), item_id: inventory[3].id, direction: "out", quantity: 1, qty_after: 40, dest_sub_project: "The Terrace",
      dest_building: "12", dest_room: "1207", linked_ticket: "REQ-0002", note: "Installed", moved_by: "u-mgr",
      moved_by_name: "Morgan Hale", moved_at: new Date(Date.now() - 86400000).toISOString(),
    }];
    const emails = [];
    const mkEmail = (from_name, from_email, subject, text) => {
      const f = parseEmailHeuristic({ subject, text }, t);
      return { id: uid(), message_id: uid(), received_at: new Date(Date.now() - 3600000 * (emails.length + 2)).toISOString(), from_email, from_name, subject, body: text, attachments: [], ...f, status: "New" };
    };
    emails.push(mkEmail("Front Desk – Cove", "frontdesk@example.com", "Torn cushions Cove bldg 89",
      "Hi team,\nGuest in room 8902 reported the balcony lounge chair cushions are torn. Tag FFE-COV-OD-114. Qty: 4. Can we get these replaced by " + addDaysISO(t, 6).slice(5).replace("-", "/") + "?\nThanks"));
    emails.push(mkEmail("Housekeeping – Waterpark", "hk.waterpark@example.com", "Cabana 9 umbrella broken",
      "Hello, the shade umbrella at the Waterpark cabana 9 has a broken rib and won't open. Building: Cabana row. Need it fixed before the weekend, urgent please."));
    emails.push(mkEmail("Vendor Newsletter", "news@example.com", "Our fall catalog is here",
      "Browse our latest outdoor collection and save 20% this month."));
    emails[2].is_request = false;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.find((p) => p.name === "Cornerstone").subprojects = ["Clubhouse", "Golf Cottages"];
    settings.options.locations = ["Bldg 12 attic", "Bldg 89 attic", "Bldg 90 storage", "Main warehouse", "Waterpark storage room"];
    requests.push(mk(6, "Clubhouse", { project: "Cornerstone", buildings: "Clubhouse", rooms: "Grill room", item_needed: "Re-upholster six bar stools", ffe_tag: "FFE-CS-CH-021", quantity: 6, needed_by: addDaysISO(t, 18), requested_by: "u-or2", requester_name: "Jordan Ruiz" }));
    inventory.push(inv("Golf Cottages", "Attic Stock", "Cottage lamp – brass", "FFE-CS-GC-004", "Lighting", "Cottage 3 storage", 5, 2, { project: "Cornerstone" }));
    requests[1].notes = "Vendor confirmed brass pulls in stock; install Thursday.";
    requests[4].notes = "Benches installed. Keep one spare in pavilion storage.";
    inventory[1].notes = "Two chairs are on backorder until mid-November.";
    emails.forEach((e) => { if (!e.project) e.project = null; });
    return { users, requests, actions: [], views: [], inventory, moves, emails, settings, seq: requests.length };
  }

  // Same duplicate rules the email-intake function applies.
  function classifyEmail(db, e) {
    if (e.is_request === false) return { status: "Dismissed", duplicate_reason: "Doesn't look like an FF&E request" };
    const pool = db.requests.filter((r) => !["Rejected", "Cancelled"].includes(r.status));
    const [best] = findMatches(e, pool, 1);
    if (best && best.score >= DUP_THRESHOLD) {
      return { status: "Duplicate", duplicate_of: best.item.id, match_score: best.score, duplicate_reason: `Matches an existing ticket: ${best.reasons.join(", ")}` };
    }
    const others = db.emails.filter((x) => x.id !== e.id && x.status === "New");
    const [bestEmail] = findMatches(e, others, 1);
    if (bestEmail && bestEmail.score >= DUP_THRESHOLD) {
      return { status: "Duplicate", duplicate_of_email: bestEmail.item.id, match_score: bestEmail.score, duplicate_reason: `Same as an earlier email: ${bestEmail.reasons.join(", ")}` };
    }
    return { status: "New" };
  }

  let memory = null; // used when the browser blocks storage
  const pendingFiles = {}; // uploaded file contents waiting for saveDocument
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch { if (memory) return memory; }
    const db = seed();
    db.emails.forEach((e) => Object.assign(e, classifyEmail(db, e)));
    save(db, false);
    return db;
  }
  function save(db, notify = true) {
    memory = db;
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) {
      if (e?.name === "QuotaExceededError") throw new Error("This browser's storage is full. In Demo mode photos are kept in the browser — remove some or connect Supabase.");
    }
    // This tab already updated its own state; other open tabs hear about it via the storage event.
    void notify;
  }
  const meId = () => { try { return sessionStorage.getItem(USER_KEY); } catch { return null; } };
  const me = () => load().users.find((u) => u.id === meId()) || null;

  window.addEventListener("storage", (e) => { if (e.key === KEY) listeners.forEach((fn) => fn("all")); });

  return {
    mode: "demo",
    demoUsers: () => load().users,
    async currentUser() { return me(); },
    async signInAs(id) { try { sessionStorage.setItem(USER_KEY, id); } catch { /* ignore */ } return me(); },
    async signOut() { try { sessionStorage.removeItem(USER_KEY); } catch { /* ignore */ } },
    passwordSetupNeeded: () => false,
    async accessToken() { return ""; },
    resetDemo() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },

    setScope(project) { SCOPE = project || ""; },
    async listRequests() { return load().requests.filter(inScope).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    async projectSummary() {
      const db = load();
      return { requests: db.requests, inventory: db.inventory, emails: db.emails.filter((e) => e.status === "New") };
    },
    async createRequest(fields, photos) {
      const db = load();
      const u = me();
      const r = {
        project: SCOPE, ...fields, id: uid(), ticket_no: ++db.seq, status: "Pending", requested_by: u.id, requester_name: u.full_name,
        photos: photos.map((p) => ({ path: uid(), kind: p.kind, name: p.name, data: p.dataUrl })),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      db.requests.push(r);
      save(db);
      return r;
    },
    async insertRequests(rows) {
      const db = load();
      const u = me();
      const now = new Date().toISOString();
      const out = rows.map((r) => ({
        project: SCOPE, quantity: 1, priority: "Normal", photos: [], status: "Pending", requester_name: u.full_name, ...r,
        id: uid(), ticket_no: ++db.seq, requested_by: u.id, created_at: now, updated_at: now,
      }));
      db.requests.push(...out);
      save(db);
      return out;
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
    async inviteUser({ email, full_name, role }) {
      const db = load();
      if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) throw new Error("That email already has an account");
      const u = { id: uid(), email, full_name, role, invited_at: new Date().toISOString(), invited_by: meId(), created_at: new Date().toISOString() };
      db.users.push(u);
      save(db);
      return { user: u, demo: true };
    },
    async removeUser(id) {
      const db = load();
      db.users = db.users.filter((u) => u.id !== id);
      db.actions = db.actions.filter((a) => a.owner !== id);
      db.views = db.views.filter((v) => v.owner !== id);
      db.requests.forEach((r) => { if (r.requested_by === id) r.requested_by = null; });
      save(db);
      return { ok: true };
    },

    async getSettings() { return load().settings || DEFAULT_SETTINGS; },
    async saveSettings(settings) { const db = load(); db.settings = structuredClone(settings); save(db); return db.settings; },
    async renameProject(oldName, newName, subOld = null, subNew = null) {
      const db = load();
      for (const r of [...db.requests, ...db.inventory, ...db.emails]) {
        if (subOld == null) { if (r.project === oldName) r.project = newName; }
        else if (r.project === oldName && r.sub_project === subOld) r.sub_project = subNew;
      }
      if (subOld != null) {
        const ids = new Set(db.inventory.filter((i) => i.project === oldName).map((i) => i.id));
        db.moves.forEach((m) => { if (ids.has(m.item_id) && m.dest_sub_project === subOld) m.dest_sub_project = subNew; });
      }
      save(db);
    },
    async setNotes(table, id, notes) {
      const db = load();
      const list = { requests: db.requests, inventory_items: db.inventory, email_requests: db.emails }[table];
      const it = list.find((x) => x.id === id);
      Object.assign(it, { notes: notes || null, notes_updated_at: new Date().toISOString(), notes_updated_by_name: me().full_name });
      save(db);
    },
    async setFollowUp(table, id, on, note) {
      const db = load();
      const it = (table === "requests" ? db.requests : db.emails).find((x) => x.id === id);
      Object.assign(it, { follow_up_on: on || null, follow_up_note: note || null, follow_up_by_name: on ? me().full_name : null });
      save(db);
    },

    async listDocuments() {
      return (load().documents || []).filter(inScope).sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    // Demo keeps small files (under 1.5 MB) in the browser so they can be opened again.
    async uploadDocument(file) {
      const path = uid();
      if (file.size <= 1.5e6) {
        pendingFiles[path] = await new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.readAsDataURL(file);
        });
      }
      return path;
    },
    async saveDocument(doc) {
      const db = load();
      db.documents = db.documents || [];
      let d = doc.id && db.documents.find((x) => x.id === doc.id);
      if (d) Object.assign(d, doc);
      else {
        const u = me();
        d = { project: SCOPE, sub_projects: [], requests_created: 0, ...doc, id: uid(), uploaded_by: u.id, uploaded_by_name: u.full_name, created_at: new Date().toISOString(), data: pendingFiles[doc.path] || null };
        delete pendingFiles[doc.path];
        db.documents.push(d);
      }
      save(db);
      return { ...d };
    },
    async documentUrl(doc) { return doc.data || ""; },
    async deleteDocument(doc) { const db = load(); db.documents = (db.documents || []).filter((d) => d.id !== doc.id); save(db); },
    async askAssistant() { throw Object.assign(new Error("The AI assistant isn't available in Demo mode"), { status: 503 }); },

    async listInventory() { return load().inventory.filter(inScope); },
    async listMoves() {
      const db = load();
      const ids = new Set(db.inventory.filter(inScope).map((i) => i.id));
      return db.moves.filter((m) => ids.has(m.item_id)).sort((a, b) => b.moved_at.localeCompare(a.moved_at));
    },
    async saveInventoryItem(item) {
      const db = load();
      const now = new Date().toISOString();
      let it = item.id && db.inventory.find((x) => x.id === item.id);
      if (it) Object.assign(it, item, { updated_at: now });
      else { it = { project: SCOPE, unit: "ea", ...item, id: uid(), created_at: now, updated_at: now }; db.inventory.push(it); }
      save(db);
      return { ...it };
    },
    async bulkSaveInventory(newItems, updates) {
      const db = load();
      const now = new Date().toISOString();
      const created = newItems.map((i) => ({ project: SCOPE, unit: "ea", ...i, id: uid(), created_at: now, updated_at: now }));
      db.inventory.push(...created);
      updates.forEach((u) => Object.assign(db.inventory.find((x) => x.id === u.id) || {}, u, { updated_at: now }));
      save(db);
      return created;
    },
    async deleteInventoryItem(id) {
      const db = load();
      db.inventory = db.inventory.filter((i) => i.id !== id);
      db.moves = db.moves.filter((m) => m.item_id !== id);
      save(db);
    },
    async recordMove(m) {
      const db = load();
      const it = db.inventory.find((x) => x.id === m.item_id);
      if (!it) throw new Error("Item not found");
      if (!(m.quantity >= 1)) throw new Error("Quantity must be at least 1");
      if (m.direction === "out" && it.quantity < m.quantity) throw new Error(`Only ${it.quantity} on hand`);
      it.quantity += m.direction === "out" ? -m.quantity : m.quantity;
      it.updated_at = new Date().toISOString();
      const u = me();
      db.moves.push({ ...m, id: uid(), qty_after: it.quantity, moved_by: u.id, moved_by_name: u.full_name, moved_at: it.updated_at });
      save(db);
      return { ...it };
    },

    async listEmailRequests() {
      return load().emails.filter((e) => !SCOPE || !e.project || e.project === SCOPE).sort((a, b) => b.received_at.localeCompare(a.received_at));
    },
    async updateEmailRequest(id, patch) {
      const db = load();
      const e = db.emails.find((x) => x.id === id);
      Object.assign(e, patch);
      save(db);
      return { ...e };
    },
    async linkEmailDuplicate(emailId, requestId, reason) {
      const db = load();
      const e = db.emails.find((x) => x.id === emailId);
      if (e && e.status === "New") Object.assign(e, { status: "Duplicate", duplicate_of: requestId, duplicate_reason: reason || "Also submitted in the app" });
      save(db);
    },
    async submitEmail({ from_name, from_email, subject, text }) {
      const db = load();
      const f = parseEmailHeuristic({ subject, text, hint: SCOPE });
      const e = { id: uid(), message_id: uid(), received_at: new Date().toISOString(), from_email, from_name, subject, body: text, attachments: [], ...f, created_by: meId() };
      Object.assign(e, classifyEmail(db, e));
      db.emails.push(e);
      save(db);
      return e;
    },

    subscribe(onChange) { listeners.add(onChange); return () => listeners.delete(onChange); },
  };
}
