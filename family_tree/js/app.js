// app.js — entry point: capability/mode detection, wiring, detail + issues panels.

import { Store, lifespan, lifespanYears } from "./store.js";
import { TreeRenderer } from "./render.js";
import { validate } from "./validate.js";
import { Editor } from "./edit.js";
import { setupPrint } from "./print.js";

const store = new Store();
let renderer = null;
let editor = null;
let editMode = false;
let focusedId = null; // person whose branch is currently shown (null = everyone)

// On the deployed host, editing can't persist anywhere useful → view-only.
const DEPLOYED_HOSTS = [/\.github\.io$/i, /(^|\.)dhanani94\.com$/i];
const isDeployed = DEPLOYED_HOSTS.some((re) => re.test(location.hostname));
const canDirectSave = Store.canDirectSave() && !isDeployed;

const el = (id) => document.getElementById(id);

async function main() {
  wireToolbar();

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
  const print = setupPrint(renderer, el("tree"));
  el("btn-print").addEventListener("click", print);

  // Re-render + re-validate whenever the model changes.
  store.onChange(() => updateDirtyIndicator());

  resetFocus();
  // Defer the initial fit until the SVG has its real layout dimensions.
  requestAnimationFrame(() => renderer.resetToFit(false));

  // Edit controls are only meaningful off the deployed host.
  el("btn-edit-mode").hidden = isDeployed;
  el("save-controls").hidden = isDeployed;
  el("btn-save").hidden = !canDirectSave;

  window.addEventListener("resize", () => renderer && renderer.resetToFit(false));
  window.addEventListener("keydown", onKeydown);
}

// --- rendering pipeline -----------------------------------------------------
function refresh() {
  // If the focused person was deleted, fall back to the default view.
  if (focusedId && !store.has(focusedId)) { resetFocus(); return; }
  // Recompute branch roots in case ancestry changed since the last focus.
  renderer.focusRoots = focusedId ? store.getAncestorRoots(focusedId) : null;
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
// Show one person's "side" of the family: their topmost ancestors and everyone
// descending from them (the person plus their aunts, uncles, cousins, etc.).
function focusOn(id) {
  if (!store.has(id)) return;
  focusedId = id;
  renderer.setFocus(store.getAncestorRoots(id));
  renderer.select(id);
  renderer.centerOn(id);
  runValidation();
  updateFocusBar();
}

// Return to the default branch (meta.rootId), or the full tree if none set.
function resetFocus() {
  const rootId = store.meta.rootId;
  if (rootId && store.has(rootId)) {
    focusedId = rootId;
    renderer.setFocus(store.getAncestorRoots(rootId));
  } else {
    focusedId = null;
    renderer.setFocus(null);
  }
  runValidation();
  updateFocusBar();
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
  if (focusedId && store.has(focusedId)) {
    el("focus-label").textContent = `${store.get(focusedId).name}’s side`;
    bar.hidden = false;
    // Reset is only meaningful when we've moved off the default view.
    el("btn-reset").hidden = focusedId === store.meta.rootId;
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

  el("btn-edit-mode").addEventListener("click", toggleEditMode);
  el("btn-add").addEventListener("click", () => editor.openNew());

  el("btn-export").addEventListener("click", () => store.exportDownload());
  el("btn-save").addEventListener("click", onSave);

  el("btn-import").addEventListener("click", () => el("import-file").click());
  el("import-file").addEventListener("change", onImport);

  el("issues-header").addEventListener("click", () =>
    el("issues").classList.toggle("collapsed"));
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

async function onImport(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    await store.importFromFile(file);
    resetFocus();
    renderer.resetToFit(false);
    flash("Imported");
  } catch (err) {
    alert("Import failed: " + err.message);
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