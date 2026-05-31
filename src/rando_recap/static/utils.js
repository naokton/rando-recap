// Pure helpers shared across the app: the #root handle, formatters, the el()/
// svgNode() DOM builders, fetchJson(), and the resolved CSS palette. A
// dependency leaf — imports no other app module.

export const root = document.getElementById("root");

// --- formatters --------------------------------------------------------
export function fmtDur(seconds) {
  if (seconds == null) return "-";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
export function fmtNum(v, digits = 0) {
  return v == null ? "-" : v.toFixed(digits);
}
export function fmtUnit(v, unit, digits = 0) {
  return v == null ? "-" : `${v.toFixed(digits)} ${unit}`;
}
export function fmtKmh(mps, digits = 1) {
  return mps == null ? "-" : (mps * 3.6).toFixed(digits);
}
export function fmtPct(frac) {
  return frac == null ? "-" : `${Math.round(frac * 100)}%`;
}
// "18°C (9–27°C)" — drops the range when min/max round equal or are missing.
export function fmtTempRange(avg, min, max) {
  if (avg == null) return "-";
  const a = `${Math.round(avg)}°C`;
  if (min != null && max != null && Math.round(min) !== Math.round(max))
    return `${a} (${Math.round(min)}–${Math.round(max)}°C)`;
  return a;
}

export function makeClockFmt(startIso, utcOffsetS) {
  // start_date is UTC ISO; show clock in the activity's local tz (= utc_offset).
  const startMs = Date.parse(startIso);
  const offsetMs = (utcOffsetS || 0) * 1000;
  return (offsetSec) => {
    const t = new Date(startMs + offsetSec * 1000 + offsetMs);
    const hh = String(t.getUTCHours()).padStart(2, "0");
    const mm = String(t.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };
}

// --- DOM builders ------------------------------------------------------
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    // Any on* key whose value is a function binds that event listener, so
    // handlers declare inline alongside the element instead of a trailing
    // addEventListener (onclick, onsubmit, onchange, …).
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

// SVG sibling of el(): builds namespaced nodes for the chart. Attributes are
// set verbatim (no class/on* sugar) since the chart wires events by hand.
const SVGNS = "http://www.w3.org/2000/svg";
export function svgNode(tag, attrs = {}, ...children) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

export async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body.detail) msg = body.detail;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// --- color palette -----------------------------------------------------
// Map colors live in style.css (:root) so the palette has one home; Leaflet
// can't read CSS vars itself, so we resolve them once at load. The stylesheet
// is <link>ed in <head> before this module runs, so the values are available.
const cssVar = (() => {
  const rootStyle = getComputedStyle(document.documentElement);
  return (name) => rootStyle.getPropertyValue(name).trim();
})();
export const SEGMENT_COLOR = cssVar("--segment");
export const SEGMENT_HOVER_COLOR = cssVar("--segment-hover");
export const STOP_COLOR = cssVar("--stop");
export const DAYNIGHT_COLORS = {
  day: SEGMENT_COLOR,
  twilight: cssVar("--twilight"),
  night: cssVar("--night"),
};
