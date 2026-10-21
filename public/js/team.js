// Team & Roles (managers only): invite people by email, change roles, remove access.
import { store } from "./store.js";
import { S, ROLE_LABEL, hooks } from "./state.js";
import { esc, opt, fmtDate, toast, guard, icon, initials } from "./ui.js";

export function pageTeam() {
  const people = [...S.profiles].sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
  const count = (role) => people.filter((p) => p.role === role).length;
  return `
  <div class="card">
    <h3>${icon("userplus")} Invite someone</h3>
    <p class="muted small">They get an email with a link to set their password and sign in.${store.mode === "demo" ? " (Demo mode: no email is sent; they're added to the sign-in list.)" : ""}</p>
    <form class="invite-form" data-form="team-invite">
      <label>Full name<input name="full_name" required autocomplete="off" placeholder="e.g. Sam Patel"></label>
      <label>Work email<input name="email" type="email" required autocomplete="off" placeholder="name@company.com"></label>
      <label>Role<select name="role">${Object.entries(ROLE_LABEL).map(([k, l]) => opt(k, l, k === "owner_relations")).join("")}</select></label>
      <button class="btn primary" type="submit">Send invite</button>
    </form>
  </div>
  <p class="muted small"><b>Managers</b> approve requests, review emailed requests, manage inventory and the team (${count("manager")}). <b>Owner Relations</b> see everything, submit requests, take stock out and keep their own action items (${count("owner_relations")}).</p>
  <div class="card flush"><div class="table-wrap"><table class="grid">
    <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Requests</th><th></th></tr></thead>
    <tbody>${people.map((p) => {
      const me = p.id === S.me.id;
      return `<tr>
        <td data-label="Person"><div class="person"><span class="avatar sm">${esc(initials(p.full_name || p.email))}</span>
          <div><strong>${esc(p.full_name || "—")}</strong>${me ? ' <span class="muted small">(you)</span>' : ""}<div class="muted small">${esc(p.email || "")}</div></div></div></td>
        <td data-label="Role">${me ? esc(ROLE_LABEL[p.role]) : `<select data-change="set-role" data-id="${esc(p.id)}" aria-label="Role">${Object.entries(ROLE_LABEL).map(([k, l]) => opt(k, l, p.role === k)).join("")}</select>`}</td>
        <td data-label="Status" class="small muted">${p.invited_at ? `Invited ${esc(fmtDate(p.invited_at.slice(0, 10)))}` : `Joined ${esc(fmtDate((p.created_at || "").slice(0, 10)))}`}</td>
        <td data-label="Requests">${S.requests.filter((r) => r.requested_by === p.id).length}</td>
        <td class="row-actions">${me ? "" : `
          ${p.invited_at ? `<button class="btn small" data-act="team-resend" data-id="${esc(p.id)}">Resend invite</button>` : ""}
          <button class="btn small reject" data-act="team-remove" data-id="${esc(p.id)}">Remove</button>`}</td>
      </tr>`;
    }).join("")}</tbody></table></div></div>`;
}

async function refresh() {
  S.profiles = await store.listProfiles();
  hooks.render();
}

export const CLICK = {
  async "team-remove"(el) {
    const p = S.profiles.find((x) => x.id === el.dataset.id);
    if (!confirm(`Remove ${p.full_name || p.email}? They lose access right away. Requests they submitted stay on record.`)) return;
    const ok = await guard(() => store.removeUser(p.id), `${p.full_name || p.email} removed`);
    if (ok) await guard(refresh);
  },
  async "team-resend"(el) {
    const p = S.profiles.find((x) => x.id === el.dataset.id);
    await guard(() => store.inviteUser({ email: p.email, full_name: p.full_name, role: p.role }), `Invite re-sent to ${p.email}`);
  },
};

export const CHANGE = {
  async "set-role"(el) {
    const saved = await guard(() => store.setRole(el.dataset.id, el.value), "Role updated");
    if (saved) S.profiles = S.profiles.map((p) => (p.id === saved.id ? saved : p));
  },
};

export const SUBMIT = {
  async "team-invite"(form) {
    const fd = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const res = await guard(() => store.inviteUser({ email: fd.email.trim(), full_name: fd.full_name.trim(), role: fd.role }));
    btn.disabled = false;
    if (!res) return;
    toast(res.demo ? `${fd.full_name} added (demo mode, no email sent)` : `Invite sent to ${fd.email}`);
    await guard(refresh);
  },
};

export const pages = { team: pageTeam };
