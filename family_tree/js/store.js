// store.js — load/save JSON, in-memory model, derive children.
// The JSON file (data/family.json) is the single source of truth. The model
// here is a transient in-memory mirror; only Save/Export write it back out.

const DATA_URL = "data/family.json";

export class Store {
  constructor() {
    this.version = 1;
    this.meta = { rootId: null }; // rootId = default person whose branch shows on load/reset
    this.people = [];        // flat array of person objects
    this._byId = new Map();  // id -> person, rebuilt on every mutation
    this.fileHandle = null;  // FileSystemFileHandle when direct-save is wired up
    this.dirty = false;      // unsaved in-memory changes
    this._listeners = new Set();
  }

  // --- change notification -------------------------------------------------
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) fn(this); }

  // --- loading -------------------------------------------------------------
  async load() {
    let res;
    try {
      res = await fetch(DATA_URL, { cache: "no-store" });
    } catch (err) {
      // Most commonly: opened via file:// so fetch() is blocked.
      throw new Error(
        "Could not load data/family.json. If you opened the page directly " +
        "(file://), serve it over http instead — e.g. `python3 -m http.server` " +
        "from the family_tree folder. (" + err.message + ")"
      );
    }
    if (!res.ok) {
      throw new Error("Failed to load data/family.json (HTTP " + res.status + ").");
    }
    const json = await res.json();
    this.setData(json);
  }

  setData(json) {
    this.version = json.version ?? 1;
    this.meta = { rootId: json.meta?.rootId ?? null };
    this.people = Array.isArray(json.people) ? json.people.map(normalizePerson) : [];
    this._reindex();
    this.dirty = false;
    this._emit();
  }

  _reindex() {
    this._byId = new Map();
    for (const p of this.people) this._byId.set(p.id, p);
  }

  // --- reads ---------------------------------------------------------------
  get(id) { return this._byId.get(id) || null; }
  has(id) { return this._byId.has(id); }
  all() { return this.people; }

  // Children are DERIVED, never stored: scan for people listing `id` as a parent.
  getChildren(id) {
    return this.people
      .filter((p) => p.parents.includes(id))
      .sort(byBirthThenName);
  }

  // Children shared by a couple (parents intersect the given id set).
  getChildrenOfCouple(ids) {
    return this.people
      .filter((p) => p.parents.some((pa) => ids.includes(pa)))
      .sort(byBirthThenName);
  }

  getSpouses(id) {
    const p = this.get(id);
    if (!p) return [];
    return p.spouses.map((sid) => this.get(sid)).filter(Boolean);
  }

  getParents(id) {
    const p = this.get(id);
    if (!p) return [];
    return p.parents.map((pid) => this.get(pid)).filter(Boolean);
  }

  // Apex of `id`'s lineage: walk up a SINGLE parent line (the first/father
  // parent at each step) to the topmost ancestor. Returns just that apex.
  // Following one parent keeps a focus to ONE side of the family — the layout
  // pairs the apex with their spouse and renders that couple's descendants, so
  // you never see both the mother's and father's sides spliced together.
  // To see the other side, focus on the relevant parent instead.
  getLineageApex(id) {
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const p = this.get(cur);
      if (!p) break;
      const parents = p.parents.filter((pid) => this.has(pid));
      if (parents.length === 0) return cur;
      cur = parents[0]; // follow the first parent (father) up
    }
    return cur || id;
  }

  setRootId(id) {
    this.meta.rootId = this.has(id) ? id : null;
    this._touch();
  }

  // --- mutations (edit mode) ----------------------------------------------
  nextId() {
    // p + (max existing numeric suffix + 1); never reuse a deleted id within a session.
    let max = 0;
    for (const p of this.people) {
      const m = /^p(\d+)$/.exec(p.id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return "p" + (max + 1);
  }

  addPerson(partial) {
    const person = normalizePerson({ id: partial.id || this.nextId(), ...partial });
    this.people.push(person);
    this._byId.set(person.id, person);
    this._touch();
    return person;
  }

  updatePerson(id, patch) {
    const p = this.get(id);
    if (!p) return null;
    Object.assign(p, normalizePerson({ ...p, ...patch, id }));
    this._reciprocateSpouses(p);
    this._touch();
    return p;
  }

  // Delete a person and scrub every dangling reference (parents + spouses).
  deletePerson(id) {
    if (!this.has(id)) return;
    this.people = this.people.filter((p) => p.id !== id);
    for (const p of this.people) {
      p.parents = p.parents.filter((x) => x !== id);
      p.spouses = p.spouses.filter((x) => x !== id);
    }
    if (this.meta.rootId === id) this.meta.rootId = null;
    this._reindex();
    this._touch();
  }

  // Ensure A<->B spousal links are reciprocal after an edit.
  _reciprocateSpouses(person) {
    for (const sid of person.spouses) {
      const s = this.get(sid);
      if (s && !s.spouses.includes(person.id)) s.spouses.push(person.id);
    }
  }

  _touch() {
    this.dirty = true;
    this._emit();
  }

  // --- serialization -------------------------------------------------------
  // Stable ordering + pretty print so git diffs stay clean.
  serialize() {
    const people = [...this.people].sort(byIdNumeric).map(canonicalPerson);
    const meta = { rootId: this.has(this.meta.rootId) ? this.meta.rootId : null };
    return JSON.stringify({ version: this.version, meta, people }, null, 2) + "\n";
  }

  // --- persistence ---------------------------------------------------------
  // Direct save via File System Access API (Chromium over localhost/https).
  static canDirectSave() { return typeof window.showSaveFilePicker === "function"; }

  async pickSaveFile() {
    this.fileHandle = await window.showSaveFilePicker({
      suggestedName: "family.json",
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
    });
    return this.fileHandle;
  }

  async saveToDisk() {
    if (!this.fileHandle) await this.pickSaveFile();
    const writable = await this.fileHandle.createWritable();
    await writable.write(this.serialize());
    await writable.close();
    this.dirty = false;
    this._emit();
  }

  // Export-as-download fallback (always available).
  exportDownload(filename = "family.json") {
    const blob = new Blob([this.serialize()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

// --- helpers ---------------------------------------------------------------

function normalizePerson(p) {
  return {
    id: String(p.id),
    name: p.name ?? "",
    birth: p.birth ?? null,
    death: p.death ?? null,
    gender: p.gender ?? null,
    parents: Array.isArray(p.parents) ? [...new Set(p.parents.map(String))] : [],
    spouses: Array.isArray(p.spouses) ? [...new Set(p.spouses.map(String))] : [],
    maidenName: p.maidenName ?? null,
    notes: p.notes ?? null,
    photo: p.photo ?? null,
  };
}

// Keep a stable field order in the serialized output for clean diffs.
function canonicalPerson(p) {
  return {
    id: p.id,
    name: p.name,
    birth: p.birth ?? null,
    death: p.death ?? null,
    gender: p.gender ?? null,
    parents: p.parents,
    spouses: p.spouses,
    maidenName: p.maidenName ?? null,
    notes: p.notes ?? null,
    photo: p.photo ?? null,
  };
}

function byIdNumeric(a, b) {
  const na = numericSuffix(a.id), nb = numericSuffix(b.id);
  if (na != null && nb != null && na !== nb) return na - nb;
  return a.id.localeCompare(b.id);
}

function numericSuffix(id) {
  const m = /^p(\d+)$/.exec(id);
  return m ? parseInt(m[1], 10) : null;
}

function byBirthThenName(a, b) {
  const ya = birthYear(a), yb = birthYear(b);
  if (ya != null && yb != null && ya !== yb) return ya - yb;
  if (ya != null && yb == null) return -1;
  if (ya == null && yb != null) return 1;
  return (a.name || "").localeCompare(b.name || "");
}

export function birthYear(p) {
  if (!p || !p.birth) return null;
  const m = /(\d{4})/.exec(String(p.birth));
  return m ? parseInt(m[1], 10) : null;
}

// Full birth/death strings (e.g. "1994-05-12") — used in the detail panel.
export function lifespan(p) {
  const b = p.birth ? String(p.birth) : "";
  const d = p.death ? String(p.death) : "";
  if (!b && !d) return "";
  return `${b}–${d}`;
}

// Year extracted from a date-ish string ("1994-05-12" -> "1994").
export function yearOf(value) {
  if (!value) return null;
  const m = /(\d{4})/.exec(String(value));
  return m ? m[1] : null;
}

// Years only — used on the tree nodes to keep them compact.
export function lifespanYears(p) {
  const b = yearOf(p.birth) || "";
  const d = yearOf(p.death) || "";
  if (!b && !d) return "";
  return `${b}–${d}`;
}