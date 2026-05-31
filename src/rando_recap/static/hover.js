// --- linked hover/highlight --------------------------------------------
// Stops and segments appear on the map, timeline, and tables. Hovering one
// peer highlights the others. DOM peers carry data-stop / data-seg keys
// (stops: "start" / "end" / "c<i>"; segments: the label string). Map peers
// (stop markers and segment polylines) register a highlight callback in
// link.<kind>.peers via registerMapPeer.
//
// peers is keyed by (stop/seg) key with an array of fns: in split-map mode
// the same segment can appear on both halves (the spanning segment) and the
// snap stop's marker is shown on both maps, so a key may have >1 peer.
//
// `link` is owned here and reachable only through these functions. It is set
// while an analysis view is mounted (beginHover) and cleared on teardown
// (endHover); every entry point no-ops when it is null, so peers registered by
// a stale/detached view are inert.
import { root } from "./utils.js";

let link = null;
const HOVER_KINDS = ["stop", "seg"];

function makeLink() {
  return {
    stop: { hovered: null, peers: new Map() },
    seg: { hovered: null, peers: new Map() },
  };
}

// Begin/end the linked-hover session. The analysis view calls beginHover once
// its data resolves (so peers have something to register against) and endHover
// from its destroy.
export function beginHover() {
  link = makeLink();
}
export function endHover() {
  link = null;
}

export function registerMapPeer(kind, key, source, applyHighlight) {
  let arr = link[kind].peers.get(key);
  if (!arr) {
    arr = [];
    link[kind].peers.set(key, arr);
  }
  arr.push(applyHighlight);
  source.on("mouseover", () => setHover(kind, key));
  source.on("mouseout", () => setHover(kind, null));
}

export function clearMapPeers() {
  if (!link) return;
  for (const kind of HOVER_KINDS) link[kind].peers.clear();
}

function applyHover(kind, key) {
  if (!link) return;
  const k = link[kind];
  const active = k.hovered === key;
  root
    .querySelectorAll(`[data-${kind}="${CSS.escape(key)}"]`)
    .forEach((el) => el.classList.toggle("hl", active));
  const arr = k.peers.get(key);
  if (arr) for (const fn of arr) fn(active);
}

export function setHover(kind, key) {
  if (!link) return;
  const k = link[kind];
  if (k.hovered === key) return;
  const prev = k.hovered;
  k.hovered = key;
  if (prev) applyHover(kind, prev);
  if (key) applyHover(kind, key);
}

// Wire the DOM-side hover delegation onto the persistent #root. Called once at
// boot (root outlives every view), so the listeners stay put while views swap;
// they no-op until beginHover sets up `link`.
export function wireHover(rootEl) {
  rootEl.addEventListener("mouseover", (e) => {
    for (const kind of HOVER_KINDS) {
      const el = e.target.closest(`[data-${kind}]`);
      if (el) setHover(kind, el.dataset[kind]);
    }
  });
  rootEl.addEventListener("mouseout", (e) => {
    // mouseout fires on transitions between children too; only clear when the
    // cursor actually leaves the tagged element.
    for (const kind of HOVER_KINDS) {
      const el = e.target.closest(`[data-${kind}]`);
      if (el && !el.contains(e.relatedTarget)) setHover(kind, null);
    }
  });
}
