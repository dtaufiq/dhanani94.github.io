// app.js — entry point: capability/mode detection, wiring, detail + issues panels.

import { Store, lifespan, lifespanYears } from "./store.js";
import { TreeRenderer } from "./render.js";
import { validate } from "./validate.js";
import { Editor } from "./edit.js";
import { loadConfig, applyConfig } from "./config.js";

const store = new Store();
let renderer = null;
let editor = null;
let editMode = false;
let focusApexId = null; // topmost ancestor defining the side in view (null = everyone)

// On the deployed host, editing can't persist anywhere useful → view-only.
const DEPLOYED_HOSTS = [/\.github\.io$/i, /(^|\.)dhanani94\.com$/i];
const isDeployed = DEPLOYED_HOSTS.some((re) => re.test(location.hostname));
const canDirectSave = Store.canDirectSave() && !isDeployed;

const el = (id) => document.getElementById(id);

async function main() {
  wireToolbar();

  // Apply runtime settings (e.g. the aged-photo filter) in parallel with the
  // data load. Optional + non-fatal, so it never blocks or breaks startup.
  loadConfig().then(applyConfig);

  try {
    await store.load();
  } catch (err) {
    showFatal(err.message);
    return;
  }

  renderer = new TreeRenderer(el("tree"), store, {
    onSelect: handleSelect,
    onFocus: focusOn,
    onRender: updateViewCount,
  });
  editor = new Editor(store, { onAfterChange: onEditorChange });

  // Re-render + re-validate whenever the model changes.
  store.onChange(() => updateDirtyIndicator());

  // Honour a shared deep-link (#side=<id>) if present, else the default side.
  applyFocusFromHash();
  // Defer the initial fit until the SVG has its real layout dimensions.
  requestAnimationFrame(() => renderer.resetToFit(false));

  // Edit controls are only meaningful off the deployed host.
  el("btn-edit-mode").hidden = isDeployed;
  el("save-controls").hidden = isDeployed;
  el("btn-save").hidden = !canDirectSave;

  window.addEventListener("resize", () => renderer && renderer.resetToFit(false));
  window.addEventListener("keydown", onKeydown);
  // React to the URL changing (pasted link in this tab, manual edit).
  window.addEventListener("hashchange", applyFocusFromHash);
}

// --- rendering pipeline -----------------------------------------------------
function refresh() {
  // If the focused apex was deleted, fall back to the default view.
  if (focusApexId && !store.has(focusApexId)) { resetFocus(); return; }
  // Re-climb in case a parent was added above the apex since we last focused.
  if (focusApexId) focusApexId = store.getLineageApex(focusApexId);
  renderer.focusRoots = focusApexId ? [focusApexId] : null;
  renderer.render();
  runValidation();
}

// After an add/edit: re-render, mark dirty, and select the affected person so
// the new node is highlighted and its detail panel is shown.
function onEditorChange(id) {
  refresh();
  markDirty();
  if (id && store.has(id)) {
    renderer.select(id);
    handleSelect(id);
    renderer.centerOn(id);
  }
}

// --- branch focus -----------------------------------------------------------
// Show one side of `id`'s family: climb a single parent line to the apex and
// render that apex couple's descendants (id plus their aunts, uncles, cousins
// on that side). The clicked person stays selected so you can find them.
function focusOn(id) {
  if (!store.has(id)) return;
  focusApexId = store.getLineageApex(id);
  renderer.setFocus([focusApexId]);
  renderer.select(id);
  renderer.centerOn(id);
  runValidation();
  updateFocusBar();
  updateHash();
}

// Return to the default side (meta.rootId's lineage), or the full tree if none.
function resetFocus() {
  const rootId = store.meta.rootId;
  if (rootId && store.has(rootId)) {
    focusApexId = store.getLineageApex(rootId);
    renderer.setFocus([focusApexId]);
  } else {
    focusApexId = null;
    renderer.setFocus(null);
  }
  runValidation();
  updateFocusBar();
  updateHash();
}

// --- shareable deep-link (#side=<id>) ---------------------------------------
function defaultApex() {
  const rootId = store.meta.rootId;
  return rootId && store.has(rootId) ? store.getLineageApex(rootId) : null;
}

function hashFocusId() {
  const m = /[#&]side=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

// Reflect the current side into the URL (omit it when on the default side so a
// plain link still works). replaceState updates the bar without a hashchange.
function updateHash() {
  const wanted = focusApexId && focusApexId !== defaultApex()
    ? "#side=" + encodeURIComponent(focusApexId)
    : "";
  if ((location.hash || "") !== wanted) {
    history.replaceState(null, "", location.pathname + location.search + wanted);
  }
}

// Apply whatever the URL asks for: a shared id is climbed to its apex (so any
// person on a side yields that side); an absent/invalid id shows the default.
function applyFocusFromHash() {
  const id = hashFocusId();
  if (id && store.has(id)) {
    const apex = store.getLineageApex(id);
    if (apex === focusApexId) return;
    focusApexId = apex;
    renderer.setFocus([apex]);
    runValidation();
    updateFocusBar();
  } else if (focusApexId !== defaultApex()) {
    resetFocus();
  }
}

function shareLink() {
  updateHash();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(location.href)
      .then(() => flash("Link to this view copied"))
      .catch(() => flash("Copy the link from the address bar"));
  } else {
    flash("Copy the link from the address bar");
  }
}

// Show how many people are visible in the current view.
function updateViewCount(count) {
  const total = store.all().length;
  const elc = el("view-count");
  if (!elc) return;
  elc.textContent = count === total
    ? `${count} people`
    : `${count} of ${total} people`;
}

function updateFocusBar() {
  const bar = el("focus-bar");
  if (focusApexId && store.has(focusApexId)) {
    // The "side" is named after the topmost ancestor (the apex) in view.
    el("focus-label").textContent = `${store.get(focusApexId).name}’s side`;
    bar.hidden = false;
    // Reset is only meaningful when we've moved off the default side.
    const rootId = store.meta.rootId;
    const defaultApex = rootId && store.has(rootId) ? store.getLineageApex(rootId) : null;
    el("btn-reset").hidden = focusApexId === defaultApex;
  } else {
    bar.hidden = true;
  }
}

function runValidation() {
  const issues = validate(store);
  const panel = el("issues");
  const list = el("issues-list");
  const badge = el("issues-count");
  list.innerHTML = "";

  if (!issues.length) {
    panel.classList.add("clean");
    badge.textContent = "0";
    el("issues-summary").textContent = "No issues";
    return;
  }
  panel.classList.remove("clean");
  const errors = issues.filter((i) => i.level === "error").length;
  badge.textContent = String(issues.length);
  el("issues-summary").textContent =
    `${issues.length} issue${issues.length > 1 ? "s" : ""}` +
    (errors ? ` (${errors} error${errors > 1 ? "s" : ""})` : "");

  for (const issue of issues) {
    const li = document.createElement("li");
    li.className = `issue ${issue.level}`;
    const span = document.createElement("span");
    span.textContent = issue.message;
    li.appendChild(span);
    if (issue.fix && editMode) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fix-btn";
      btn.textContent = "Auto-fix";
      btn.addEventListener("click", () => { issue.fix(store); refresh(); markDirty(); });
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

// --- selection + detail panel ----------------------------------------------
function handleSelect(id) {
  const panel = el("detail");
  if (!id) { panel.hidden = true; return; }
  const p = store.get(id);
  if (!p) { panel.hidden = true; return; }

  el("d-name").textContent = p.name;
  el("d-dates").textContent = lifespan(p) || "—";

  const photo = el("d-photo");
  if (p.photo) { photo.src = p.photo; photo.alt = `Photo of ${p.name}`; photo.hidden = false; }
  else { photo.hidden = true; photo.removeAttribute("src"); }

  const fields = el("d-fields");
  fields.innerHTML = "";
  addField(fields, "Maiden name", p.maidenName);
  addField(fields, "Gender", p.gender);
  addField(fields, "Notes", p.notes);

  renderRelations("d-parents", store.getParents(id));
  renderRelations("d-spouses", store.getSpouses(id));
  renderRelations("d-children", store.getChildren(id));

  el("d-focus").onclick = () => focusOn(id);

  el("d-edit").hidden = !editMode;
  el("d-edit").onclick = () => editor.openEdit(id);

  // Quick-add shortcuts (edit mode). "Add child" prefills the parent couple;
  // "Add spouse" prefills the spouse and only shows when there isn't one yet.
  const addChildBtn = el("d-add-child");
  addChildBtn.hidden = !editMode;
  addChildBtn.onclick = () => {
    const parents = [id, ...store.get(id).spouses].slice(0, 2);
    editor.openNewWith({ title: `Add child of ${p.name}`, parents });
  };

  const addSpouseBtn = el("d-add-spouse");
  addSpouseBtn.hidden = !editMode || store.get(id).spouses.length > 0;
  addSpouseBtn.onclick = () => editor.openNewWith({ title: `Add spouse of ${p.name}`, spouses: [id] });

  // "Set as default" (edit mode): make this person the branch shown on reset.
  const setRootBtn = el("d-setroot");
  setRootBtn.hidden = !editMode;
  setRootBtn.classList.toggle("is-default", store.meta.rootId === id);
  setRootBtn.textContent = store.meta.rootId === id ? "✓ Default branch" : "Set as default";
  setRootBtn.onclick = () => {
    store.setRootId(id);
    markDirty();
    updateFocusBar();
    handleSelect(id); // refresh button label
    flash("Default branch set");
  };

  panel.hidden = false;
}

function addField(container, label, value) {
  if (!value) return;
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  container.appendChild(dt);
  container.appendChild(dd);
}

// Relationship quick-links: jump + center the tree on that person.
function renderRelations(containerId, people) {
  const ul = el(containerId);
  ul.innerHTML = "";
  if (!people.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "—";
    ul.appendChild(li);
    return;
  }
  for (const person of people) {
    const li = document.createElement("li");
    const a = document.createElement("button");
    a.type = "button";
    a.className = "link";
    a.textContent = `${person.name} ${lifespanYears(person)}`.trim();
    a.addEventListener("click", () => { renderer.select(person.id); renderer.centerOn(person.id); });
    li.appendChild(a);
    ul.appendChild(li);
  }
}

// --- toolbar wiring ---------------------------------------------------------
function wireToolbar() {
  el("btn-zoom-in").addEventListener("click", () => renderer.zoomBy(1.3));
  el("btn-zoom-out").addEventListener("click", () => renderer.zoomBy(1 / 1.3));
  el("btn-zoom-fit").addEventListener("click", () => renderer.resetToFit(true));
  el("btn-reset").addEventListener("click", () => resetFocus());
  el("btn-share").addEventListener("click", () => shareLink());
  setupSearch();

  el("btn-edit-mode").addEventListener("click", toggleEditMode);
  el("btn-add").addEventListener("click", () => editor.openNew());

  el("btn-export").addEventListener("click", () => store.exportDownload());
  el("btn-save").addEventListener("click", onSave);

  el("issues-header").addEventListener("click", () =>
    el("issues").classList.toggle("collapsed"));
}

// --- person search (autocomplete → focus mode) ------------------------------
function setupSearch() {
  const btn = el("btn-search");
  const pop = el("search-pop");
  const input = el("search-input");
  const list = el("search-results");
  let results = []; // {id,name,...} currently shown
  let active = -1;

  function open() {
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-expanded", "true");
    input.value = "";
    render("");
    input.focus();
  }
  function close() {
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-expanded", "false");
    active = -1;
  }
  function choose(id) { close(); focusOn(id); }

  function render(query) {
    const q = query.trim().toLowerCase();
    results = store.all()
      .filter((p) => q && (p.name || "").toLowerCase().includes(q))
      .sort((a, b) => {
        const an = (a.name || "").toLowerCase(), bn = (b.name || "").toLowerCase();
        const rank = (n) => (n.startsWith(q) ? 0 : 1);
        return rank(an) - rank(bn) || an.localeCompare(bn);
      })
      .slice(0, 8);
    active = results.length ? 0 : -1;

    list.innerHTML = "";
    if (!results.length) {
      const li = document.createElement("li");
      li.className = "sr-empty";
      li.textContent = q ? "No matches" : "Type a name…";
      list.appendChild(li);
      return;
    }
    results.forEach((p, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.classList.toggle("active", i === active);
      const name = document.createElement("span");
      name.className = "sr-name";
      name.textContent = p.name || "(no name)";
      const dates = document.createElement("span");
      dates.className = "sr-dates";
      dates.textContent = lifespan(p);
      li.append(name, dates);
      // mousedown (not click) so the choice lands before the input blurs.
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(p.id); });
      list.appendChild(li);
    });
  }

  function setActive(i) {
    const items = [...list.querySelectorAll('li[role="option"]')];
    if (!items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((el, idx) => el.classList.toggle("active", idx === active));
    items[active].scrollIntoView({ block: "nearest" });
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let the document handler immediately re-close
    pop.hidden ? open() : close();
  });
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[active]) choose(results[active].id); }
    else if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); }
  });
  // Click anywhere outside the popover (or its button) closes it.
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close();
  });
}

function toggleEditMode() {
  editMode = !editMode;
  document.body.classList.toggle("edit-mode", editMode);
  el("btn-edit-mode").setAttribute("aria-pressed", String(editMode));
  el("btn-edit-mode").textContent = editMode ? "Editing — done" : "Edit mode";
  el("btn-add").hidden = !editMode;
  // Re-render so detail-panel edit affordances + auto-fix buttons update.
  if (renderer.selectedId) handleSelect(renderer.selectedId);
  runValidation();
}

async function onSave() {
  try {
    await store.saveToDisk();
    flash("Saved to disk");
  } catch (err) {
    if (err && err.name === "AbortError") return; // user cancelled the picker
    alert("Save failed: " + err.message);
  }
}

// --- dirty indicator --------------------------------------------------------
function markDirty() { store.dirty = true; updateDirtyIndicator(); }
function updateDirtyIndicator() {
  const ind = el("dirty");
  ind.hidden = !store.dirty || isDeployed;
}

// --- misc -------------------------------------------------------------------
function onKeydown(e) {
  if (e.key === "Escape") {
    if (editor && editor.dialog.open) return; // <dialog> handles its own Esc
    el("detail").hidden = true;
    if (renderer) renderer.select(null);
  }
}

function flash(msg) {
  const f = el("flash");
  f.textContent = msg;
  f.classList.add("show");
  setTimeout(() => f.classList.remove("show"), 1800);
}

function showFatal(msg) {
  const box = el("fatal");
  el("fatal-msg").textContent = msg;
  box.hidden = false;
}

main();