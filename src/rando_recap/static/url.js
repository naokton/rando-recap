// URL ↔ state mapping. Extracted from the router so views can read the current
// route (parseHash) and request a navigation (setHash) without importing the
// router — keeping the module graph a pure DAG.
import { loadUserParams, parseMinDist } from "./prefs.js";

export function parseHash() {
  const saved = loadUserParams();
  const h = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(h);
  const ride = params.get("ride");
  if (ride) {
    // min_stop / merge_within_m are app config (persisted prefs), not URL
    // state, so the hash carries only the ride id.
    return {
      view: "analysis",
      rideId: ride,
      minStop: saved.minStop,
      mergeWithinM: saved.mergeWithinM,
    };
  }
  const minDistParam = params.get("min_dist");
  return {
    view: "list",
    minDist: minDistParam != null ? parseMinDist(minDistParam) : saved.minDist,
  };
}

export function setHash(params) {
  window.location.hash = new URLSearchParams(params).toString();
}
