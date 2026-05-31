// localStorage-backed user preferences and the duration/validator helpers that
// surround them. A dependency leaf — imports no other app module.

export const DEFAULT_MIN_DIST_KM = 190;
export const DEFAULT_MIN_STOP = "5m";
export const DEFAULT_MERGE_WITHIN_M = 100;
const DEFAULT_FETCH_SINCE = "1m";
const DEFAULT_CHART_METRIC = "elevation";
const STORAGE_KEY_USER_PARAMS = "rando-recap.user-params";
// Windows offered by the Fetch popover; values are what the API's `since` param
// accepts (Nd/Nw/Nm/Ny or 'all'). Labels are user-facing.
export const FETCH_WINDOWS = [
  { value: "1w", label: "Last week" },
  { value: "1m", label: "Last month" },
  { value: "6m", label: "Last 6 months" },
  { value: "1y", label: "Last year" },
  { value: "all", label: "All time" },
];
// Mirror of the backend floor (stops.py MIN_STOP_FLOOR_S): the ~1s sample
// interval means a threshold at or below 1s flags every point as a stop, so
// the API rejects it. Require strictly more than this in the form too.
export const MIN_STOP_FLOOR_S = 1;

// Parse a duration string ('5m', '300s', '1h', '90') to seconds, mirroring
// the backend parse_duration. Returns null on unrecognized input.
export function minStopToSeconds(value) {
  const m = String(value)
    .trim()
    .match(/^(\d+)\s*([smh]?)$/i);
  if (!m) return null;
  const unit = (m[2] || "m").toLowerCase();
  return parseInt(m[1], 10) * { s: 1, m: 60, h: 3600 }[unit];
}

// Break total seconds into {h, m, s} for the form fields.
export function secondsToHMS(total) {
  const t = Math.max(0, Math.floor(total));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

export function parseMinDist(s) {
  const v = parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_DIST_KM;
}

export function parseMergeWithin(s) {
  const v = parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MERGE_WITHIN_M;
}

export function parseFetchSince(s) {
  return FETCH_WINDOWS.some((w) => w.value === s) ? s : DEFAULT_FETCH_SINCE;
}

// Persisted UI preferences so they survive list → analysis → list navigation
// and reloads. The URL hash still carries authoritative state when present;
// these values fill in defaults when params are absent (e.g. on `#`).
export function loadUserParams() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER_PARAMS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          minDist: parseMinDist(parsed.minDist),
          minStop:
            typeof parsed.minStop === "string" && parsed.minStop
              ? parsed.minStop
              : DEFAULT_MIN_STOP,
          mergeWithinM: parseMergeWithin(parsed.mergeWithinM),
          fetchSince: parseFetchSince(parsed.fetchSince),
          chartMetric:
            typeof parsed.chartMetric === "string" && parsed.chartMetric
              ? parsed.chartMetric
              : DEFAULT_CHART_METRIC,
        };
      }
    }
  } catch {}
  return {
    minDist: DEFAULT_MIN_DIST_KM,
    minStop: DEFAULT_MIN_STOP,
    mergeWithinM: DEFAULT_MERGE_WITHIN_M,
    fetchSince: DEFAULT_FETCH_SINCE,
    chartMetric: DEFAULT_CHART_METRIC,
  };
}

export function saveUserParams(partial) {
  try {
    const merged = { ...loadUserParams(), ...partial };
    localStorage.setItem(STORAGE_KEY_USER_PARAMS, JSON.stringify(merged));
  } catch {}
}
