// config.js — optional, hand-editable runtime settings (config.json).
//
// Settings are applied on the fly (e.g. a CSS filter over photos) so the source
// images on disk stay untouched. config.json is OPTIONAL: if it's missing,
// blocked (file://), or malformed, we silently fall back to DEFAULT_CONFIG —
// the app never fails to start because of settings.

const CONFIG_URL = "config.json";

export const DEFAULT_CONFIG = {
  // Aged-photo look: applied to every <img>/SVG image via --photo-filter.
  photoFilter: {
    enabled: true,
    sepia: 0.55,
    contrast: 1.08,
    brightness: 0.96,
    saturate: 0.9,
    grayscale: 0,
    blur: 0,        // px
    hueRotate: 0,   // deg
  },
};

export async function loadConfig() {
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-store" });
    if (!res.ok) return clone(DEFAULT_CONFIG);
    return merge(DEFAULT_CONFIG, await res.json());
  } catch {
    return clone(DEFAULT_CONFIG); // missing file, file://, or invalid JSON
  }
}

// Build a CSS `filter` value, emitting only terms that actually change the
// image so the result stays readable (and cheap when everything's at identity).
export function buildPhotoFilter(pf = DEFAULT_CONFIG.photoFilter) {
  if (!pf || pf.enabled === false) return "none";
  const n = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
  const terms = [];
  if (n(pf.sepia, 0) > 0) terms.push(`sepia(${n(pf.sepia, 0)})`);
  if (n(pf.contrast, 1) !== 1) terms.push(`contrast(${n(pf.contrast, 1)})`);
  if (n(pf.brightness, 1) !== 1) terms.push(`brightness(${n(pf.brightness, 1)})`);
  if (n(pf.saturate, 1) !== 1) terms.push(`saturate(${n(pf.saturate, 1)})`);
  if (n(pf.grayscale, 0) > 0) terms.push(`grayscale(${n(pf.grayscale, 0)})`);
  if (n(pf.blur, 0) > 0) terms.push(`blur(${n(pf.blur, 0)}px)`);
  if (n(pf.hueRotate, 0) !== 0) terms.push(`hue-rotate(${n(pf.hueRotate, 0)}deg)`);
  return terms.length ? terms.join(" ") : "none";
}

// Expose the photo filter as a CSS variable so any image picks it up via
// `filter: var(--photo-filter)` — no per-element wiring needed.
export function applyConfig(config) {
  const filter = buildPhotoFilter(config && config.photoFilter);
  document.documentElement.style.setProperty("--photo-filter", filter);
}

function merge(base, override) {
  const out = clone(base);
  if (override && typeof override === "object" && override.photoFilter) {
    Object.assign(out.photoFilter, override.photoFilter);
  }
  return out;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
