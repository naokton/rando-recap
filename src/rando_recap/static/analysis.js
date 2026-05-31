// The analysis view: title, whole-ride summary, map, chart, and the tabbed
// timeline / stops+segments tables for one ride. AnalysisView returns
// { el, destroy }; it is constructed synchronously (returning a "Loading…"
// placeholder) and filled when the data resolves, so destroy must null-guard
// the pieces built on resolve (map / chart / linked hover).
import {
  el,
  fetchJson,
  makeClockFmt,
  fmtDur,
  fmtKmh,
  fmtUnit,
  fmtNum,
  fmtPct,
  fmtTempRange,
} from "./utils.js";
import { saveUserParams } from "./prefs.js";
import { beginHover, endHover } from "./hover.js";
import { summaryItem, summaryBar, barLegend } from "./summary.js";
import { buildMapArea } from "./map.js";
import { buildChart } from "./chart.js";
import * as ViewHost from "./viewhost.js";

// --- section tabs ------------------------------------------------------
// Tab bar that shows exactly one of its panels at a time. Each tab is
// { label, panel }; the first is shown initially. Returns a wrapper holding
// the buttons and all panels (inactive ones carry .hidden).
function buildSectionTabs(tabs) {
  const select = (active) => {
    for (const t of tabs) {
      const on = t === active;
      t.panel.classList.toggle("hidden", !on);
      t.btn.classList.toggle("active", on);
      t.btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  };
  const bar = el("div", { class: "view-tabs", role: "tablist" });
  for (const t of tabs) {
    t.btn = el(
      "button",
      { class: "btn tab-btn", type: "button", role: "tab", onclick: () => select(t) },
      t.label,
    );
    bar.appendChild(t.btn);
  }
  const wrap = el("div", { class: "tabbed" }, bar, ...tabs.map((t) => t.panel));
  select(tabs[0]);
  return wrap;
}

// --- timeline ----------------------------------------------------------
function buildTimelineModel(stops, segments) {
  const stopLabels = ["Start", ...stops.map((_, i) => `S${i + 1}`), "End"];
  const segByLabel = Object.fromEntries(segments.map((s) => [s.label, s]));
  const segLabels = stopLabels.slice(0, -1).map((s, i) => `${s} → ${stopLabels[i + 1]}`);
  const orderedSegs = segLabels.map((l) => segByLabel[l] ?? null);
  const cumKm = [0];
  for (const s of orderedSegs) cumKm.push(cumKm[cumKm.length - 1] + (s ? s.distance_m / 1000 : 0));
  const lastSeg = orderedSegs[orderedSegs.length - 1];
  const endS = stops.length
    ? stops[stops.length - 1].time_after_s + (lastSeg ? lastSeg.duration_s : 0)
    : orderedSegs[0]
      ? orderedSegs[0].duration_s
      : 0;
  return { stopLabels, segLabels, orderedSegs, cumKm, endS };
}

function renderTimeline(activity, stops, model) {
  const fmtClock = makeClockFmt(activity.start_date, activity.utc_offset_s);
  const { stopLabels, segLabels, orderedSegs, cumKm, endS } = model;

  const wrap = el("div", { class: "timeline-wrap" });
  const grid = el("div", { class: "timeline" });

  // Build columns: stop, seg, stop, seg, ..., stop
  let col = 1;
  stopLabels.forEach((label, i) => {
    let arrive = null,
      depart = null,
      rest = null,
      stopKey;
    if (label === "Start") {
      depart = fmtClock(0);
      rest = 0;
      stopKey = "start";
    } else if (label === "End") {
      arrive = fmtClock(endS);
      rest = 0;
      stopKey = "end";
    } else {
      const c = stops[i - 1];
      arrive = fmtClock(c.time_before_s);
      depart = fmtClock(c.time_after_s);
      rest = c.rest_s;
      stopKey = `c${i - 1}`;
    }
    const stopCol = col++;
    grid.appendChild(
      el(
        "div",
        {
          class: "stop-cell",
          style: `grid-column: ${stopCol}`,
          "data-stop": stopKey,
        },
        el("div", { class: "lab" }, label),
        el("div", { class: "km" }, `${cumKm[i].toFixed(1)} km`),
        el(
          "div",
          { class: "clock" },
          arrive && depart ? `${arrive} → ${depart}` : depart || arrive,
        ),
        el("div", { class: "rest" }, rest != null ? (rest === 0 ? "0m" : fmtDur(rest)) : ""),
      ),
    );
    grid.appendChild(
      el(
        "div",
        { class: "track-stop", style: `grid-column: ${stopCol}`, "data-stop": stopKey },
        el("span", { class: "dot" }),
      ),
    );

    if (i < orderedSegs.length) {
      const segCol = col++;
      grid.appendChild(el("div", { class: "track-seg", style: `grid-column: ${segCol}` }));
      const s = orderedSegs[i];
      const cell = el("div", {
        class: "seg-cell",
        style: `grid-column: ${segCol}`,
        "data-seg": segLabels[i],
      });
      if (!s) {
        cell.appendChild(el("div", {}, "(no movement)"));
      } else {
        cell.appendChild(el("div", { class: "km" }, `${(s.distance_m / 1000).toFixed(1)} km`));
        cell.appendChild(el("div", {}, fmtDur(s.duration_s)));
        cell.appendChild(
          el("div", {}, s.avg_speed_mps == null ? "-" : `${fmtKmh(s.avg_speed_mps)} km/h`),
        );
        cell.appendChild(el("div", {}, fmtUnit(s.avg_hr, "bpm")));
        cell.appendChild(el("div", {}, fmtUnit(s.climb_m, "m↑")));
      }
      grid.appendChild(cell);
    }
  });

  wrap.appendChild(grid);
  return wrap;
}

// --- tables ------------------------------------------------------------
function renderStopsTable(activity, stops, model, onToggleSplit) {
  const { cumKm, endS } = model;
  const fmtClock = makeClockFmt(activity.start_date, activity.utc_offset_s);
  // Bookend the stops with Start/End rows so the table lines up row-for-row
  // with the Segments table beside it (Start, Start→S1, S1, S1→S2, …). They
  // carry the same data-stop keys as the timeline/map peers ("start"/"end"),
  // so linked hover highlighting works without extra wiring.
  const row = (key, label, km, arrive, depart, rest, splitCell) =>
    el(
      "tr",
      { class: "row", "data-stop": key },
      el("td", {}, label),
      el("td", {}, km),
      el("td", {}, arrive),
      el("td", {}, depart),
      el("td", {}, rest),
      el("td", { class: "split-cell" }, splitCell),
    );
  // Only the interior stops are splittable; the Start/End bookends get an empty
  // cell. The checkbox's checked state is owned by buildMapArea.syncSplitStops
  // (single source of truth = the splits set), so onToggleSplit just reports the
  // click and the re-render flips it back if needed.
  const splitToggle = (i) =>
    el("input", {
      type: "checkbox",
      class: "split-toggle",
      title: "Split route here",
      "aria-label": `Split route at S${i + 1}`,
      onchange: () => onToggleSplit(i),
    });
  return el(
    "table",
    { class: "data" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", {}, "#"),
        el("th", {}, "Dist (km)"),
        el("th", {}, "Arrive"),
        el("th", {}, "Depart"),
        el("th", {}, "Rest"),
        el("th", { class: "split-cell" }, "Split"),
      ),
    ),
    el(
      "tbody",
      {},
      row("start", "Start", cumKm[0].toFixed(1), "-", fmtClock(0), "-", null),
      stops.map((c, i) =>
        row(
          `c${i}`,
          `S${i + 1}`,
          cumKm[i + 1].toFixed(1),
          fmtClock(c.time_before_s),
          fmtClock(c.time_after_s),
          fmtDur(c.rest_s),
          splitToggle(i),
        ),
      ),
      row("end", "End", cumKm[cumKm.length - 1].toFixed(1), fmtClock(endS), "-", "-", null),
    ),
  );
}

function renderSegmentsTable(segments) {
  return el(
    "table",
    { class: "data segments" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", {}, "Segment"),
        el("th", {}, "Dist km"),
        el("th", {}, "Time"),
        el("th", {}, "km/h"),
        el("th", {}, "Power"),
        el("th", {}, "HR"),
        el("th", {}, "Cad"),
        el("th", {}, "°C"),
        el("th", {}, "Coast"),
        el("th", {}, "Climb m"),
        el("th", {}, "Climb m/km"),
      ),
    ),
    el(
      "tbody",
      {},
      segments.map((s) =>
        el(
          "tr",
          { class: "row", "data-seg": s.label },
          el("td", {}, s.label),
          el("td", {}, (s.distance_m / 1000).toFixed(2)),
          el("td", {}, fmtDur(s.duration_s)),
          el("td", {}, fmtKmh(s.avg_speed_mps)),
          el("td", {}, fmtNum(s.avg_watts)),
          el("td", {}, fmtNum(s.avg_hr)),
          el("td", {}, fmtNum(s.avg_cadence)),
          el("td", {}, fmtNum(s.avg_temp)),
          el("td", {}, fmtPct(s.coasting_frac)),
          el("td", {}, fmtNum(s.climb_m)),
          el("td", {}, fmtNum(s.climb_m_per_km, 1)),
        ),
      ),
    ),
  );
}

// --- analysis view -----------------------------------------------------
// `refresh` is a one-shot: when true we ask the backend to re-fetch this ride's
// streams from Strava (costs an API call). It is deliberately NOT persisted to
// user-params and NOT carried in the URL hash — a reload or back-nav must reload
// from cache, never silently re-spend quota. The refresh button just re-shows a
// fresh AnalysisView with it set; the next route() drops back to refresh=false.
export function AnalysisView(rideId, minStop, mergeWithinM, refresh = false) {
  saveUserParams({ minStop, mergeWithinM });
  // `el` now, fill later: return a placeholder synchronously and replaceChildren
  // it when the load resolves. destroy may fire before then, so guard the pieces.
  const elRoot = el(
    "div",
    {},
    el("div", { class: "empty" }, refresh ? "Refreshing from Strava…" : "Loading…"),
  );
  let map = null;
  let chart = null;
  let hovering = false;

  const qs = new URLSearchParams({ min_stop: minStop, merge_within_m: mergeWithinM });
  if (refresh) qs.set("refresh", "true");

  fetchJson(`/api/rides/${rideId}/analysis?${qs}`)
    .then((data) => {
      // Linked-hover state begins only with data, before the map/chart register
      // their peers against it.
      beginHover();
      hovering = true;

      const a = data.activity;
      const model = buildTimelineModel(data.stops, data.segments);

      // Re-fetch this ride's streams from Strava — a re-render in place, so the
      // host disposes the current view before mounting the fresh one.
      const refreshBtn = el("button", {
        class: "icon refresh-btn",
        type: "button",
        title: "Refresh GPS data from Strava",
        "aria-label": "Refresh GPS data from Strava",
        onclick: () => ViewHost.show(AnalysisView(rideId, minStop, mergeWithinM, true)),
      });
      const title = el(
        "h2",
        { class: "ride-title" },
        a.name || "(unnamed ride)",
        el("span", { class: "date" }, `(${(a.start_date_local || a.start_date || "").slice(0, 10)})`),
        refreshBtn,
      );

      // Strava attribution: link displayed data back to its source activity on
      // Strava. Combined rides expose their component ids as `combined:N,N,...`.
      const rawId = String(a.id || "");
      const sourceIds = rawId.startsWith("combined:")
        ? rawId.slice("combined:".length).split(",").filter(Boolean)
        : rawId
          ? [rawId]
          : [];
      let sourceLinks = null;
      if (sourceIds.length) {
        const multi = sourceIds.length > 1;
        const links = [];
        sourceIds.forEach((id, i) => {
          if (i) links.push(" · ");
          // Strava Brand Guidelines §3: the link text must read "View on Strava".
          // For merged rides the ordinal stays inside the anchor so each link
          // still leads with the required phrase.
          links.push(
            el(
              "a",
              {
                class: "strava-link",
                href: `https://www.strava.com/activities/${encodeURIComponent(id)}`,
                target: "_blank",
                rel: "noopener external",
              },
              multi ? `View on Strava (${i + 1})` : "View on Strava",
            ),
          );
        });
        sourceLinks = el("div", { class: "source-links" }, ...links);
      }

      // Two groups: physical metrics, then a time block stacking headline figures
      // over the summary bar and its breakdown legend (Elapsed = the four segments).
      const timeGroup = el(
        "div",
        { class: "metric-group time-group" },
        el(
          "div",
          { class: "time-figures" },
          summaryItem("Elapsed", fmtDur(a.elapsed_time_s)),
          summaryItem("Moving", fmtDur(a.moving_time_s)),
        ),
      );
      const bar = summaryBar(a);
      if (bar) {
        timeGroup.appendChild(bar);
        timeGroup.appendChild(barLegend(a));
      }
      const summary = el(
        "div",
        { class: "summary" },
        el(
          "div",
          { class: "metric-group" },
          summaryItem("Distance", `${(a.distance_m / 1000).toFixed(1)} km`),
          summaryItem("Climb", `${Math.round(a.total_elevation_gain_m || 0)} m`),
          summaryItem("Coast", fmtPct(a.coasting_frac)),
          summaryItem("Temp", fmtTempRange(a.temp_avg_c, a.temp_min_c, a.temp_max_c)),
        ),
        timeGroup,
      );

      // Map — owns its whole subtree (maps + resize handle + per-pane summaries).
      map = buildMapArea(data, model);

      // Chart — full-width, directly below the map; whole-ride regardless of splits.
      chart = buildChart(data, model, (idx) => map && map.setHoverIndex(idx));

      // Timeline / Tables — tabbed so only one shows at a time.
      const timelinePanel = renderTimeline(data.activity, data.stops, model);
      const tablesPanel = el(
        "div",
        { class: "tables-row" },
        el(
          "section",
          {},
          el("h2", {}, "Stops"),
          renderStopsTable(data.activity, data.stops, model, (i) => map && map.toggleSplit(i)),
        ),
        el("section", {}, el("h2", {}, "Segments"), renderSegmentsTable(data.segments)),
      );
      const tabs = buildSectionTabs([
        { label: "Tables", panel: tablesPanel },
        { label: "Timeline", panel: timelinePanel },
      ]);

      // replaceChildren rejects null, so drop the optional pieces (source links,
      // chart) that may be absent.
      elRoot.replaceChildren(
        ...[title, sourceLinks, summary, map.el, chart ? chart.el : null, tabs].filter(Boolean),
      );
    })
    .catch((e) =>
      elRoot.replaceChildren(el("div", { class: "error" }, `Failed to load analysis: ${e.message}`)),
    );

  return {
    el: elRoot,
    destroy() {
      // May fire before the load resolves, so guard the pieces built on resolve.
      if (map) map.destroy();
      if (chart) chart.destroy();
      if (hovering) endHover();
    },
  };
}
