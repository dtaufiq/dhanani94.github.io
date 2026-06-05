// edit.js — CRUD UI, relationship pickers (select existing people by name),
// and delete-with-cleanup. The user never types raw IDs; relationships are
// chosen from search dropdowns over existing people. Setting a parent on a
// child is the canonical action — derived children update automatically.

import { referencesTo } from "./validate.js";
import { lifespan } from "./store.js";

export class Editor {
  constructor(store, { onAfterChange } = {}) {
    this.store = store;
    this.onAfterChange = onAfterChange || (() => {});
    this.dialog = document.getElementById("edit-dialog");
    this.form = document.getElementById("edit-form");
    this._bindForm();
  }

  _bindForm() {
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._commit();
    });
    document.getElementById("edit-cancel").addEventListener("click", () => this.dialog.close());
    document.getElementById("edit-delete").addEventListener("click", () => this._deleteCurrent());
  }

  // --- open forms ----------------------------------------------------------
  openNew() {
    this.currentId = null;
    this._fill({ name: "", birth: "", death: "", gender: "", maidenName: "", notes: "", photo: "", parents: [], spouses: [] });
    document.getElementById("edit-title").textContent = "Add person";
    document.getElementById("edit-delete").hidden = true;
    this.dialog.showModal();
    this.form.querySelector("#f-name").focus();
  }

  openEdit(id) {
    const p = this.store.get(id);
    if (!p) return;
    this.currentId = id;
    this._fill(p);
    document.getElementById("edit-title").textContent = "Edit person";
    document.getElementById("edit-delete").hidden = false;
    this.dialog.showModal();
    this.form.querySelector("#f-name").focus();
  }

  _fill(p) {
    this.form.querySelector("#f-name").value = p.name || "";
    this.form.querySelector("#f-birth").value = p.birth || "";
    this.form.querySelector("#f-death").value = p.death || "";
    this.form.querySelector("#f-gender").value = p.gender || "";
    this.form.querySelector("#f-maiden").value = p.maidenName || "";
    this.form.querySelector("#f-photo").value = p.photo || "";
    this.form.querySelector("#f-notes").value = p.notes || "";

    this._renderPeoplePicker("parents", p.parents || [], 2);
    this._renderPeoplePicker("spouses", p.spouses || [], Infinity);
  }

  // A relationship picker: a list of chosen people (chips) + an add-dropdown
  // that searches existing people by name. `max` caps the number selectable.
  _renderPeoplePicker(field, selectedIds, max) {
    const container = this.form.querySelector(`#f-${field}`);
    container.innerHTML = "";
    container.dataset.field = field;

    const chips = document.createElement("div");
    chips.className = "chips";
    container.appendChild(chips);

    const selected = new Set(selectedIds.filter((id) => this.store.has(id)));

    const refresh = () => {
      chips.innerHTML = "";
      for (const id of selected) {
        const person = this.store.get(id);
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = `${person.name} ${lifespan(person)}`.trim();
        const x = document.createElement("button");
        x.type = "button";
        x.className = "chip-x";
        x.textContent = "×";
        x.setAttribute("aria-label", `Remove ${person.name}`);
        x.addEventListener("click", () => { selected.delete(id); refresh(); });
        chip.appendChild(x);
        chips.appendChild(chip);
      }
      picker.hidden = selected.size >= max;
    };

    // Native datalist-backed search input keeps it dependency-free.
    const picker = document.createElement("div");
    picker.className = "picker-add";
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("list", `dl-${field}`);
    input.placeholder = `Add ${field === "parents" ? "parent" : "spouse"}…`;
    const datalist = document.createElement("datalist");
    datalist.id = `dl-${field}`;

    const rebuildOptions = () => {
      datalist.innerHTML = "";
      for (const person of this.store.all()) {
        if (person.id === this.currentId) continue; // can't relate to self
        if (selected.has(person.id)) continue;
        const opt = document.createElement("option");
        opt.value = `${person.name} ${lifespan(person)}`.trim() + ` [${person.id}]`;
        datalist.appendChild(opt);
      }
    };

    input.addEventListener("change", () => {
      const m = /\[([^\]]+)\]\s*$/.exec(input.value);
      const id = m ? m[1] : null;
      if (id && this.store.has(id) && selected.size < max) {
        selected.add(id);
        input.value = "";
        rebuildOptions();
        refresh();
      }
    });

    rebuildOptions();
    picker.appendChild(input);
    picker.appendChild(datalist);
    container.appendChild(picker);
    container._getSelected = () => [...selected];
    refresh();
  }

  // --- commit / delete -----------------------------------------------------
  _commit() {
    const data = {
      name: this.form.querySelector("#f-name").value.trim(),
      birth: emptyToNull(this.form.querySelector("#f-birth").value),
      death: emptyToNull(this.form.querySelector("#f-death").value),
      gender: emptyToNull(this.form.querySelector("#f-gender").value),
      maidenName: emptyToNull(this.form.querySelector("#f-maiden").value),
      photo: emptyToNull(this.form.querySelector("#f-photo").value),
      notes: emptyToNull(this.form.querySelector("#f-notes").value),
      parents: this.form.querySelector("#f-parents")._getSelected(),
      spouses: this.form.querySelector("#f-spouses")._getSelected(),
    };
    if (!data.name) { this.form.querySelector("#f-name").focus(); return; }

    if (this.currentId) {
      this.store.updatePerson(this.currentId, data);
    } else {
      const created = this.store.addPerson(data);
      this.store._reciprocateSpouses(created);
    }
    this.dialog.close();
    this.onAfterChange();
  }

  _deleteCurrent() {
    if (!this.currentId) return;
    const p = this.store.get(this.currentId);
    const refs = referencesTo(this.store, this.currentId);
    let msg = `Delete "${p.name}"?`;
    if (refs.length) {
      msg += `\n\nThis will also remove ${refs.length} reference(s) to them ` +
        `(${refs.map((r) => `${r.person.name} as ${r.kind}`).join(", ")}).`;
    }
    if (!window.confirm(msg)) return;
    this.store.deletePerson(this.currentId);
    this.dialog.close();
    this.onAfterChange();
  }
}

function emptyToNull(v) {
  v = (v || "").trim();
  return v === "" ? null : v;
}