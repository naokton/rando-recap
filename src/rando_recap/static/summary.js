// Shared summary builders, used by both the whole-ride summary (analysis view)
// and the per-pane summaries shown under each split map (map module).
import { el, fmtDur, fmtPct } from "./utils.js";

export function summaryItem(label, value) {
  return el(
    "div",
    { class: "item" },
    el("span", { class: "label" }, `${label}:`),
    el("span", { class: "value" }, value),
  );
}

// The whole ride's Elapsed time split into the four segments the summary bar and
// its legend both render — moving time as day/twilight/night, then rest = elapsed
// − moving. Each entry is [key, label, seconds]; the four sum to Elapsed.
function dnRestParts(a) {
  const rest = Math.max(0, a.elapsed_time_s - a.moving_time_s);
  return [
    ["day", "Day", a.moving_day_time_s || 0],
    ["twilight", "Twilight", a.moving_twilight_time_s || 0],
    ["night", "Night", a.moving_night_time_s || 0],
    ["rest", "Rest", rest],
  ];
}

// Horizontal stacked bar visualizing how an Elapsed time divides into moving
// (day/twilight/night) and rest. Takes normalized [key, label, seconds] parts so
// the whole-ride summary and the per-pane summaries can share one bar. Segment
// widths are proportional (flex-grow); each shows its day/night glyph (reusing
// the `dn-*` icons) and share inline, clipped on segments too narrow to fit,
// with a tooltip label.
export function dnRestBar(parts) {
  const total = parts.reduce((acc, [, , v]) => acc + v, 0);
  if (total <= 0) return null;
  return el(
    "div",
    { class: "summary-bar" },
    ...parts
      .filter(([, , v]) => v > 0)
      .map(([key, label, v]) =>
        el(
          "div",
          { class: `seg seg-${key}`, style: `flex:${v} 1 0`, title: `${label} ${fmtPct(v / total)}` },
          el("span", { class: `icon dn-${key}` }),
          el("span", { class: "seg-label" }, fmtPct(v / total)),
        ),
      ),
  );
}

// Durations for the bar's four segments, color-matched to the bar — the exact
// day/twilight/night/rest times, read as the bar's own legend. Glyph + duration
// only; the segment name is conveyed by the glyph (and the bar's own tooltip).
export function dnRestLegend(parts) {
  return el(
    "div",
    { class: "bar-legend" },
    ...parts
      .filter(([, , v]) => v > 0)
      .map(([key, label, v]) =>
        el(
          "div",
          { class: `legend-item lg-${key}` },
          el("span", { class: `icon dn-${key}`, title: label }),
          el("span", { class: "lg-value" }, fmtDur(v)),
        ),
      ),
  );
}

// Whole-ride summary bar + legend: thin wrappers that compute the four parts
// from Strava activity aggregates, then defer to the shared dn/rest builders.
export function summaryBar(a) {
  return dnRestBar(dnRestParts(a));
}
export function barLegend(a) {
  return dnRestLegend(dnRestParts(a));
}
