# Project Spec — Static Family Tree Site

## 1. Summary

A **single static web app** that renders an interactive, zoomable family tree from a local JSON file. It runs in two capability modes from the *same codebase*:

- **View mode** — read-only. Deployed to GitHub Pages, loads `data/family.json`, supports clicking, zoom/pan, and printing for archival.
- **Edit mode** — run locally. Adds create/edit/delete of people and relationships, and saves changes back to `data/family.json` so the user can commit the file to git.

No backend, no build step, no framework required. Plain HTML + CSS + ES modules, with the visualization library vendored locally.

---

## 2. Goals and non-goals

**Goals**
- Pure static site that works on GitHub Pages with zero server code.
- Interactive tree: click a person for details, zoom and pan smoothly.
- Edit the data in-browser when running locally, and persist it back to the JSON file on disk for git check-in.
- Export the JSON at any time as a universal fallback.
- High-quality printing / "Save as PDF" for archival (vector output, legible names).
- Data is human-editable JSON, the single source of truth, kept in the repo.

**Non-goals (v1)**
- Multi-user editing, auth, or any server/database.
- A build pipeline or bundler (keep it buildless so Pages serves files directly).
- GEDCOM import/export (listed under future enhancements).
- Editing while deployed on Pages (Pages is read-only by design).

---

## 3. Core user workflows

**A. View on the web (anyone, including the owner)**
1. Visit the GitHub Pages URL.
2. The app fetches `data/family.json` and renders the tree.
3. User pans, zooms, and clicks people to see details.
4. User can print / save as PDF.

**B. Edit locally and check in (the owner)**
1. Clone the repo, start a local static server (see §11 — `file://` will NOT work).
2. Open the local URL, toggle **Edit mode**.
3. Add / edit / delete people and relationships.
4. **Save:** if the browser supports the File System Access API (Chrome/Edge over localhost), save directly back to the chosen `data/family.json`. Otherwise, **Export JSON** downloads the file to replace `data/family.json` manually.
5. `git add data/family.json && git commit && git push`.
6. GitHub Pages serves the updated read-only view.

**C. Print for archival**
1. From either mode, click **Print**.
2. The app resets zoom to fit the whole tree, switches to a print-optimized rendering (white background, black text, UI hidden), and opens the browser print dialog.
3. User prints or saves as PDF.

---

## 4. Architecture

- **One app, capability detection, not separate builds.** The same `index.html` runs everywhere. Edit/save controls are progressively enabled based on browser capability and how the page is served:
    - Direct file save is offered only when `window.showSaveFilePicker` exists (Chromium over localhost/https).
    - Export-as-download is always available.
    - When served from the deployed host (`*.github.io` **or** the custom domain `me.dhanani94.com`), default to view mode and hide the in-place save control (export still allowed); editing on a deployed copy can't persist anywhere useful.
- **Data flow:** `data/family.json` → loaded via `fetch()` → in-memory model → render. Edits mutate the in-memory model → save writes the model back out to JSON.
- **No build step.** Use native ES modules (`<script type="module">`). Vendor the viz library as a local file in `/vendor/` rather than relying on a CDN, so the site works offline and remains archival-stable.

---

## 5. Tech stack and constraints

- **HTML / CSS / vanilla JS (ES modules).** No framework, no bundler.
- **Visualization: D3.js v7**, vendored at `/vendor/d3.min.js`.
    - Use `d3-zoom` for pan/zoom, `d3-hierarchy` for generational layout, SVG for rendering (vector = crisp print + scalable).
    - **Acceptable alternative:** the `dTree` library (purpose-built for family trees) if the agent finds D3-from-scratch union layout too costly. If used, vendor it locally and still implement zoom/pan and the print/edit requirements around it.
- **Rendering target: SVG** (not Canvas) — needed for clean printing and selectable/clickable nodes.
- **Hard constraints:**
    - **Use relative paths only** (e.g. `fetch("data/family.json")`, not `fetch("/data/family.json")`). This app is deployed in a **subdirectory** at `https://me.dhanani94.com/family_tree/` (the repo is the owner's custom-domain Pages site), so absolute paths rooted at `/` would resolve against the domain root and break. Relative paths keep it portable. This is the #1 deployment gotcha — get it right everywhere.
    - **Must be served over http(s)**, even locally. Opening `index.html` via `file://` will fail to `fetch()` the JSON. Document this clearly.
    - No `localStorage`/`sessionStorage` dependence for the source of truth — the JSON file is canonical. (A transient unsaved-changes buffer in memory is fine.)

---

## 6. Repository structure

```
/
├── index.html
├── css/
│   └── styles.css            # includes @media print rules
├── js/
│   ├── app.js                # entry point, mode/capability detection, wiring
│   ├── store.js              # load/save JSON, in-memory model, derive children
│   ├── render.js             # D3 layout + zoom/pan + click handling
│   ├── edit.js               # CRUD UI, relationship pickers, validation hooks
│   ├── validate.js           # data integrity checks
│   └── print.js              # fit-to-page + print-mode toggling
├── data/
│   ├── family.json           # the source of truth
│   └── photos/               # optional local images referenced by people
├── vendor/
│   └── d3.min.js
├── .nojekyll                 # prevents Jekyll from interfering on Pages
└── README.md                 # setup + workflows (mirror §11)
```

Include a `.nojekyll` file so GitHub Pages serves all paths as-is.

---

## 7. Data model

A **flat array of people**. Relationships are stored on each person as ID references. **Children are derived, never stored**, to avoid the two directions drifting out of sync.

### Schema (per person)

| Field        | Type              | Required | Notes |
|--------------|-------------------|----------|-------|
| `id`         | string            | yes      | Stable unique ID (e.g. `p1`, or a UUID). Never reused. |
| `name`       | string            | yes      | Display name. |
| `birth`      | string \| null    | no       | Free-form or full ISO date (`YYYY-MM-DD`); stored verbatim. The tree shows the **year only**; the detail panel shows the full value. |
| `death`      | string \| null    | no       | Same; `null`/absent = living. |
| `gender`     | string \| null    | no       | Optional, free-form (e.g. `M`/`F`/other/empty). Used only for optional styling. |
| `parents`    | string[]          | yes      | 0–2 person IDs. Empty array allowed. |
| `spouses`    | string[]          | no       | Person IDs; should be reciprocal. |
| `maidenName` | string \| null    | no       | Optional. |
| `notes`      | string \| null    | no       | Optional free text. |
| `photo`      | string \| null    | no       | Optional relative path, e.g. `data/photos/p1.jpg`. |

### File shape

```json
{
  "version": 1,
  "meta": { "rootId": "p3" },
  "people": [
    { "id": "p1", "name": "Jane Doe", "birth": "1950", "death": null, "spouses": ["p2"], "parents": [] },
    { "id": "p2", "name": "John Doe", "birth": "1948", "death": "2020", "spouses": ["p1"], "parents": [] },
    { "id": "p3", "name": "Amy Doe", "birth": "1975", "spouses": [], "parents": ["p1", "p2"] }
  ]
}
```

- Include a top-level `version` for future migrations.
- Top-level `meta.rootId` names the **default person** whose branch is shown on
  load and after **Reset** (see §9.6). Optional; `null`/absent shows the full
  tree. If the referenced person is deleted, it's cleared back to `null`.
- `store.js` exposes a `getChildren(id)` helper that scans for people listing
  `id` in their `parents`, and `getAncestorRoots(id)` which walks up `parents`
  to the topmost ancestors (used to compute a person's branch in §9.6).

---

## 8. Data integrity / validation (`validate.js`)

Run on load and before save; surface problems in a non-blocking panel (don't silently drop data):

- Every `id` is unique.
- Every referenced ID in `parents`/`spouses` exists.
- A person has at most 2 `parents`.
- `spouses` is reciprocal (warn and offer auto-fix if A lists B but B doesn't list A).
- No ancestry cycles (a person cannot be their own ancestor).
- Warn on orphan references after a delete.

On **delete**, automatically clean up: remove the deleted ID from every other person's `parents` and `spouses`, and require a confirm dialog first.

---

## 9. Feature detail

### 9.1 Visualization (`render.js`)
- Top-down generational layout. Render couples (spouses) as adjacent/joined nodes with children descending from the union.
- **Zoom and pan** via `d3-zoom`: scroll/pinch to zoom, drag to pan, plus on-screen **+ / − / reset-to-fit** buttons.
- **Click a person** → open a detail panel (§9.2). Hover highlights the node.
- Each node shows name and birth–death **years only** (full dates are kept in the
  data and shown in the detail panel); keep readable at default zoom.
- Layout reserves each subtree's full width (couple width included) so couples
  never overlap an adjacent subtree, regardless of how many children they have.
- A toolbar chip shows the **member count** in the current view (e.g. "59 of 98
  people" when focused on a branch, or "98 people" for the whole tree).
- Should handle up to a few hundred people without noticeable lag.

### 9.2 Person detail panel
- Slide-in or modal showing all fields, photo if present, and quick links to jump to parents/spouses/children.
- In edit mode, an **Edit** button opens the edit form for that person, plus
  quick-add shortcuts: **Add child** (opens the add form with the selected
  person — and their spouse, if any — prefilled as parents) and **Add spouse**
  (prefills the spouse link; shown only when the person has no spouse yet). The
  newly created person is auto-selected after saving.

### 9.3 Edit mode (`edit.js`)
- Toggle button to enter/leave edit mode (only meaningfully enabled when not on the deployed Pages host).
- **Add person**, **edit person**, **delete person** (with §8 cleanup + confirm).
- Relationship editing via **pickers that select from existing people** (search-by-name dropdowns), so the user never types raw IDs. Setting a parent on a child is the canonical action; the children view updates automatically.
- New IDs generated automatically (e.g. `p` + incrementing number or a UUID); never reuse a deleted ID.
- Show an **unsaved-changes** indicator.

### 9.4 Load and persistence (`store.js`)
- **Load:** `fetch("data/family.json")` (relative path) on startup; show a clear error if it fails (e.g. opened via `file://`).
- **Save (primary):** if `window.showSaveFilePicker` is available, let the user pick/keep a handle to `data/family.json` and write the serialized model directly back to disk. Pretty-print JSON (2-space indent) and keep `people` in a stable order so git diffs stay clean.
- **Export (fallback, always available):** serialize and trigger a download of `family.json`.
- **Import (optional convenience):** let the user load a `.json` from disk into the app via file picker, useful for the download/edit/re-import loop.

### 9.5 Print / archival (`print.js`)
- **Print** button: reset zoom to fit the entire tree, apply a `print` mode (white bg, black text, hide all UI chrome via `@media print`), then call `window.print()`.
- Output the **whole tree** as vector SVG, auto-scaled to fit the page; default to landscape guidance in the README.
- Names and dates must remain legible in print output.
- (Multi-page tiling for very large trees is a future enhancement; v1 scales to fit one page and relies on large paper size / Save-as-PDF.)

### 9.6 Branch focus / "view this side" (`render.js` + `app.js`)
Large trees have several branches converging at the top. The user can focus on
**one side** of a person's family:
- **Focus action:** click a person → **"View this side"** in the detail panel, or
  **double-click** their node. The view climbs a **single parent line** (the
  first/father parent at each step, `getLineageApex`) to the topmost ancestor,
  then renders that apex couple's descendants — the person plus their aunts,
  uncles, and cousins **on that one side**. People outside it are hidden.
  - Following one parent line is deliberate: focusing on yourself shows your
    **father's** side, not both parents' families spliced together at the top. To
    see the other side, focus on that parent (e.g. click your mother → her side).
- **Side label = the apex:** the chip reads "Viewing &lt;topmost ancestor&gt;'s
  side" — named after the apex the lineage climbs to, not the clicked person. The
  clicked person stays selected so you can locate them within the side.
- **Default side:** on load and after **Reset**, the view shows the side of
  `meta.rootId` (its lineage apex). If `meta.rootId` is null/absent, the full
  tree is shown.
- **Reset:** a toolbar **↺ Reset** button (visible only when off the default
  side) returns to it.
- **Set default (edit mode):** the detail panel's **Set as default** button writes
  the selected person to `meta.rootId` (persisted on save/export).
- **Print** uses whatever side is currently focused, so you can print one side.

---

## 10. GitHub Pages deployment

- This lives inside the owner's existing custom-domain Pages site (`dhanani94.github.io`, served at `me.dhanani94.com` via the repo `CNAME`). The app is the `family_tree/` subdirectory, so it is reached at **`https://me.dhanani94.com/family_tree/`** — no separate repo or Pages config needed.
- Include `.nojekyll` at the **repo root** so Pages serves every path (including `family_tree/js/`, `vendor/`, etc.) as-is without Jekyll processing.
- Confirm all asset and `fetch` paths are **relative** so they resolve under `https://me.dhanani94.com/family_tree/`.
- The deployed copy defaults to view mode; verify clicking, zoom/pan, and print all work on the live URL.

---

## 11. Local development and the check-in workflow

Document this in `README.md`:

1. `git clone` the repo.
2. Start a static server from the repo root (any one of):
    - `python3 -m http.server 8000`
    - `npx serve` (or `npx http-server`)
3. Open `http://localhost:8000/` — **not** the file directly (`file://` breaks JSON loading).
4. Toggle **Edit mode**, make changes.
5. **Save** directly to `data/family.json` (Chrome/Edge) or **Export** and replace the file.
6. `git add data/family.json && git commit -m "Update family tree" && git push`.

---

## 12. Accessibility & responsiveness (light touch)
- Keyboard: Esc closes panels; buttons are focusable with visible focus states.
- Detail panel content readable by screen readers (use real headings/labels, `alt` on photos).
- Layout usable on a phone for *viewing* (touch pan/pinch zoom); editing is desktop-first.

---

## 13. Acceptance criteria (definition of done)

- [ ] Loads and renders `data/family.json` over http with relative paths; clear error on `file://`.
- [ ] Tree is clickable; clicking opens a person detail panel.
- [ ] Smooth zoom + pan with on-screen +/−/reset controls.
- [ ] Edit mode: add, edit, delete people; relationship pickers select existing people by name; deletes clean up references with confirm.
- [ ] Direct save to `data/family.json` works in a Chromium browser over localhost; export-download works everywhere.
- [ ] Saved/exported JSON is pretty-printed with stable ordering (clean git diffs) and re-loads correctly.
- [ ] Validation surfaces duplicate IDs, dangling references, >2 parents, non-reciprocal spouses, and ancestry cycles.
- [ ] Branch focus: "View this side" / double-click shows one person's branch; the default branch (`meta.rootId`) loads first and **Reset** returns to it.
- [ ] Print/Save-as-PDF outputs the (focused or full) tree as legible vector with UI hidden.
- [ ] Deploys to GitHub Pages and works read-only at the project URL.
- [ ] No build step; viz library vendored locally; `.nojekyll` present.
- [ ] `README.md` documents both workflows including the `file://` caveat.

---

## 14. Suggested build order (milestones)

1. **Skeleton + data:** repo structure, `index.html`, sample `data/family.json`, `store.js` load + `getChildren`, render a static tree.
2. **Interaction:** zoom/pan, click → detail panel.
3. **Validation:** `validate.js` + non-blocking issues panel.
4. **Edit mode:** CRUD + relationship pickers + reference cleanup.
5. **Persistence:** File System Access API save + export fallback + optional import.
6. **Print:** fit-to-page + `@media print` + print mode.
7. **Deploy:** Pages config, relative-path audit, live-URL verification, README.

---

## 15. Future enhancements (out of scope for v1)
- GEDCOM import/export for interoperability with genealogy tools.
- Multi-page print tiling for very large trees.
- Photo gallery / multiple photos per person.
- Optional tiny local save-server (Node/Python) for one-click direct save on any browser without the File System Access API.
- Search / filter / focus-on-subtree.
- Alternative layouts (descendant-only, ancestor-only, fan chart).