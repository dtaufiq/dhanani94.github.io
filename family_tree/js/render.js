// render.js — generational family-tree layout + d3-zoom pan/zoom + click handling.
//
// Layout: a tidy top-down descendant layout. Each blood descendant is an
// "anchor"; their married-in partner is drawn adjacent, and shared children
// descend from the union midpoint. Leaves consume slots left-to-right; parents
// are centered over their children (Reingold–Tilford style). Up to a few
// hundred people render without lag.

import { lifespanYears, birthYear } from "./store.js";

const NODE_W = 168;
const NODE_H = 64;
const H_GAP = 28;             // gap between sibling blocks / couple partners
const V_GAP = 96;            // vertical gap between generations
const SLOT = NODE_W + H_GAP; // horizontal advance per single node

export class TreeRenderer {
  constructor(svgEl, store, { onSelect, onFocus, onRender } = {}) {
    this.store = store;
    this.onSelect = onSelect || (() => {});
    this.onFocus = onFocus || (() => {});
    this.onRender = onRender || (() => {});
    this.selectedId = null;
    // When set to an array of person ids, only those roots and their
    // descendants are laid out (a single "branch"). null = render everyone.
    this.focusRoots = null;

    this.svg = d3.select(svgEl);
    this.svg.selectAll("*").remove();

    // Layered groups: links under nodes, all inside one zoom viewport.
    this.viewport = this.svg.append("g").attr("class", "viewport");
    this.linkLayer = this.viewport.append("g").attr("class", "links");
    this.nodeLayer = this.viewport.append("g").attr("class", "nodes");

    this.zoom = d3.zoom()
      .scaleExtent([0.1, 3])
      .on("zoom", (event) => {
        this.viewport.attr("transform", event.transform);
        this._applyParallax(event.transform);
      });
    this.svg.call(this.zoom);
    // Drop d3-zoom's own double-click-to-zoom so node double-click can focus.
    this.svg.on("dblclick.zoom", null);
    // Clicking empty canvas clears selection.
    this.svg.on("click", () => this.select(null));

    this._bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  // Drift the wallpaper with the tree at a reduced rate so it reads as a deeper
  // plane — a subtle parallax that pans with the map and breathes on zoom.
  _applyParallax({ x, y, k }) {
    const PAN = 0.16;                          // wallpaper pans at 16% of the tree
    const BASE = 120;                          // tile size (matches the SVG/CSS)
    const size = BASE * (1 + (k - 1) * 0.35);  // dampened zoom response
    const node = this.svg.node();
    node.style.backgroundSize = `${size}px ${size}px`;
    node.style.backgroundPosition = `${x * PAN}px ${y * PAN}px`;
  }

  // --- public API ----------------------------------------------------------
  render() {
    const { nodes, links } = this._layout();
    this._draw(nodes, links);
    this.onRender(nodes.length);
    return { nodes, links };
  }

  // Restrict the view to a branch (array of root ids), or null for everyone,
  // then re-render and fit. Selection is preserved if still visible.
  setFocus(rootIds) {
    this.focusRoots = rootIds && rootIds.length ? rootIds : null;
    this.render();
    if (this.selectedId && !(this._nodeIndex && this._nodeIndex.has(this.selectedId))) {
      this.select(null);
    }
    this.resetToFit(false);
  }

  zoomBy(factor) {
    this.svg.transition().duration(200).call(this.zoom.scaleBy, factor);
  }

  resetToFit(animate = true) {
    const svgNode = this.svg.node();
    const w = svgNode.clientWidth || 800;
    const h = svgNode.clientHeight || 600;
    const b = this._bounds;
    const tw = (b.maxX - b.minX) || 1;
    const th = (b.maxY - b.minY) || 1;
    const pad = 40;
    const scale = Math.min((w - pad) / tw, (h - pad) / th, 1.5);
    const tx = (w - tw * scale) / 2 - b.minX * scale;
    const ty = (h - th * scale) / 2 - b.minY * scale;
    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
    const target = animate ? this.svg.transition().duration(400) : this.svg;
    target.call(this.zoom.transform, t);
  }

  select(id) {
    this.selectedId = id;
    this.nodeLayer.selectAll(".node")
      .classed("selected", (d) => d.person.id === id);
    this.onSelect(id);
  }

  centerOn(id) {
    const node = this._nodeIndex && this._nodeIndex.get(id);
    if (!node) return;
    const svgNode = this.svg.node();
    const w = svgNode.clientWidth || 800;
    const h = svgNode.clientHeight || 600;
    const cur = d3.zoomTransform(svgNode);
    const k = cur.k;
    const t = d3.zoomIdentity
      .translate(w / 2 - node.cx * k, h / 2 - (node.y + NODE_H / 2) * k)
      .scale(k);
    this.svg.transition().duration(400).call(this.zoom.transform, t);
  }

  // --- layout --------------------------------------------------------------
  _layout() {
    const store = this.store;
    const placed = new Set();
    const nodes = [];            // { person, cx, y } (cx = node center x)
    const nodeIndex = new Map(); // id -> node

    const place = (person, cx, y) => {
      const node = { person, cx, y };
      nodes.push(node);
      nodeIndex.set(person.id, node);
      return node;
    };

    // Build a family-unit tree: each unit is a couple (or single) plus the
    // child units descending from their union. The global `placed` set ensures
    // every person appears exactly once.
    const buildUnit = (anchorId) => {
      placed.add(anchorId);
      const anchor = store.get(anchorId);
      let partner = null;
      for (const sid of anchor.spouses) {
        if (store.has(sid) && !placed.has(sid)) { partner = store.get(sid); break; }
      }
      if (partner) placed.add(partner.id);
      const coupleIds = partner ? [anchorId, partner.id] : [anchorId];
      const children = store
        .getChildrenOfCouple(coupleIds)
        .filter((c) => !placed.has(c.id))
        .map((c) => buildUnit(c.id));
      return { anchor, partner, children, width: 0, centerX: 0 };
    };

    // Total width a couple's own row needs.
    const coupleW = (u) => (u.partner ? 2 * NODE_W + H_GAP : NODE_W);

    // Post-order measure: a subtree is at least as wide as its couple AND as
    // wide as its children side by side. Reserving the couple's full width is
    // what stops it from overflowing into a sibling subtree (the overlap bug).
    const measure = (u) => {
      const cw = coupleW(u);
      if (!u.children.length) { u.width = cw; return cw; }
      let childrenW = H_GAP * (u.children.length - 1);
      for (const c of u.children) childrenW += measure(c);
      u.width = Math.max(cw, childrenW);
      return u.width;
    };

    // Pre-order placement into a disjoint block [leftX, leftX + u.width].
    const placeUnit = (u, leftX, depth) => {
      const y = depth * (NODE_H + V_GAP);
      let center;
      if (!u.children.length) {
        center = leftX + u.width / 2;
      } else {
        let childrenW = H_GAP * (u.children.length - 1);
        for (const c of u.children) childrenW += c.width;
        let cx = leftX + (u.width - childrenW) / 2; // center the children block
        const centers = [];
        for (const c of u.children) {
          placeUnit(c, cx, depth + 1);
          centers.push(c.centerX);
          cx += c.width + H_GAP;
        }
        center = (centers[0] + centers[centers.length - 1]) / 2;
        // Clamp so the couple stays inside its own block (no sibling overlap).
        const half = coupleW(u) / 2;
        center = Math.max(leftX + half, Math.min(leftX + u.width - half, center));
      }
      u.centerX = center;
      if (u.partner) {
        place(u.anchor, center - (NODE_W + H_GAP) / 2, y);
        place(u.partner, center + (NODE_W + H_GAP) / 2, y);
      } else {
        place(u.anchor, center, y);
      }
    };

    // Roots: in focus mode, only the given branch roots; otherwise everyone
    // with no parents. A married-in partner of a root gets placed as that
    // root's partner, so skip if already placed.
    const rootSource = this.focusRoots
      ? this.focusRoots.map((id) => store.get(id)).filter(Boolean)
      : store.all().filter((p) => p.parents.length === 0);

    // Blood-descendant closure of the root source (married-in spouses excluded).
    const inTree = new Set();
    {
      const stack = rootSource.map((p) => p.id);
      while (stack.length) {
        const id = stack.pop();
        if (inTree.has(id)) continue;
        inTree.add(id);
        for (const c of store.getChildren(id)) stack.push(c.id);
      }
    }
    // Demote a root who married into a deeper family: if their spouse already
    // has a parent inside this tree, the spouse anchors the couple at the right
    // generation and this root is drawn beside them instead of as a top row.
    let rootList = rootSource.filter((p) =>
      !p.spouses.some((sid) => {
        const s = store.get(sid);
        return s && s.parents.some((pid) => inTree.has(pid));
      })
    );
    if (rootList.length === 0) rootList = rootSource; // safety: never empty
    const roots = rootList
      .slice()
      .sort((a, b) => (birthYear(a) ?? 9999) - (birthYear(b) ?? 9999));

    // Build the root forest, then any people unreachable as roots (full view
    // only — focus deliberately shows just the focused branch).
    const rootUnits = [];
    for (const r of roots) {
      if (!placed.has(r.id)) rootUnits.push(buildUnit(r.id));
    }
    if (!this.focusRoots) {
      for (const p of store.all()) {
        if (!placed.has(p.id)) rootUnits.push(buildUnit(p.id));
      }
    }

    // Measure + place each top-level family left to right with a clear gap.
    let cursorX = 0;
    for (const u of rootUnits) {
      measure(u);
      placeUnit(u, cursorX, 0);
      cursorX += u.width + SLOT; // gap between separate root families
    }

    this._nodeIndex = nodeIndex;
    this._computeBounds(nodes);

    // Build link descriptors from the placed nodes.
    const links = this._buildLinks(nodes, nodeIndex);
    return { nodes, links };
  }

  _computeBounds(nodes) {
    if (!nodes.length) { this._bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.cx - NODE_W / 2);
      maxX = Math.max(maxX, n.cx + NODE_W / 2);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y + NODE_H);
    }
    this._bounds = { minX, minY, maxX, maxY };
  }

  _buildLinks(nodes, nodeIndex) {
    const store = this.store;
    const links = [];
    const couplesDrawn = new Set();

    // Spouse links (horizontal connector at row mid-height).
    for (const n of nodes) {
      for (const sid of n.person.spouses) {
        const key = [n.person.id, sid].sort().join("|");
        if (couplesDrawn.has(key)) continue;
        const s = nodeIndex.get(sid);
        if (!s) continue;
        couplesDrawn.add(key);
        links.push({ type: "spouse", a: n, b: s });
      }
    }

    // Parent→child links: drop from the union point of the child's parents.
    for (const n of nodes) {
      const parentNodes = n.person.parents
        .map((pid) => nodeIndex.get(pid))
        .filter(Boolean);
      if (!parentNodes.length) continue;

      let unionX, unionY;
      if (parentNodes.length === 2) {
        unionX = (parentNodes[0].cx + parentNodes[1].cx) / 2;
        unionY = parentNodes[0].y + NODE_H / 2;
      } else {
        unionX = parentNodes[0].cx;
        unionY = parentNodes[0].y + NODE_H;
      }
      links.push({ type: "child", unionX, unionY, child: n });
    }
    return links;
  }

  // --- drawing -------------------------------------------------------------
  _draw(nodes, links) {
    // Links ----------------------------------------------------------------
    const linkSel = this.linkLayer.selectAll("path.link").data(links, linkKey);
    linkSel.exit().remove();
    linkSel.enter()
      .append("path")
      .merge(linkSel)
      .attr("class", (d) => `link link-${d.type}`)
      .attr("d", (d) => this._linkPath(d));

    // Nodes ----------------------------------------------------------------
    const nodeSel = this.nodeLayer.selectAll("g.node").data(nodes, (d) => d.person.id);
    nodeSel.exit().remove();

    const enter = nodeSel.enter()
      .append("g")
      .attr("class", "node")
      .attr("tabindex", 0)
      .attr("role", "button")
      .on("click", (event, d) => { event.stopPropagation(); this.select(d.person.id); })
      .on("dblclick", (event, d) => { event.stopPropagation(); this.onFocus(d.person.id); })
      .on("keydown", (event, d) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.select(d.person.id);
        }
      });

    enter.append("rect").attr("class", "node-box")
      .attr("width", NODE_W).attr("height", NODE_H)
      .attr("rx", 8).attr("ry", 8);
    enter.append("text").attr("class", "node-name");
    enter.append("text").attr("class", "node-dates");

    const all = enter.merge(nodeSel);
    all.attr("transform", (d) => `translate(${d.cx - NODE_W / 2},${d.y})`)
      .attr("aria-label", (d) => `${d.person.name} ${lifespanYears(d.person)}`);
    all.classed("gender-m", (d) => (d.person.gender || "").toUpperCase() === "M")
      .classed("gender-f", (d) => (d.person.gender || "").toUpperCase() === "F")
      .classed("deceased", (d) => !!d.person.death)
      .classed("selected", (d) => d.person.id === this.selectedId);

    all.select("text.node-name")
      .attr("x", NODE_W / 2).attr("y", 26)
      .attr("text-anchor", "middle")
      .text((d) => fit(d.person.name, 22));
    all.select("text.node-dates")
      .attr("x", NODE_W / 2).attr("y", 46)
      .attr("text-anchor", "middle")
      .text((d) => lifespanYears(d.person));
  }

  _linkPath(d) {
    if (d.type === "spouse") {
      const y = d.a.y + NODE_H / 2;
      const x1 = Math.min(d.a.cx, d.b.cx) + NODE_W / 2;
      const x2 = Math.max(d.a.cx, d.b.cx) - NODE_W / 2;
      return `M${x1},${y} L${x2},${y}`;
    }
    // child link: union point -> down to a bus -> over -> down to child top
    const childTop = d.child.y;
    const childX = d.child.cx;
    const busY = childTop - V_GAP / 2;
    return `M${d.unionX},${d.unionY} L${d.unionX},${busY} L${childX},${busY} L${childX},${childTop}`;
  }
}

// --- helpers ----------------------------------------------------------------

function linkKey(d) {
  if (d.type === "spouse") return "s|" + [d.a.person.id, d.b.person.id].sort().join("|");
  return "c|" + d.child.person.id;
}

// Truncate long names so they stay inside the node box.
function fit(str, max) {
  str = str || "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}