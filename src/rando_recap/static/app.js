const root = document.getElementById("root");

// --- constants ---------------------------------------------------------
const DEFAULT_MIN_DIST_KM = 190;
const DEFAULT_MIN_STOP = "5m";

const SEGMENT_COLOR = "#048f67";
const SEGMENT_HOVER_COLOR = "#0ea5e9";
const CONTROL_COLOR = "#dc2626";
const DAYNIGHT_COLORS = { day: SEGMENT_COLOR, twilight: "#1c8bc4", night: "#033b73" };

const MIN_MAP_HEIGHT_PX = 200;
const CONTROL_MARKER_MIN_R = 3;
const CONTROL_MARKER_MAX_R = 40;

function fmtDur(seconds) {
  if (seconds == null) return "-";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
function fmtNum(v, digits = 0) {
  return v == null ? "-" : v.toFixed(digits);
}
function fmtUnit(v, unit, digits = 0) {
  return v == null ? "-" : `${v.toFixed(digits)} ${unit}`;
}
function fmtKmh(mps, digits = 1) {
  return mps == null ? "-" : (mps * 3.6).toFixed(digits);
}

function makeClockFmt(startIso, utcOffsetS) {
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

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "onclick") e.onclick = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function splitInfoForControl(controls, idx) {
  const c = controls[idx];
  return { beforeIdx: c.index_before, afterIdx: c.index_after, controlIdx: idx };
}

function splitInfoFromTurnaround(t) {
  return { beforeIdx: t.index_before, afterIdx: t.index_after, controlIdx: t.control_idx };
}

async function fetchJson(url) {
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

// --- view lifecycle ----------------------------------------------------
// renderAnalysis sets module-level state (link) and owns a map-area
// controller that must be torn down before the next view mounts. Routing
// the cleanup through one hook keeps the two from drifting out of sync.
let currentView = null;

function unmountCurrentView() {
  if (currentView) {
    currentView.unmount();
    currentView = null;
  }
}

// --- linked hover/highlight --------------------------------------------
// Stops and segments appear on the map, timeline, and tables. Hovering one
// peer highlights the others. DOM peers carry data-stop / data-seg keys
// (stops: "start" / "end" / "c<i>"; segments: the label string). Map peers
// (stop markers and segment polylines) register a highlight callback in
// link.<kind>.peers via registerMapPeer.
//
// peers is keyed by (stop/seg) key with an array of fns: in split-map mode
// the same segment can appear on both halves (the spanning segment) and the
// snap control's marker is shown on both maps, so a key may have >1 peer.
let link = null;
const HOVER_KINDS = ["stop", "seg"];

function makeLink() {
  return {
    stop: { hovered: null, peers: new Map() },
    seg: { hovered: null, peers: new Map() },
  };
}

function registerMapPeer(kind, key, source, applyHighlight) {
  let arr = link[kind].peers.get(key);
  if (!arr) {
    arr = [];
    link[kind].peers.set(key, arr);
  }
  arr.push(applyHighlight);
  source.on("mouseover", () => setHover(kind, key));
  source.on("mouseout", () => setHover(kind, null));
}

function clearMapPeers() {
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

function setHover(kind, key) {
  if (!link) return;
  const k = link[kind];
  if (k.hovered === key) return;
  const prev = k.hovered;
  k.hovered = key;
  if (prev) applyHover(kind, prev);
  if (key) applyHover(kind, key);
}

root.addEventListener("mouseover", (e) => {
  for (const kind of HOVER_KINDS) {
    const el = e.target.closest(`[data-${kind}]`);
    if (el) setHover(kind, el.dataset[kind]);
  }
});
root.addEventListener("mouseout", (e) => {
  // mouseout fires on transitions between children too; only clear when the
  // cursor actually leaves the tagged element.
  for (const kind of HOVER_KINDS) {
    const el = e.target.closest(`[data-${kind}]`);
    if (el && !el.contains(e.relatedTarget)) setHover(kind, null);
  }
});

// Labeled input + Apply button row, with Enter binding the same handler.
function controlsRow({ label, input, suffix, onApply }) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onApply();
  });
  return el(
    "div",
    { class: "controls-row" },
    el("label", {}, label),
    input,
    suffix ?? null,
    el("button", { onclick: onApply }, "Apply"),
  );
}

// --- list view ----------------------------------------------------------
function parseMinDist(s) {
  const v = parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_DIST_KM;
}

async function renderList(minDist) {
  root.innerHTML = "";

  // Filter control — rendered first so it stays visible even when no rides match.
  const minDistInput = el("input", {
    type: "number",
    min: "0",
    step: "10",
    value: String(minDist),
  });
  root.appendChild(
    controlsRow({
      label: "Min distance:",
      input: minDistInput,
      suffix: el("span", { class: "unit" }, "km"),
      onApply: () => setHash({ min_dist: String(parseMinDist(minDistInput.value)) }),
    }),
  );

  const body = el("div", {}, el("div", { class: "empty" }, "Loading rides…"));
  root.appendChild(body);

  let data;
  try {
    data = await fetchJson(`/api/rides?min_distance_km=${encodeURIComponent(minDist)}`);
  } catch (e) {
    body.replaceChildren(el("div", { class: "error" }, `Failed to load rides: ${e.message}`));
    return;
  }

  if (!data.rides.length) {
    body.replaceChildren(
      el(
        "div",
        { class: "empty" },
        `No rides match. ${data.total_cached} cached. Run `,
        el("code", {}, "ride fetch"),
        " to populate, or lower the minimum distance.",
      ),
    );
    return;
  }

  body.replaceChildren(
    el(
      "table",
      { class: "rides" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { class: "date" }, "Date"),
          el("th", { class: "dist" }, "Distance"),
          el("th", { class: "name" }, "Name"),
        ),
      ),
      el(
        "tbody",
        {},
        data.rides.map((r) =>
          el(
            "tr",
            { class: "row", onclick: () => setHash({ ride: r.id, min_stop: DEFAULT_MIN_STOP }) },
            el("td", { class: "date" }, r.date),
            el("td", { class: "dist" }, `${r.distance_km.toFixed(1)} km`),
            el("td", { class: "name" }, r.name),
          ),
        ),
      ),
    ),
  );
}

// --- timeline ----------------------------------------------------------
function buildTimelineModel(controls, segments) {
  const stopLabels = ["Start", ...controls.map((_, i) => `C${i + 1}`), "End"];
  const segByLabel = Object.fromEntries(segments.map((s) => [s.label, s]));
  const segLabels = stopLabels.slice(0, -1).map((s, i) => `${s} → ${stopLabels[i + 1]}`);
  const orderedSegs = segLabels.map((l) => segByLabel[l] ?? null);
  const cumKm = [0];
  for (const s of orderedSegs) cumKm.push(cumKm[cumKm.length - 1] + (s ? s.distance_m / 1000 : 0));
  const lastSeg = orderedSegs[orderedSegs.length - 1];
  const endS = controls.length
    ? controls[controls.length - 1].time_after_s + (lastSeg ? lastSeg.duration_s : 0)
    : orderedSegs[0]
      ? orderedSegs[0].duration_s
      : 0;
  return { stopLabels, segLabels, orderedSegs, cumKm, endS };
}

function renderTimeline(activity, controls, model) {
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
      const c = controls[i - 1];
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
        { class: "track-stop", style: `grid-column: ${stopCol}` },
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
function renderControlsTable(activity, controls, cumKm) {
  if (!controls.length) {
    return el("div", { class: "empty" }, "No stops above threshold detected.");
  }
  const fmtClock = makeClockFmt(activity.start_date, activity.utc_offset_s);
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
      ),
    ),
    el(
      "tbody",
      {},
      controls.map((c, i) =>
        el(
          "tr",
          { class: "row", "data-stop": `c${i}` },
          el("td", {}, `C${i + 1}`),
          el("td", {}, cumKm[i + 1].toFixed(1)),
          el("td", {}, fmtClock(c.time_before_s)),
          el("td", {}, fmtClock(c.time_after_s)),
          el("td", {}, fmtDur(c.rest_s)),
        ),
      ),
    ),
  );
}

function renderSegmentsTable(segments) {
  return el(
    "table",
    { class: "data" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", {}, "Segment"),
        el("th", {}, "Dist (km)"),
        el("th", {}, "Time"),
        el("th", {}, "Avg km/h"),
        el("th", {}, "Avg HR"),
        el("th", {}, "Avg Cad"),
        el("th", {}, "Avg W"),
        el("th", {}, "Climb (m)"),
        el("th", {}, "m/km"),
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
          el("td", {}, fmtNum(s.avg_hr)),
          el("td", {}, fmtNum(s.avg_cadence)),
          el("td", {}, fmtNum(s.avg_watts)),
          el("td", {}, fmtNum(s.climb_m)),
          el("td", {}, fmtNum(s.climb_m_per_km, 1)),
        ),
      ),
    ),
  );
}

// --- map ---------------------------------------------------------------
// Clip a chunk's [index_start, index_end] to range; returns [a, b] or null.
function clipToRange(chunk, range) {
  const a = Math.max(chunk.index_start, range.startIdx);
  const b = Math.min(chunk.index_end, range.endIdx);
  return a <= b ? [a, b] : null;
}

function drawDaynightPath(map, latlng, daynight, range) {
  if (!daynight || !daynight.length) return false;
  const lines = [];
  for (const s of daynight) {
    const clip = clipToRange(s, range);
    if (!clip) continue;
    lines.push(
      L.polyline(latlng.slice(clip[0], clip[1] + 1), {
        color: DAYNIGHT_COLORS[s.state] || "#999",
        weight: 3,
        opacity: 1,
        interactive: false,
      }),
    );
  }
  if (!lines.length) return false;
  L.layerGroup(lines).addTo(map);
  return true;
}

function drawSegmentLines(map, latlng, segments, hasDaynight, range) {
  // When day/night colors are drawn, segment lines stay invisible (opacity 0)
  // but remain on the map so they're still hoverable peers for linked highlight.
  const baseStyle = { color: SEGMENT_COLOR, weight: 3, opacity: hasDaynight ? 0 : 1 };
  const lines = [];
  for (const s of segments) {
    const clip = clipToRange(s, range);
    if (!clip) continue;
    const line = L.polyline(latlng.slice(clip[0], clip[1] + 1), baseStyle).addTo(map);
    registerMapPeer("seg", s.label, line, (on) => {
      if (on) {
        line.setStyle({ color: SEGMENT_HOVER_COLOR, weight: 6, opacity: 1 });
        line.bringToFront();
      } else {
        line.setStyle(baseStyle);
      }
    });
    lines.push(line);
  }
  return lines;
}

function drawEndpointMarkers(map, latlng, range, fmtClock, totalKm, endS) {
  // Only draw the global Start/End markers when the map's range actually
  // reaches the track ends; on the inner side of a split there's no
  // dedicated split marker — the polyline simply ends.
  const last = latlng.length - 1;
  const iconHighlight = (marker) => (on) => {
    const elt = marker.getElement();
    if (elt) elt.classList.toggle("hl-marker", on);
  };
  if (range.startIdx === 0) {
    const start = L.marker(latlng[0])
      .addTo(map)
      .bindPopup(`<b>Start</b><br>0.0 km<br>${fmtClock(0)}`);
    registerMapPeer("stop", "start", start, iconHighlight(start));
  }
  if (range.endIdx === last) {
    const end = L.marker(latlng[last])
      .addTo(map)
      .bindPopup(`<b>End</b><br>${totalKm} km<br>${fmtClock(endS)}`);
    registerMapPeer("stop", "end", end, iconHighlight(end));
  }
}

function drawControlMarkers(map, controls, cumKm, fmtClock, range, splitInfo, onClickControl) {
  // Snap control is shown on both halves so the turnaround anchors visibly on each map.
  const visible = controls
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => {
      const inRange = c.index_before >= range.startIdx && c.index_before <= range.endIdx;
      const isSnap = splitInfo && splitInfo.controlIdx === i;
      return inRange || isSnap;
    });
  if (!visible.length) return null;
  // Radius normalization uses the global maxRest so marker sizes are
  // comparable across the two split maps, not just within a half.
  const maxRest = Math.max(1, ...controls.map((c) => c.rest_s || 0));
  // Render largest circles first so smaller ones land on top — when controls
  // cluster at the same place, the smaller circle stays hoverable instead of
  // being buried under the larger one.
  const ordered = visible
    .map(({ c, i }) => ({
      c,
      i,
      // Radius scales with sqrt(rest_s / maxRest) so circle *area* is roughly
      // proportional to rest time. Normalizing to maxRest keeps the longest
      // rest at the max radius (so it always fits on the map) while preserving
      // relative size differences between shorter rests.
      radius:
        CONTROL_MARKER_MIN_R +
        (CONTROL_MARKER_MAX_R - CONTROL_MARKER_MIN_R) * Math.sqrt((c.rest_s || 0) / maxRest),
    }))
    .sort((a, b) => b.radius - a.radius);
  const markers = ordered.map(({ c, i, radius }) => {
    const km = cumKm[i + 1].toFixed(1);
    const arrive = fmtClock(c.time_before_s);
    const depart = fmtClock(c.time_after_s);
    const marker = L.circleMarker([c.lat, c.lng], {
      radius,
      color: CONTROL_COLOR,
      weight: 1,
      fillColor: CONTROL_COLOR,
      fillOpacity: 0.2,
    }).bindTooltip(`<b>C${i + 1}</b><br>${km} km<br>${arrive} → ${depart}<br>${fmtDur(c.rest_s)}`, {
      direction: "top",
      offset: [0, -4],
    });
    registerMapPeer("stop", `c${i}`, marker, (on) => {
      marker.setStyle({ weight: on ? 3 : 1, fillOpacity: on ? 0.5 : 0.2 });
    });
    if (onClickControl) marker.on("click", () => onClickControl(i));
    return marker;
  });
  return L.layerGroup(markers).addTo(map);
}

function attachMapResizer(mapDiv, handle) {
  let startY = 0;
  let startH = 0;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    startY = e.clientY;
    startH = mapDiv.getBoundingClientRect().height;
  });
  handle.addEventListener("pointermove", (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const h = Math.max(MIN_MAP_HEIGHT_PX, startH + (e.clientY - startY));
    mapDiv.style.height = `${h}px`;
  });
  const release = (e) => {
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    handle.classList.remove("dragging");
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
}

function renderMap(container, data, model, range, ctx) {
  const { latlng, segments, controls, daynight, activity } = data;
  if (!latlng || !latlng.length) {
    container.appendChild(el("div", { class: "empty" }, "No GPS data."));
    return null;
  }
  const a = range.startIdx;
  const b = range.endIdx;
  if (a > b || a >= latlng.length) {
    container.appendChild(el("div", { class: "empty" }, "Empty range."));
    return null;
  }

  const map = L.map(container).setView(latlng[a], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const fmtClock = makeClockFmt(activity.start_date, activity.utc_offset_s);
  const { cumKm, endS } = model;
  const totalKm = cumKm[cumKm.length - 1].toFixed(1);

  const hasDaynight = drawDaynightPath(map, latlng, daynight, range);
  const segLines = drawSegmentLines(map, latlng, segments, hasDaynight, range);
  drawEndpointMarkers(map, latlng, range, fmtClock, totalKm, endS);
  const controlsLayer = drawControlMarkers(
    map,
    controls,
    cumKm,
    fmtClock,
    range,
    ctx.splitInfo,
    ctx.onClickControl,
  );
  if (hasDaynight) addMapLegend(map, !!controlsLayer);

  const bounds = segLines.length
    ? L.featureGroup(segLines).getBounds()
    : L.latLngBounds(latlng.slice(a, b + 1));
  map.fitBounds(bounds, { padding: [20, 20] });

  // Leaflet needs invalidateSize() when the container resizes (drag handle).
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(container);
  map.on("unload", () => ro.disconnect());

  addFullscreenControl(map, container, bounds);
  if (controlsLayer)
    addLayerToggle(map, controlsLayer, {
      className: "controls-btn",
      label: "●",
      hideTitle: "Hide controls",
      showTitle: "Show controls",
    });
  if (ctx.onSplitToggle)
    addStatefulButton(map, {
      className: "split-btn",
      labelOn: "⇆",
      titleOn: "Merge into single map",
      titleOff: "Split route into outbound / return",
      initialOn: !!ctx.splitInfo,
      onChange: (on) => ctx.onSplitToggle(on),
    });
  return map;
}

function buildMapArea(wrapper, data, model) {
  // Backend omits `turnaround` for routes that don't look out-and-back; the
  // toggle button is hidden in that case.
  const autoSplit = data.turnaround ? splitInfoFromTurnaround(data.turnaround) : null;
  let splitInfo = null; // null = single-map mode
  let maps = [];

  const teardown = () => {
    for (const m of maps) m.remove();
    maps = [];
    clearMapPeers();
  };

  const onSplitToggle =
    autoSplit &&
    ((on) => {
      splitInfo = on ? autoSplit : null;
      render();
    });

  const onClickControl = (i) => {
    if (!splitInfo || splitInfo.controlIdx === i) return;
    splitInfo = splitInfoForControl(data.controls, i);
    render();
  };

  const render = () => {
    teardown();
    wrapper.innerHTML = "";
    const last = data.latlng.length - 1;
    // The toggle lives on the left map only; the right gets click-to-relocate
    // but no redundant toggle button.
    const panes = splitInfo
      ? [
          {
            range: { startIdx: 0, endIdx: splitInfo.beforeIdx },
            ctx: { splitInfo, onSplitToggle, onClickControl },
          },
          {
            range: { startIdx: splitInfo.afterIdx, endIdx: last },
            ctx: { splitInfo, onClickControl },
          },
        ]
      : [{ range: { startIdx: 0, endIdx: last }, ctx: { splitInfo: null, onSplitToggle } }];
    wrapper.classList.toggle("split", !!splitInfo);
    const inners = panes.map(() => {
      const d = el("div", { class: "leaflet-map" });
      wrapper.appendChild(d);
      return d;
    });
    // Leaflet needs the container in the DOM with size before init.
    setTimeout(() => {
      panes.forEach((p, i) => {
        const m = renderMap(inners[i], data, model, p.range, p.ctx);
        if (m) maps.push(m);
      });
    }, 0);
  };

  render();
  return { destroy: teardown };
}

// --- map controls ------------------------------------------------------
// Wraps addToggleControl with on/off state plus label/title swapping.
// Returns setOn(next) so callers (e.g. an Esc handler) can drive state too.
function addStatefulButton(
  map,
  { className, labelOn, labelOff, titleOn, titleOff, initialOn = false, onChange },
) {
  let on = initialOn;
  let btnRef = null;
  const render = (b) => {
    b.innerHTML = on ? labelOn : (labelOff ?? labelOn);
    b.title = on ? titleOn : titleOff;
  };
  const setOn = (next) => {
    if (next === on) return;
    on = next;
    if (btnRef) render(btnRef);
    onChange(on, btnRef);
  };
  addToggleControl(map, {
    className,
    label: on ? labelOn : (labelOff ?? labelOn),
    title: on ? titleOn : titleOff,
    onClick: (btn) => {
      btnRef = btn;
      setOn(!on);
    },
  });
  return setOn;
}

function addLayerToggle(map, layer, { className, label, hideTitle, showTitle }) {
  addStatefulButton(map, {
    className,
    labelOn: label,
    titleOn: hideTitle,
    titleOff: showTitle,
    initialOn: true,
    onChange: (on, btn) => {
      if (on) layer.addTo(map);
      else map.removeLayer(layer);
      btn.classList.toggle("off", !on);
    },
  });
}

function addToggleControl(map, { className, label, title, onClick }) {
  let btn;
  const Ctrl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      btn = el(
        "a",
        {
          class: `leaflet-bar leaflet-control map-toggle-btn ${className}`,
          href: "#",
          title,
          role: "button",
        },
        label,
      );
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.disableScrollPropagation(btn);
      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.preventDefault(e);
        onClick(btn);
      });
      return btn;
    },
  });
  map.addControl(new Ctrl());
}

function addMapLegend(map, hasControls) {
  const Ctrl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const items = Object.entries(DAYNIGHT_COLORS).map(([state, color]) =>
        el(
          "div",
          { class: "legend-item" },
          el("span", { class: "swatch-line", style: `background:${color}` }),
          el("span", {}, state),
        ),
      );
      if (hasControls) {
        items.push(
          el(
            "div",
            { class: "legend-item" },
            el("span", {
              class: "swatch-dot",
              style: `background:${CONTROL_COLOR}33;border-color:${CONTROL_COLOR}`,
            }),
            el("span", {}, "stop"),
          ),
        );
      }
      const div = el("div", { class: "leaflet-bar leaflet-control map-legend" }, ...items);
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  map.addControl(new Ctrl());
}

function addFullscreenControl(map, container, bounds) {
  let escHandler = null;
  const setOn = addStatefulButton(map, {
    className: "fullscreen-btn",
    labelOn: "⤡",
    labelOff: "⤢",
    titleOn: "Exit fullscreen",
    titleOff: "Toggle fullscreen",
    onChange: (on) => {
      container.classList.toggle("map-fullscreen", on);
      document.body.classList.toggle("map-fullscreen-active", on);
      if (on) {
        escHandler = (e) => {
          if (e.key === "Escape") setOn(false);
        };
        document.addEventListener("keydown", escHandler);
      } else if (escHandler) {
        document.removeEventListener("keydown", escHandler);
        escHandler = null;
      }
      setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(bounds, { padding: [20, 20] });
      }, 0);
    },
  });
  map.on("unload", () => {
    if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
    document.body.classList.remove("map-fullscreen-active");
  });
}

// --- analysis view -----------------------------------------------------
async function renderAnalysis(rideId, minStop) {
  // ---------------------
  // Loading
  root.innerHTML = "";
  root.appendChild(el("div", { class: "empty" }, "Loading…"));
  let data;
  try {
    data = await fetchJson(`/api/rides/${rideId}/analysis?min_stop=${encodeURIComponent(minStop)}`);
  } catch (e) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "error" }, `Failed to load analysis: ${e.message}`));
    return;
  }
  root.innerHTML = "";
  link = makeLink();
  let mapArea = null;
  currentView = {
    unmount: () => {
      if (mapArea) {
        mapArea.destroy();
        mapArea = null;
      }
      link = null;
    },
  };

  // ---------------------
  // Title & Info
  const a = data.activity;
  root.appendChild(
    el(
      "h2",
      { class: "ride-title" },
      a.name || "(unnamed ride)",
      el("span", { class: "date" }, `(${(a.start_date_local || a.start_date || "").slice(0, 10)})`),
    ),
  );

  const summaryItems = [
    ["Distance", `${(a.distance_m / 1000).toFixed(1)} km`],
    ["Elapsed", fmtDur(a.elapsed_time_s)],
    ["Moving", fmtDur(a.moving_time_s)],
    ["Climb", `${Math.round(a.total_elevation_gain_m || 0)} m`],
  ];
  root.appendChild(
    el(
      "div",
      { class: "summary" },
      summaryItems.map(([label, value]) =>
        el(
          "div",
          { class: "item" },
          el("span", { class: "label" }, `${label}:`),
          el("span", { class: "value" }, value),
        ),
      ),
    ),
  );

  const minStopInput = el("input", { type: "text", value: minStop });
  root.appendChild(
    controlsRow({
      label: "Min stop:",
      input: minStopInput,
      onApply: () =>
        setHash({ ride: rideId, min_stop: minStopInput.value.trim() || DEFAULT_MIN_STOP }),
    }),
  );

  const model = buildTimelineModel(data.controls, data.segments);

  // ---------------------
  // Map
  root.appendChild(el("h2", {}, "Map"));
  const mapDiv = el("div", { id: "map" });
  const resizeHandle = el("div", {
    class: "map-resize-handle",
    title: "Drag to resize map",
  });
  root.appendChild(mapDiv);
  root.appendChild(resizeHandle);
  attachMapResizer(mapDiv, resizeHandle);
  mapArea = buildMapArea(mapDiv, data, model);

  // ---------------------
  // Timeline
  root.appendChild(renderTimeline(data.activity, data.controls, model));

  // ---------------------
  // Table
  root.appendChild(
    el(
      "div",
      { class: "tables-row" },
      el(
        "section",
        {},
        el("h2", {}, "Controls"),
        renderControlsTable(data.activity, data.controls, model.cumKm),
      ),
      el("section", {}, el("h2", {}, "Segments"), renderSegmentsTable(data.segments)),
    ),
  );
}

// --- routing ------------------------------------------------------------
function parseHash() {
  const h = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(h);
  const ride = params.get("ride");
  if (ride)
    return { view: "analysis", rideId: ride, minStop: params.get("min_stop") || DEFAULT_MIN_STOP };
  return { view: "list", minDist: parseMinDist(params.get("min_dist")) };
}

function setHash(params) {
  window.location.hash = new URLSearchParams(params).toString();
}

function route() {
  unmountCurrentView();
  const r = parseHash();
  if (r.view === "analysis") renderAnalysis(r.rideId, r.minStop);
  else renderList(r.minDist);
}

window.addEventListener("hashchange", route);
route();
