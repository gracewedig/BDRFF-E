// My Outlook Report: anyone can connect their own Outlook mailbox; the app reads
// recent mail in the browser, picks out FF&E requests, and reports what's coming up,
// marking what's already a ticket or already in Email Requests.
import { store } from "./store.js";
import { CONFIG } from "./config.js";
import { SETTINGS, CURRENT, todayISO, addDaysISO, ticketLabel } from "./fields.js";
import { parseEmailHeuristic } from "./emailparse.js";
import { findMatches, DUP_THRESHOLD } from "./dedupe.js";
import { S, hooks } from "./state.js";
import { esc, opt, badge, fmtDate, toast, guard, icon } from "./ui.js";
import { downloadWorkbook } from "./export.js";

const SCOPES = ["Mail.Read"];
const MSAL_URL = "https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.28.1/lib/msal-browser.min.js";
const MAX_MESSAGES = 200;
const ol = { days: 14, busy: false, step: "", account: null, report: null, loaded: false };
const reportKey = () => `bdr-ffe-outlook-report-${S.me?.id}`;

/* -------------------------------------------------------- Microsoft sign-in */
let pca = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.msal) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("Couldn't load Microsoft sign-in. Check your connection."));
    document.head.appendChild(el);
  });
}

async function msalApp() {
  if (pca) return pca;
  await loadScript(MSAL_URL);
  pca = new window.msal.PublicClientApplication({
    auth: {
      clientId: CONFIG.MS_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${CONFIG.MS_TENANT_ID || "organizations"}`,
      redirectUri: new URL("auth-redirect.html", location.href).href,
    },
    cache: { cacheLocation: "localStorage" },
  });
  await pca.initialize();
  const account = pca.getActiveAccount() || pca.getAllAccounts()[0];
  if (account) pca.setActiveAccount(account);
  return pca;
}

async function accessToken() {
  const app = await msalApp();
  const account = app.getActiveAccount();
  if (!account) throw new Error("Connect your Outlook first");
  try {
    return (await app.acquireTokenSilent({ scopes: SCOPES, account })).accessToken;
  } catch {
    return (await app.acquireTokenPopup({ scopes: SCOPES, account })).accessToken;
  }
}

async function fetchMail(days) {
  const token = await accessToken();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  let url = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
    + `?$top=50&$select=id,subject,from,receivedDateTime,body,webLink,hasAttachments`
    + `&$filter=receivedDateTime ge ${since}&$orderby=receivedDateTime desc`;
  const out = [];
  while (url && out.length < MAX_MESSAGES) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.body-content-type="text"' } });
    if (!res.ok) throw new Error(res.status === 403 ? "Outlook didn't allow reading mail. Ask IT to approve the Mail.Read permission." : `Outlook error (${res.status})`);
    const data = await res.json();
    for (const m of data.value || []) {
      out.push({
        id: m.id, subject: m.subject || "", from: m.from?.emailAddress?.name || "", from_email: m.from?.emailAddress?.address || "",
        received: m.receivedDateTime, link: m.webLink, text: m.body?.content || "",
      });
    }
    url = data["@odata.nextLink"];
  }
  return out;
}

/* ------------------------------------------------------------- the report */
const SAMPLE_INBOX = () => {
  const t = todayISO();
  const d = (n) => addDaysISO(t, n).slice(5).replace("-", "/");
  const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  return [
    { id: "s1", from: "Cove Front Desk", from_email: "frontdesk@example.com", received: at(3), subject: "Torn balcony cushions – Cove bldg 89",
      text: `Hi! Guest in room 8902 says the balcony lounge cushions are torn. Tag FFE-COV-OD-114, qty 4. Can we have new ones by ${d(6)}?` },
    { id: "s2", from: "Terrace Housekeeping", from_email: "hk.terrace@example.com", received: at(8), subject: "Lamp shades – Terrace building 14",
      text: `Room 1411 and 1412 lamp shades are stained and need replacing. Tag FFE-TER-LT-012. Please have them done by ${d(10)}.` },
    { id: "s3", from: "Owner – Unit 9102", from_email: "owner9102@example.com", received: at(20), subject: "Dining chairs for our unit",
      text: `Hello, we'd like two additional dining chairs to match the set in The Cove building 91, room 9102. Needed by ${d(21)} for family visit.` },
    { id: "s4", from: "Pickleball Ops", from_email: "pb.ops@example.com", received: at(30), subject: "URGENT: shade sail ripped court 2",
      text: "The shade sail over Pickleball court 2 ripped in last night's wind. Building: Pavilion. Urgent, players are in the sun." },
    { id: "s5", from: "Cornerstone Clubhouse", from_email: "clubhouse@example.com", received: at(44), subject: "Cornerstone clubhouse bar stools",
      text: `Following up on the six bar stools in the Cornerstone clubhouse grill room, re-upholster by ${d(18)}. Tag FFE-CS-CH-021.` },
    { id: "s6", from: "Furniture Weekly", from_email: "news@example.com", received: at(50), subject: "This week's deals on patio sets",
      text: "Save 30% on our best-selling patio collections this week only." },
  ];
};

function statusFor(item) {
  if (item.project && item.project !== CURRENT.project) return { status: "other", label: `For ${item.project}` };
  const [t] = findMatches(item, S.requests.filter((r) => !["Rejected", "Cancelled"].includes(r.status)), 1);
  if (t && t.score >= DUP_THRESHOLD) return { status: "ticket", label: `Already ${ticketLabel(t.item.ticket_no)} · ${t.item.status}`, ref: t.item.id };
  const [e] = findMatches(item, S.emails.filter((x) => x.status !== "Dismissed"), 1);
  if (e && e.score >= DUP_THRESHOLD) return { status: "email", label: "Already in Email Requests" };
  return { status: "new", label: "Not in the system yet" };
}

async function readEmails(messages) {
  const rough = messages.map((m) => ({ ...m, f: parseEmailHeuristic({ subject: m.subject, text: m.text, hint: CURRENT.project }) }));
  let ai = null;
  if (store.mode === "cloud") {
    ol.step = "Reading emails with the AI assistant…";
    hooks.render();
    try {
      const candidates = rough.filter((m) => m.f.is_request || m.f.sub_project || m.f.ffe_tag).slice(0, 60);
      const res = await fetch(CONFIG.REPORT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await store.accessToken()}` },
        body: JSON.stringify({
          today: todayISO(),
          projects: SETTINGS.projects.filter((p) => !p.archived).map(({ name, subprojects, aliases }) => ({ name, subprojects, aliases })),
          emails: candidates.map((m) => ({ id: m.id, from: `${m.from} <${m.from_email}>`, received: m.received, subject: m.subject, text: m.text })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `AI unavailable (${res.status})`);
      ai = body;
    } catch (e) {
      console.warn("Report: AI unavailable, using built-in reader:", e.message);
    }
  }
  const byId = new Map((ai?.items || []).map((x) => [x.id, x]));
  const items = [];
  for (const m of rough) {
    const f = ai ? byId.get(m.id) : m.f;
    if (!f || !f.is_request) continue;
    const item = {
      id: m.id, from: m.from, from_email: m.from_email, received: m.received, subject: m.subject, link: m.link || "", text: m.text,
      project: f.project || "", sub_project: f.sub_project || "", buildings: f.buildings || "", rooms: f.rooms || "",
      item_needed: f.item_needed || m.subject, ffe_tag: f.ffe_tag || "", quantity: f.quantity || 1, priority: f.priority || "Normal",
      needed_by: f.needed_by || "", summary: f.summary || "",
    };
    items.push(item);
  }
  return { items, overview: ai?.overview || "", source: ai ? "ai" : "rules" };
}

function overviewText(r) {
  const soon = r.items.filter((i) => i.needed_by && i.needed_by <= addDaysISO(todayISO(), 7)).length;
  const urgent = r.items.filter((i) => ["Urgent", "High"].includes(i.priority)).length;
  const fresh = r.items.filter((i) => statusFor(i).status === "new").length;
  return `Found ${r.items.length} FF&E request${r.items.length === 1 ? "" : "s"} in ${r.scanned} email${r.scanned === 1 ? "" : "s"} from the last ${r.days} days. `
    + `${soon} ${soon === 1 ? "is" : "are"} needed within a week, ${urgent} marked urgent or high priority, and ${fresh} ${fresh === 1 ? "isn't" : "aren't"} in the system yet.`;
}

async function buildReport(sample = false) {
  ol.busy = true;
  ol.step = sample ? "Reading the sample inbox…" : "Fetching your recent emails from Outlook…";
  hooks.render();
  try {
    const messages = sample ? SAMPLE_INBOX() : await fetchMail(ol.days);
    const read = await readEmails(messages);
    ol.report = {
      generatedAt: new Date().toISOString(), days: ol.days, sample, scanned: messages.length,
      account: sample ? "Sample inbox" : ol.account?.username || "", ...read, sent: {},
    };
    try { localStorage.setItem(reportKey(), JSON.stringify(ol.report)); } catch { /* storage unavailable */ }
    toast(`Report ready: ${read.items.length} FF&E request${read.items.length === 1 ? "" : "s"} found`);
  } catch (e) {
    toast(e.message || "Couldn't build the report", "err");
  }
  ol.busy = false;
  ol.step = "";
  hooks.render();
}

function restore() {
  if (ol.loaded) return;
  ol.loaded = true;
  try { ol.report = JSON.parse(localStorage.getItem(reportKey()) || "null"); } catch { ol.report = null; }
  if (CONFIG.MS_CLIENT_ID) {
    msalApp().then((app) => {
      const a = app.getActiveAccount();
      if (a) { ol.account = { name: a.name, username: a.username }; hooks.render(); }
    }).catch(() => {});
  }
}

/* -------------------------------------------------------------------- page */
function connectCard() {
  const configured = !!CONFIG.MS_CLIENT_ID;
  if (ol.account) {
    return `<div class="card ol-connect">
      <div><h3>${icon("outlook")} Connected to Outlook</h3><p class="muted small">${esc(ol.account.name || "")} · ${esc(ol.account.username)}</p></div>
      <div class="btn-row">
        <label class="inline-label">Look back<select data-change="ol-days">${[7, 14, 30, 60].map((n) => opt(n, `${n} days`, ol.days === n)).join("")}</select></label>
        <button class="btn primary" data-act="ol-build" ${ol.busy ? "disabled" : ""}>${icon("report")} ${ol.report && !ol.report.sample ? "Refresh report" : "Build my report"}</button>
        <button class="btn small" data-act="ol-disconnect">Disconnect</button>
      </div></div>`;
  }
  return `<div class="card ol-connect" data-tour="outlook-connect">
    <div><h3>${icon("outlook")} Connect your Outlook</h3>
      <p class="muted small">Anyone can connect their own work mailbox. The app reads your recent inbox in your browser, picks out FF&amp;E requests,
      and shows what's coming up, including what's already a ticket and what isn't in the system yet. Nothing from your mailbox is saved
      unless you choose to send an email to Email Requests.</p>
      ${configured ? "" : `<p class="small notice">The Outlook connection hasn't been set up for this site yet. An administrator registers it with Microsoft once (about 10 minutes, steps in the README). Until then you can try the report with a sample inbox.</p>`}
    </div>
    <div class="btn-row">
      ${configured ? `<button class="btn primary" data-act="ol-connect">${icon("outlook")} Connect Outlook</button>` : ""}
      <button class="btn" data-act="ol-sample" ${ol.busy ? "disabled" : ""}>Try with a sample inbox</button>
    </div></div>`;
}

const STATUS_BADGE = { new: "pending", ticket: "approved", email: "inv", other: "proj", sent: "fulfilled" };

function reportHTML(r) {
  const today = todayISO();
  const items = r.items.map((i) => {
    const st = r.sent?.[i.id] ? { status: "sent", label: "Sent to Email Requests" } : statusFor(i);
    return { ...i, st };
  }).sort((a, b) => (a.needed_by || "9999").localeCompare(b.needed_by || "9999") || b.received.localeCompare(a.received));
  const n = (fn) => items.filter(fn).length;
  return `
  <div class="kpis">
    <div class="kpi"><span>FF&amp;E emails found</span><strong>${items.length}</strong></div>
    <div class="kpi ${n((i) => i.st.status === "new") ? "warn-soft" : ""}"><span>Not in the system yet</span><strong>${n((i) => i.st.status === "new")}</strong></div>
    <div class="kpi ${n((i) => i.needed_by && i.needed_by <= addDaysISO(today, 7)) ? "warn" : ""}"><span>Needed within 7 days</span><strong>${n((i) => i.needed_by && i.needed_by <= addDaysISO(today, 7))}</strong></div>
    <div class="kpi"><span>Urgent / high</span><strong>${n((i) => ["Urgent", "High"].includes(i.priority))}</strong></div>
    <div class="kpi"><span>Already tracked</span><strong>${n((i) => ["ticket", "email", "sent"].includes(i.st.status))}</strong></div>
  </div>
  <div class="card">
    <div class="card-head">
      <div><h3>${icon("report")} What's coming up</h3>
        <p class="muted small">${esc(r.account)} · last ${r.days} days · built ${esc(new Date(r.generatedAt).toLocaleString())} · ${r.source === "ai" ? "read by the AI assistant" : "read with the built-in reader"}</p></div>
      <div class="btn-row"><button class="btn small" data-act="ol-copy">Copy summary</button><button class="btn small" data-act="ol-export">${icon("download")} Excel</button></div>
    </div>
    <p class="ol-overview">${esc(r.overview || overviewText(r))}</p>
  </div>
  <div class="card flush">${items.length ? `<div class="table-wrap"><table class="grid">
    <thead><tr><th>Desired delivery</th><th>Where</th><th>What</th><th>From</th><th>Status</th><th></th></tr></thead>
    <tbody>${items.map((i) => `<tr>
      <td data-label="Desired delivery" class="nowrap ${i.needed_by && i.needed_by < today ? "overdue" : ""}">${i.needed_by ? esc(fmtDate(i.needed_by)) : '<span class="muted">No date</span>'}
        ${i.priority !== "Normal" ? `<div>${badge(i.priority, `p-${i.priority.toLowerCase()}`)}</div>` : ""}</td>
      <td data-label="Where"><strong>${esc(i.sub_project || i.project || "—")}</strong>${i.project && i.sub_project ? `<div class="muted tiny">${esc(i.project)}</div>` : ""}
        <div class="muted small">${[i.buildings && `Bldg ${i.buildings}`, i.rooms && `Rm ${i.rooms}`].filter(Boolean).map(esc).join(" · ")}</div></td>
      <td data-label="What">${esc(i.item_needed)}${i.ffe_tag ? `<div class="mono muted small">${esc(i.ffe_tag)}</div>` : ""}${i.quantity > 1 ? `<div class="muted small">Qty ${esc(i.quantity)}</div>` : ""}</td>
      <td data-label="From" class="small">${esc(i.from || i.from_email)}<div class="muted tiny">${esc(new Date(i.received).toLocaleDateString())} · ${esc(i.subject)}</div></td>
      <td data-label="Status">${badge(i.st.label, STATUS_BADGE[i.st.status])}</td>
      <td class="row-actions">
        ${i.st.ref ? `<button class="btn small" data-act="open-request" data-id="${esc(i.st.ref)}">Open</button>` : ""}
        ${i.st.status === "new" ? `<button class="btn small primary" data-act="ol-send" data-id="${esc(i.id)}">Send to Email Requests</button>` : ""}
        ${i.link ? `<a class="btn small" href="${esc(i.link)}" target="_blank" rel="noopener">Outlook ↗</a>` : ""}
      </td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">No FF&amp;E requests found in these emails.</div>`}</div>`;
}

export function pageOutlook() {
  restore();
  return `
  ${connectCard()}
  ${ol.busy ? `<div class="card busy"><span class="spinner"></span> ${esc(ol.step)}</div>` : ""}
  ${ol.report ? reportHTML(ol.report) : ""}`;
}

function summaryText(r) {
  const lines = r.items.map((i) => {
    const st = r.sent?.[i.id] ? "sent to Email Requests" : statusFor(i).label;
    return `- ${i.needed_by ? fmtDate(i.needed_by) : "No date"} | ${i.sub_project || i.project || "?"} | ${i.item_needed}${i.rooms ? ` (Rm ${i.rooms})` : ""} | from ${i.from || i.from_email} | ${st}`;
  });
  return `FF&E report – ${new Date(r.generatedAt).toLocaleDateString()}\n${r.overview || overviewText(r)}\n\n${lines.join("\n")}`;
}

/* ---------------------------------------------------------------- handlers */
export const CLICK = {
  async "ol-connect"() {
    const app = await guard(msalApp);
    if (!app) return;
    const res = await guard(() => app.loginPopup({ scopes: SCOPES, prompt: "select_account" }));
    if (!res?.account) return;
    app.setActiveAccount(res.account);
    ol.account = { name: res.account.name, username: res.account.username };
    toast("Outlook connected");
    buildReport(false);
  },
  async "ol-disconnect"() {
    const app = await guard(msalApp);
    const account = app?.getActiveAccount();
    if (account) await guard(() => app.logoutPopup({ account, mainWindowRedirectUri: location.href }));
    ol.account = null;
    hooks.render();
  },
  "ol-build"() { buildReport(false); },
  "ol-sample"() { buildReport(true); },
  async "ol-send"(el) {
    const r = ol.report;
    const i = r.items.find((x) => x.id === el.dataset.id);
    el.disabled = true;
    const e = await guard(() => store.submitEmail({ from_name: i.from, from_email: i.from_email, subject: i.subject, text: i.text }));
    if (!e) { el.disabled = false; return; }
    r.sent = { ...r.sent, [i.id]: e.id };
    try { localStorage.setItem(reportKey(), JSON.stringify(r)); } catch { /* storage unavailable */ }
    S.emails = await store.listEmailRequests();
    hooks.render();
    toast(e.status === "Duplicate" ? "Sent, and it matched an existing ticket" : "Sent to Email Requests for review");
  },
  async "ol-copy"() {
    try { await navigator.clipboard.writeText(summaryText(ol.report)); toast("Summary copied, ready to paste into an email or Teams"); }
    catch { toast("Couldn't copy here; use Excel export instead", "err"); }
  },
  "ol-export"() {
    const r = ol.report;
    const rows = r.items.map((i) => ({ ...i, status: r.sent?.[i.id] ? "Sent to Email Requests" : statusFor(i).label, received: (i.received || "").slice(0, 10) }));
    const cols = [
      ["needed_by", "Desired Delivery"], ["priority", "Priority"], ["project", "Project"], ["sub_project", "Sub-project"], ["buildings", "Building(s)"],
      ["rooms", "Room(s)"], ["item_needed", "What's Needed"], ["ffe_tag", "FF&E Tag"], ["quantity", "Qty"], ["from", "From"],
      ["from_email", "From Email"], ["received", "Received"], ["subject", "Subject"], ["status", "Status"],
    ].map(([key, label]) => ({ key, label }));
    downloadWorkbook(`My Outlook FF&E Report ${todayISO()}`, [{ name: "Coming Up", columns: cols, rows }]);
  },
};

export const CHANGE = {
  "ol-days"(el) { ol.days = Number(el.value); },
};

export const pages = { outlook: pageOutlook };
