// print.js — fit-to-page + print-mode toggling for archival output.
//
// Strategy: the visible SVG uses a zoom transform for screen panning, which
// doesn't print well. For printing we clone the rendered tree into a separate
// print-only SVG sized to the tree's exact bounds with a viewBox, so the
// browser scales the *whole* vector tree to the page. @media print rules
// (styles.css) hide all UI chrome and force white bg / black text.

export function setupPrint(renderer, svgEl) {
  return function print() {
    // 1. Reset on-screen zoom to fit (nice if the user cancels the dialog).
    renderer.resetToFit(false);

    // 2. Build a standalone print SVG from the current viewport contents.
    const printSvg = buildPrintSvg(renderer, svgEl);
    const host = document.getElementById("print-root");
    host.innerHTML = "";
    host.appendChild(printSvg);

    document.body.classList.add("printing");

    const cleanup = () => {
      document.body.classList.remove("printing");
      host.innerHTML = "";
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);

    // Defer so layout/styles settle before the dialog opens.
    window.requestAnimationFrame(() => window.print());
  };
}

function buildPrintSvg(renderer, svgEl) {
  const b = renderer._bounds;
  const pad = 24;
  const minX = b.minX - pad, minY = b.minY - pad;
  const w = (b.maxX - b.minX) + pad * 2;
  const h = (b.maxY - b.minY) + pad * 2;

  const NS = "http://www.w3.org/2000/svg";
  const out = document.createElementNS(NS, "svg");
  out.setAttribute("xmlns", NS);
  out.setAttribute("viewBox", `${minX} ${minY} ${w} ${h}`);
  out.setAttribute("class", "print-svg");
  out.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Clone just the viewport group (links + nodes), dropping the pan/zoom
  // transform so the viewBox does the scaling.
  const viewport = svgEl.querySelector("g.viewport");
  const clone = viewport.cloneNode(true);
  clone.removeAttribute("transform");
  out.appendChild(clone);
  return out;
}
