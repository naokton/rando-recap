// A horizontal chart plotted against wall-clock time below the map: one of
// elevation / speed / power / temperature at a time, with rests shaded as gaps.
// A thin day/twilight/night ribbon runs along the time axis just below the plot
// (kept out of the plot so the metric line reads cleanly). The metric line
// breaks at each stop (no data spans a rest). Hovering a segment/stop anywhere
// highlights its span here (and vice versa) via the shared linked-hover keys,
// plus a crosshair reads out the value under the cursor. Always whole-ride, even
// when the map is split into panes. buildChart returns { el, destroy }.
import { el, svgNode, makeClockFmt, fmtDur, fmtUnit, DAYNIGHT_COLORS } from "./utils.js";
import { setHover } from "./linked-hover.js";
import { openContextMenu, closeContextMenu } from "./context-menu.js";
import { loadUserParams, saveUserParams } from "./prefs.js";

const CHART_METRICS = [
  { id: "elevation", label: "Elevation", unit: "m", digits: 0, scale: 1 },
  { id: "speed", label: "Speed", unit: "km/h", digits: 1, scale: 3.6 },
  { id: "power", label: "Power", unit: "W", digits: 0, scale: 1 },
  { id: "heartrate", label: "HR", unit: "bpm", digits: 0, scale: 1 },
  { id: "cadence", label: "Cadence", unit: "rpm", digits: 0, scale: 1 },
  { id: "temperature", label: "Temp", unit: "°C", digits: 0, scale: 1 },
];
const CHART_HEIGHT = 210;
// The bottom margin holds the day/night ribbon and the x-axis labels stacked
// below the plot; left holds the y labels.
const CHART_MARGIN = { top: 14, right: 14, bottom: 38, left: 46 };
const CHART_RIBBON_H = 9; // day/night ribbon thickness, in px

// Round a span to a "nice" tick step (1/2/5 × 10ⁿ) for axis ticks.
function niceNum(range) {
  const exp = Math.floor(Math.log10(range || 1));
  const f = range / 10 ** exp;
  const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nf * 10 ** exp;
}
function niceTicks(min, max, count = 4) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step = niceNum((max - min) / Math.max(1, count - 1));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(v);
  return { ticks, min: niceMin, max: niceMax };
}

// Candidate x-axis (time) tick spacings in seconds, coarsening as the ride
// lengthens so labels never crowd.
const CHART_X_STEPS = [300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800];

export function buildChart(data, model, splits, onHoverIndex = () => {}) {
  const series = data.series;
  if (!series || !Array.isArray(series.time) || series.time.length < 2) return null;
  const { activity, stops, segments } = data;
  const lighting = data.lighting || [];
  const time = series.time;
  const n = time.length;
  const tEnd = time[n - 1] || 1;
  const fmtClock = makeClockFmt(activity.start_date, activity.utc_offset_s);

  // A metric is offered only if its stream carries at least one real sample.
  const available = CHART_METRICS.filter(
    (m) => Array.isArray(series[m.id]) && series[m.id].some((v) => v != null),
  );
  if (!available.length) return null;
  let current = available.find((m) => m.id === loadUserParams().chartMetric) || available[0];

  // Index runs between stops — each one segment's worth of contiguous, gap-free
  // samples. Run i lines up with model.segLabels[i], so its line can carry the
  // same data-seg key the tables/timeline/map use.
  const runs = [];
  let lo = 0;
  for (const c of stops) {
    runs.push([lo, c.index_before]);
    lo = c.index_after;
  }
  runs.push([lo, n - 1]);

  // Hit-test spans (by time) for driving linked hover from the chart: each
  // segment's [start,end] and each stop's rest interval.
  const hits = [];
  segments.forEach((s) =>
    hits.push({ x0: time[s.index_start], x1: time[s.index_end], kind: "seg", key: s.label }),
  );
  stops.forEach((c, i) =>
    hits.push({ x0: c.time_before_s, x1: c.time_after_s, kind: "stop", key: `c${i}` }),
  );
  const hitAt = (t) => {
    // Stops win ties: their interval sits between two segments' shared endpoint.
    for (const h of hits) if (h.kind === "stop" && t >= h.x0 && t <= h.x1) return h;
    for (const h of hits) if (t >= h.x0 && t <= h.x1) return h;
    return null;
  };

  // Nearest sample index to a time (binary search over the monotonic `time`).
  const nearestIdx = (t) => {
    let a = 0;
    let b = n - 1;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (time[mid] < t) a = mid + 1;
      else b = mid;
    }
    if (a > 0 && t - time[a - 1] < time[a] - t) a -= 1;
    return a;
  };

  const container = el("div", { class: "chart" });
  const metricBar = el("div", { class: "chart-metrics" });
  const plot = el("div", { class: "chart-plot" });
  const tooltip = el("div", { class: "chart-tooltip hidden" });
  plot.appendChild(tooltip);
  container.append(metricBar, plot);

  const buttons = available.map((m) =>
    el(
      "button",
      { class: "btn tab-btn chart-metric-btn", type: "button", onclick: () => select(m) },
      m.label,
    ),
  );
  buttons.forEach((b) => metricBar.appendChild(b));

  // Highlight bookkeeping so a chart-driven hover clears cleanly when the
  // cursor crosses from a segment span into a rest (different hover kinds).
  let hoverKind = null;
  let hoverKey = null;
  const setChartHover = (kind, key) => {
    if (kind === hoverKind && key === hoverKey) return;
    if (hoverKind && (hoverKind !== kind || key == null)) setHover(hoverKind, null);
    hoverKind = key == null ? null : kind;
    hoverKey = key;
    if (kind && key != null) setHover(kind, key);
  };

  // Drive the synced map dot, de-duping identical indices so a rest-band sweep
  // (every mousemove yields null) doesn't re-run the per-pane marker update.
  let lastHoverIdx;
  const emitHoverIndex = (idx) => {
    if (idx === lastHoverIdx) return;
    lastHoverIdx = idx;
    onHoverIndex(idx);
  };

  // The scaled series and its y-extent depend only on the chosen metric, not on
  // width — so derive them once per metric here rather than in draw(), which the
  // ResizeObserver fires on every layout change.
  let scaled = [];
  let yTicks = [];
  let yMin = 0;
  let yMax = 1;
  const useMetric = (m) => {
    current = m;
    scaled = series[m.id].map((v) => (v == null ? null : v * m.scale));
    // Spread (Math.min(...)) would overflow the call stack on long rides, so
    // fold the extent in one pass.
    let loV = Infinity;
    let hiV = -Infinity;
    for (const v of scaled) {
      if (v == null) continue;
      if (v < loV) loV = v;
      if (v > hiV) hiV = v;
    }
    ({ ticks: yTicks, min: yMin, max: yMax } = niceTicks(loV, hiV));
  };
  useMetric(current);

  let chartSvg = null;
  function select(m) {
    saveUserParams({ chartMetric: m.id });
    buttons.forEach((b, i) => b.classList.toggle("active", available[i] === m));
    useMetric(m);
    draw();
  }

  function draw() {
    const W = plot.clientWidth;
    if (W < 80) return; // not laid out yet; the ResizeObserver will call back
    const H = CHART_HEIGHT;
    const { top, right, bottom, left } = CHART_MARGIN;
    const innerW = W - left - right;
    const innerH = H - top - bottom;
    const plotBottom = top + innerH;
    const ribbonY = plotBottom; // day/night ribbon sits flush under the x-axis
    const xScale = (t) => left + (t / tEnd) * innerW;
    const yScale = (v) => top + (1 - (v - yMin) / (yMax - yMin || 1)) * innerH;

    const root = svgNode("svg", {
      class: "chart-svg",
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
    });

    // Twilight / night ribbon along the time axis, just below the plot — solid
    // colors, not a background wash. Day is left transparent so only the darker
    // periods stand out. Bands are time-based (`lighting`), so twilight/night
    // inside a rest still shows.
    for (const s of lighting) {
      if (s.state === "day") continue;
      const x0 = xScale(s.start_s);
      const x1 = xScale(s.end_s);
      root.appendChild(
        svgNode("rect", {
          class: "chart-ribbon",
          x: x0,
          y: ribbonY,
          width: Math.max(0, x1 - x0),
          height: CHART_RIBBON_H,
          fill: DAYNIGHT_COLORS[s.state] || "#999",
        }),
      );
    }

    // Y gridlines + labels. niceTicks bounds every tick to [yMin, yMax].
    for (const t of yTicks) {
      const y = yScale(t);
      root.appendChild(
        svgNode("line", { class: "chart-grid", x1: left, y1: y, x2: left + innerW, y2: y }),
      );
      root.appendChild(
        svgNode(
          "text",
          { class: "chart-axis-label", x: left - 6, y: y + 3, "text-anchor": "end" },
          String(Math.round(t * 10) / 10),
        ),
      );
    }

    // Rest bands across the plot, keyed for linked hover. Painted after the
    // gridlines with an opaque fill so the horizontal lines don't show through.
    stops.forEach((c, i) => {
      const x0 = xScale(c.time_before_s);
      const x1 = xScale(c.time_after_s);
      root.appendChild(
        svgNode("rect", {
          class: "chart-rest",
          "data-stop": `c${i}`,
          x: x0,
          y: top,
          width: Math.max(1, x1 - x0),
          height: innerH,
        }),
      );
    });

    // X (time) ticks, labeled as clock time in the ride's local zone.
    const maxXTicks = Math.max(3, Math.floor(innerW / 90));
    const xStep =
      CHART_X_STEPS.find((s) => tEnd / s <= maxXTicks) || CHART_X_STEPS[CHART_X_STEPS.length - 1];
    // No tick stubs below the axis — the ribbon abuts it; labels sit below.
    for (let t = 0; t <= tEnd + 1; t += xStep) {
      root.appendChild(
        svgNode(
          "text",
          { class: "chart-axis-label", x: xScale(t), y: H - 8, "text-anchor": "middle" },
          fmtClock(t),
        ),
      );
    }

    // Metric line, one path per segment run so it breaks across rests and
    // carries the segment's hover key. Null samples within a run break the pen.
    runs.forEach(([a, b], i) => {
      let d = "";
      let pen = false;
      for (let j = a; j <= b; j++) {
        const v = scaled[j];
        if (v == null) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${xScale(time[j]).toFixed(1)} ${yScale(v).toFixed(1)} `;
        pen = true;
      }
      if (d)
        root.appendChild(
          svgNode("path", { class: "chart-line", "data-seg": model.segLabels[i], d }),
        );
    });

    // Axis frame (left + bottom) and the active metric's unit.
    root.appendChild(
      svgNode("line", { class: "chart-axis", x1: left, y1: top, x2: left, y2: top + innerH }),
    );
    root.appendChild(
      svgNode("line", {
        class: "chart-axis",
        x1: left,
        y1: top + innerH,
        x2: left + innerW,
        y2: top + innerH,
      }),
    );
    root.appendChild(svgNode("text", { class: "chart-unit", x: left, y: top - 4 }, current.unit));

    // Crosshair (vertical line + dot), shown on hover.
    const cross = svgNode("line", { class: "chart-crosshair", y1: top, y2: top + innerH });
    const dot = svgNode("circle", { class: "chart-dot", r: 5 });
    cross.style.display = "none";
    dot.style.display = "none";
    root.appendChild(cross);
    root.appendChild(dot);

    // Transparent top overlay captures pointer movement for crosshair + hover.
    const overlay = svgNode("rect", {
      class: "chart-overlay",
      x: left,
      y: top,
      width: innerW,
      height: innerH,
    });
    overlay.addEventListener("mousemove", (e) => {
      const rect = root.getBoundingClientRect();
      const px = Math.max(left, Math.min(e.clientX - rect.left, left + innerW));
      const t = ((px - left) / innerW) * tEnd;
      cross.style.display = "";
      cross.setAttribute("x1", px);
      cross.setAttribute("x2", px);

      const hit = hitAt(t);
      setChartHover(hit ? hit.kind : null, hit ? hit.key : null);

      const restHit = hit && hit.kind === "stop" ? hit : null;
      // Rest bands are clickable to split there, so flag them with a pointer;
      // otherwise defer to the overlay's CSS crosshair (clear the override).
      overlay.style.cursor = restHit ? "pointer" : "";
      let label;
      let hoverIdx = null;
      if (restHit) {
        const k = parseInt(restHit.key.slice(1), 10);
        dot.style.display = "none";
        label = `Rest · ${fmtDur(stops[k].rest_s)}`;
      } else {
        const idx = nearestIdx(t);
        const v = scaled[idx];
        if (v == null) {
          dot.style.display = "none";
          label = `${fmtClock(time[idx])} · -`;
        } else {
          dot.style.display = "";
          dot.setAttribute("cx", xScale(time[idx]));
          dot.setAttribute("cy", yScale(v));
          hoverIdx = idx;
          label = `${fmtClock(time[idx])} · ${fmtUnit(v, current.unit, current.digits)}`;
        }
      }
      emitHoverIndex(hoverIdx);
      tooltip.textContent = label;
      tooltip.classList.remove("hidden");
      // Clamp the tooltip within the plot, flipping left of the cursor near the
      // right edge so it never overflows.
      const tw = tooltip.offsetWidth;
      let tx = px + 10;
      if (tx + tw > W) tx = px - 10 - tw;
      tooltip.style.left = `${Math.max(0, tx)}px`;
      tooltip.style.top = `${top}px`;
    });
    // Clicking a rest band offers "Split here" — the same action as the map's
    // stop-marker menu, driving the shared splits store by stop index.
    overlay.addEventListener("click", (e) => {
      const rect = root.getBoundingClientRect();
      const px = Math.max(left, Math.min(e.clientX - rect.left, left + innerW));
      const t = ((px - left) / innerW) * tEnd;
      const hit = hitAt(t);
      if (!hit || hit.kind !== "stop") return;
      const i = parseInt(hit.key.slice(1), 10);
      openContextMenu(e, [{ label: "Split here", onSelect: () => splits.add(i) }]);
    });
    overlay.addEventListener("mouseleave", () => {
      cross.style.display = "none";
      dot.style.display = "none";
      tooltip.classList.add("hidden");
      emitHoverIndex(null);
      setChartHover(null, null);
    });
    root.appendChild(overlay);

    if (chartSvg) chartSvg.replaceWith(root);
    else plot.insertBefore(root, tooltip);
    chartSvg = root;
  }

  buttons.forEach((b, i) => b.classList.toggle("active", available[i] === current));
  const ro = new ResizeObserver(() => draw());
  ro.observe(plot);

  return {
    el: container,
    destroy: () => {
      ro.disconnect();
      closeContextMenu();
      emitHoverIndex(null);
      setChartHover(null, null);
    },
  };
}
