// Settings (managers): projects, sub-projects, other names for each project, and
// the option lists used in forms.
import { store } from "./store.js";
import { SETTINGS, OPTION_LISTS, applySettings } from "./fields.js";
import { S, hooks } from "./state.js";
import { esc, toast, guard, icon } from "./ui.js";
import { openProject } from "./projects.js";

const usage = (name) => ({
  requests: (S.summary?.requests || []).filter((r) => r.project === name).length,
  inventory: (S.summary?.inventory || []).filter((i) => i.project === name).length,
});

export function pageSettings() {
  return `
  <div class="card">
    <h3>${icon("settings")} Projects &amp; sub-projects</h3>
    <p class="muted small">Projects are the resorts people choose after signing in (e.g. Black Desert Resort). Sub-projects are the areas inside each one (e.g. The Terrace, Waterpark) and appear in every form, filter and report for that project.
    <b>Other names</b> help the app recognize a project in emails (e.g. “BDR”).</p>
    <div class="proj-list-edit">${SETTINGS.projects.map((p, i) => {
      const u = usage(p.name);
      return `
      <div class="proj-edit ${p.archived ? "archived" : ""}">
        <div class="proj-edit-head">
          <input class="proj-name" value="${esc(p.name)}" data-change="set-proj-name" data-idx="${i}" aria-label="Project name">
          <span class="muted small nowrap">${u.requests} request${u.requests === 1 ? "" : "s"} · ${u.inventory} item${u.inventory === 1 ? "" : "s"}</span>
          <span class="grow"></span>
          <button class="icon-btn" data-act="set-proj-move" data-idx="${i}" data-dir="-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="icon-btn" data-act="set-proj-move" data-idx="${i}" data-dir="1" aria-label="Move down" ${i === SETTINGS.projects.length - 1 ? "disabled" : ""}>↓</button>
          ${u.requests || u.inventory
            ? `<button class="btn small" data-act="set-proj-archive" data-idx="${i}">${p.archived ? "Restore" : "Archive"}</button>`
            : `<button class="btn small reject" data-act="set-proj-remove" data-idx="${i}">Remove</button>`}
        </div>
        ${p.archived ? '<p class="muted small">Archived: hidden from new requests and filters; existing records keep it.</p>' : ""}
        <div class="sub-row">
          <span class="muted small">Sub-projects</span>
          ${(p.subprojects || []).map((sp, j) => `<span class="tag"><button class="link-btn" data-act="set-sub-rename" data-idx="${i}" data-sub="${j}" title="Rename">${esc(sp)}</button><button class="tag-x" data-act="set-sub-remove" data-idx="${i}" data-sub="${j}" aria-label="Remove ${esc(sp)}">✕</button></span>`).join("")}
          <form class="inline-add" data-form="set-sub-add" data-idx="${i}"><input name="value" placeholder="Add sub-project" aria-label="New sub-project"><button class="btn small" type="submit">Add</button></form>
        </div>
        <label class="alias-row">Other names <span class="muted">(comma separated)</span>
          <input value="${esc((p.aliases || []).join(", "))}" data-change="set-proj-aliases" data-idx="${i}" placeholder="e.g. RC, Rec Center"></label>
      </div>`;
    }).join("")}</div>
    <form class="inline-add big" data-form="set-proj-add"><input name="value" placeholder="New project name" aria-label="New project name"><button class="btn primary" type="submit">${icon("new")} Add project</button></form>
  </div>

  ${Object.entries(OPTION_LISTS).map(([key, label]) => `
  <div class="card">
    <h3>${esc(label)}</h3>
    <div class="sub-row">
      ${(SETTINGS.options[key] || []).map((v, j) => `<span class="tag">${esc(v)}<button class="tag-x" data-act="set-opt-remove" data-list="${key}" data-idx="${j}" aria-label="Remove ${esc(v)}">✕</button></span>`).join("") || '<span class="muted small">None yet.</span>'}
      <form class="inline-add" data-form="set-opt-add" data-list="${key}"><input name="value" placeholder="Add option" aria-label="New option"><button class="btn small" type="submit">Add</button></form>
    </div>
  </div>`).join("")}`;
}

async function save(mutate, msg) {
  const next = structuredClone({ projects: SETTINGS.projects, options: SETTINGS.options });
  if (mutate(next) === false) return false;
  const saved = await guard(() => store.saveSettings(next), msg);
  if (!saved) { hooks.render(); return false; }
  applySettings(saved);
  hooks.render();
  return true;
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const exists = (list, v) => list.some((x) => x.toLowerCase() === v.toLowerCase());

async function reloadRecords() {
  await hooks.reload();
}

export const CLICK = {
  "set-proj-move"(el) {
    const i = Number(el.dataset.idx), j = i + Number(el.dataset.dir);
    save((s) => { [s.projects[i], s.projects[j]] = [s.projects[j], s.projects[i]]; });
  },
  "set-proj-archive"(el) {
    const i = Number(el.dataset.idx);
    save((s) => { s.projects[i].archived = !s.projects[i].archived; }, SETTINGS.projects[i].archived ? "Project restored" : "Project archived");
  },
  "set-proj-remove"(el) {
    const i = Number(el.dataset.idx);
    if (!confirm(`Remove ${SETTINGS.projects[i].name}?`)) return;
    save((s) => { s.projects.splice(i, 1); }, "Project removed");
  },
  async "set-sub-rename"(el) {
    const i = Number(el.dataset.idx), j = Number(el.dataset.sub);
    const p = SETTINGS.projects[i];
    const old = p.subprojects[j];
    const name = clean(prompt(`Rename sub-project “${old}”:`, old));
    if (!name || name === old) return;
    if (exists(p.subprojects.filter((_, k) => k !== j), name)) { toast("That sub-project already exists", "err"); return; }
    const ok = await guard(async () => { await store.renameProject(p.name, p.name, old, name); return true; });
    if (!ok) return;
    await save((s) => { s.projects[i].subprojects[j] = name; }, "Sub-project renamed");
    await guard(reloadRecords);
    hooks.render();
  },
  "set-sub-remove"(el) {
    const i = Number(el.dataset.idx), j = Number(el.dataset.sub);
    save((s) => { s.projects[i].subprojects.splice(j, 1); }, "Sub-project removed (existing records keep it)");
  },
  "set-opt-remove"(el) {
    save((s) => { s.options[el.dataset.list].splice(Number(el.dataset.idx), 1); });
  },
};

export const CHANGE = {
  async "set-proj-name"(el) {
    const i = Number(el.dataset.idx);
    const old = SETTINGS.projects[i].name;
    const name = clean(el.value);
    if (!name || name === old) { el.value = old; return; }
    if (exists(SETTINGS.projects.filter((_, k) => k !== i).map((p) => p.name), name)) { toast("A project with that name already exists", "err"); el.value = old; return; }
    const u = usage(old);
    if ((u.requests || u.inventory) && !confirm(`Rename “${old}” to “${name}”? This updates ${u.requests} request(s) and ${u.inventory} inventory item(s).`)) { el.value = old; return; }
    const ok = await guard(async () => { await store.renameProject(old, name); return true; });
    if (!ok) { el.value = old; return; }
    await save((s) => { s.projects[i].name = name; }, "Project renamed");
    if (S.project === old) await openProject(name);
    await guard(reloadRecords);
    hooks.render();
  },
  "set-proj-aliases"(el) {
    const i = Number(el.dataset.idx);
    save((s) => { s.projects[i].aliases = el.value.split(",").map(clean).filter(Boolean); }, "Saved");
  },
};

export const SUBMIT = {
  "set-proj-add"(form) {
    const name = clean(form.querySelector("input").value);
    if (!name) return;
    if (exists(SETTINGS.projects.map((p) => p.name), name)) { toast("That project already exists", "err"); return; }
    save((s) => { s.projects.push({ name, subprojects: [], aliases: [], archived: false }); }, `${name} added`);
  },
  "set-sub-add"(form) {
    const i = Number(form.dataset.idx);
    const name = clean(form.querySelector("input").value);
    if (!name) return;
    if (exists(SETTINGS.projects[i].subprojects || [], name)) { toast("That sub-project already exists", "err"); return; }
    save((s) => { s.projects[i].subprojects = [...(s.projects[i].subprojects || []), name]; }, "Sub-project added");
  },
  "set-opt-add"(form) {
    const key = form.dataset.list;
    const v = clean(form.querySelector("input").value);
    if (!v) return;
    if (exists(SETTINGS.options[key] || [], v)) { toast("Already in the list", "err"); return; }
    save((s) => { s.options[key] = [...(s.options[key] || []), v]; });
  },
};

export const pages = { settings: pageSettings };
