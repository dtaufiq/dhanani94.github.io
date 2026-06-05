// validate.js — data integrity checks. Run on load and before save.
// Returns a flat list of issues; never mutates or drops data. Some issues
// carry a `fix(store)` callback for one-click auto-repair (e.g. spouse reciprocity).

export function validate(store) {
  const issues = [];
  const people = store.all();
  const ids = new Set();

  // Duplicate ids ----------------------------------------------------------
  const seen = new Map();
  for (const p of people) {
    if (seen.has(p.id)) {
      issues.push({
        level: "error",
        message: `Duplicate id "${p.id}" (used by "${seen.get(p.id).name}" and "${p.name}").`,
      });
    } else {
      seen.set(p.id, p);
    }
    ids.add(p.id);
  }

  for (const p of people) {
    const who = `${p.name || "(unnamed)"} [${p.id}]`;

    // Dangling references --------------------------------------------------
    for (const pid of p.parents) {
      if (!ids.has(pid)) {
        issues.push({ level: "error", message: `${who} lists missing parent "${pid}".` });
      }
    }
    for (const sid of p.spouses) {
      if (!ids.has(sid)) {
        issues.push({ level: "error", message: `${who} lists missing spouse "${sid}".` });
      }
    }

    // At most 2 parents ----------------------------------------------------
    if (p.parents.length > 2) {
      issues.push({ level: "error", message: `${who} has ${p.parents.length} parents (max 2).` });
    }

    // Self references ------------------------------------------------------
    if (p.parents.includes(p.id)) {
      issues.push({ level: "error", message: `${who} is listed as their own parent.` });
    }
    if (p.spouses.includes(p.id)) {
      issues.push({ level: "error", message: `${who} is listed as their own spouse.` });
    }

    // Non-reciprocal spouse (warn + auto-fix) ------------------------------
    for (const sid of p.spouses) {
      const s = store.get(sid);
      if (s && !s.spouses.includes(p.id)) {
        issues.push({
          level: "warn",
          message: `${p.name} lists ${s.name} as spouse, but not vice-versa.`,
          fix: (st) => {
            const target = st.get(sid);
            if (target && !target.spouses.includes(p.id)) {
              target.spouses.push(p.id);
              st._touch();
            }
          },
        });
      }
    }
  }

  // Ancestry cycles --------------------------------------------------------
  for (const p of people) {
    if (hasAncestorCycle(store, p.id)) {
      issues.push({ level: "error", message: `Ancestry cycle: ${p.name} [${p.id}] is their own ancestor.` });
    }
  }

  return issues;
}

// Detect whether following `parents` from `startId` ever returns to startId.
function hasAncestorCycle(store, startId) {
  const stack = [startId];
  const visited = new Set();
  let first = true;
  while (stack.length) {
    const id = stack.pop();
    if (!first && id === startId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const p = store.get(id);
    if (p) for (const pid of p.parents) stack.push(pid);
    first = false;
  }
  return false;
}

// Check for orphaned references that a delete of `id` would leave behind.
// Used to warn before a delete (the store also scrubs them on actual delete).
export function referencesTo(store, id) {
  const refs = [];
  for (const p of store.all()) {
    if (p.id === id) continue;
    if (p.parents.includes(id)) refs.push({ person: p, kind: "parent" });
    if (p.spouses.includes(id)) refs.push({ person: p, kind: "spouse" });
  }
  return refs;
}