# Family Tree

A single static web app that renders an interactive, zoomable family tree from a
local JSON file. No backend, no build step, no framework — plain HTML + CSS +
ES modules, with D3 v7 vendored locally.

**Live:** https://me.dhanani94.com/family_tree/

It runs in two capability modes from the same codebase:

- **View mode** — read-only. What's deployed at the URL above. Loads
  `data/family.json`, supports click, zoom/pan, and printing.
- **Edit mode** — only offered when running locally (not on the deployed host).
  Adds create/edit/delete of people and relationships, and saves back to
  `data/family.json` so you can commit it to git.

## Viewing on the web

1. Open https://me.dhanani94.com/family_tree/.
2. Pan (drag), zoom (scroll / pinch or the **+ / − / Fit** buttons), and click a
   person for their details.
3. Click **Print** to print or Save-as-PDF (landscape recommended).

## Editing locally and checking in

`file://` will **not** work — the browser blocks `fetch()` of the JSON. You must
serve over http.

1. Clone the repo and serve from **this** folder:
   ```sh
   cd family_tree
   python3 -m http.server 8000
   # or: npx serve   /   npx http-server
   ```
2. Open `http://localhost:8000/` (not the file directly).
3. Click **Edit mode**, then **+ Add person** / click a node → **Edit**.
   - Relationships are chosen from search dropdowns over existing people — you
     never type raw IDs. Setting a person's **parents** is the canonical action;
     the children view updates automatically (children are derived, not stored).
4. **Save:**
   - **Chrome / Edge:** click **Save** to write directly back to
     `data/family.json` (File System Access API).
   - **Any browser:** click **Export** to download `family.json`, then replace
     `family_tree/data/family.json` with it. **Import** loads a `.json` back in
     for the download/edit/re-import loop.
5. Commit:
   ```sh
   git add family_tree/data/family.json
   git commit -m "Update family tree"
   git push
   ```
   GitHub Pages serves the updated read-only view.

## Focusing on one side of the family

Big trees have several branches meeting at the top. To explore just one side:

- Click a person → **🔍 View this side** in the detail panel (or **double-click**
  their node). The tree re-roots to that person's earliest ancestors and shows
  that whole branch — their parents, grandparents, aunts, uncles, and cousins.
  - Clicking your **mom** walks up to *her* parents, so you get her side.
    Clicking **yourself** walks up to all your grandparents, so you get your
    whole extended branch.
- The toolbar shows **Viewing &lt;name&gt;'s side**; press **↺ Reset** to go back
  to the default branch.
- The **default branch** is set by `meta.rootId` in `data/family.json` (shown on
  load and after Reset). In **Edit mode**, click a person and use **Set as
  default** to change it, then Save/Export.

## Data model

`data/family.json` is the single source of truth: a flat array of people with
relationships stored as ID references. **Children are derived**, never stored, so
the two directions can't drift. See the project [`spec.md`](./spec.md) for the
full schema and field list.

```json
{
  "version": 1,
  "people": [
    { "id": "p1", "name": "Jane Doe", "birth": "1950", "death": null, "spouses": ["p2"], "parents": [] }
  ]
}
```

Saved/exported JSON is pretty-printed (2-space indent) with people sorted by ID
so git diffs stay clean.

## Validation

On load and before save the app checks: unique IDs, no dangling references, ≤2
parents, reciprocal spouses (with one-click auto-fix), and no ancestry cycles.
Issues show in the panel at the bottom-left; nothing is ever silently dropped.

## Notes / gotchas

- **Relative paths only** — this app lives in a subdirectory
  (`/family_tree/`), so absolute `/`-rooted paths would break. Everything uses
  relative paths.
- `.nojekyll` at the **repo root** keeps GitHub Pages from processing
  `js/`, `vendor/`, etc.
- Photos: drop images in `data/photos/` and reference them by relative path
  (e.g. `data/photos/p1.jpg`) in a person's `photo` field.