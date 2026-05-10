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
// renderAnalysis sets module-level state (link, mapInstance) that must be
// torn down before the next view mounts. Routing the cleanup through one
// hook keeps the two from drifting out of sync.
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
let link = null;
const HOVER_KINDS = ["stop", "seg"];

function makeLink() {
  return {
    stop: { hovered: null, peers: new Map() },
    seg: { hovered: null, peers: new Map() },
  };
}

function registerMapPeer(kind, key, source, applyHighlight) {
  link[kind].peers.set(key, applyHighlight);
  source.on("mouseover", () => setHover(kind, key));
  source.on("mouseout", () => setHover(kind, null));
}

function applyHover(kind, key) {
  if (!link) return;
  const k = link[kind];
  const active = k.hovered === key;
  root
    .querySelectorAll(`[data-${kind}="${CSS.escape(key)}"]`)
    .forEach((el) => el.classList.toggle("hl", active));
  const m = k.peers.get(key);
  if (m) m(active);
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
  const apply = () => navigateList(parseMinDist(minDistInput.value));
  minDistInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply();
  });
  root.appendChild(
    el(
      "div",
      { class: "controls-row" },
      el("label", {}, "Min distance:"),
      minDistInput,
      el("span", { class: "unit" }, "km"),
      el("button", { onclick: apply }, "Apply"),
    ),
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
            { class: "row", onclick: () => navigate(r.id) },
            el("td", { class: "date" }, r.date),
            el("td", { class: "dist" }, `${r.distance_km.toFixed(1)} km`),
            el("td", { class: "name" }, r.name),
          ),
        ),
      ),
    ),
  );
}

// --- analysis view ------------------------------------------------------
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

function drawDaynightPath(map, latlng, daynight) {
  if (!daynight || !daynight.length) return false;
  L.layerGroup(
    daynight.map((s) =>
      L.polyline(latlng.slice(s.index_start, s.index_end + 1), {
        color: DAYNIGHT_COLORS[s.state] || "#999",
        weight: 3,
        opacity: 1,
        interactive: false,
      }),
    ),
  ).addTo(map);
  return true;
}

function drawSegmentLines(map, latlng, segments, hasDaynight) {
  // When day/night colors are drawn, segment lines stay invisible (opacity 0)
  // but remain on the map so they're still hoverable peers for linked highlight.
  const baseStyle = { color: SEGMENT_COLOR, weight: 3, opacity: hasDaynight ? 0 : 1 };
  return segments.map((s) => {
    const line = L.polyline(latlng.slice(s.index_start, s.index_end + 1), baseStyle).addTo(map);
    registerMapPeer("seg", s.label, line, (on) => {
      if (on) {
        line.setStyle({ color: SEGMENT_HOVER_COLOR, weight: 6, opacity: 1 });
        line.bringToFront();
      } else {
        line.setStyle(baseStyle);
      }
    });
    return line;
  });
}

function drawEndpointMarkers(map, firstPt, lastPt, fmtClock, totalKm, endS) {
  const iconHighlight = (marker) => (on) => {
    const elt = marker.getElement();
    if (elt) elt.classList.toggle("hl-marker", on);
  };
  const start = L.marker(firstPt)
    .addTo(map)
    .bindPopup(`<b>Start</b><br>0.0 km<br>${fmtClock(0)}`);
  registerMapPeer("stop", "start", start, iconHighlight(start));
  const end = L.marker(lastPt)
    .addTo(map)
    .bindPopup(`<b>End</b><br>${totalKm} km<br>${fmtClock(endS)}`);
  registerMapPeer("stop", "end", end, iconHighlight(end));
}

function drawControlMarkers(map, controls, cumKm, fmtClock) {
  const maxRest = Math.max(1, ...controls.map((c) => c.rest_s || 0));
  // Render largest circles first so smaller ones land on top — when controls
  // cluster at the same place, the smaller circle stays hoverable instead of
  // being buried under the larger one.
  const ordered = controls
    .map((c, i) => ({
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

let mapInstance = null;
function renderMap(container, latlng, segments, controls, activity, model, daynight) {
  if (!latlng || !latlng.length) {
    container.appendChild(el("div", { class: "empty" }, "No GPS data."));
    return;
  }
  const firstPt = latlng[0];
  const lastPt = latlng[latlng.length - 1];

  const map = L.map(container).setView(firstPt, 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const fmtClock = makeClockFmt(activity.start_date, activity.utc_offset_s);
  const { cumKm, endS } = model;
  const totalKm = cumKm[cumKm.length - 1].toFixed(1);

  const hasDaynight = drawDaynightPath(map, latlng, daynight);
  const segLines = drawSegmentLines(map, latlng, segments, hasDaynight);
  drawEndpointMarkers(map, firstPt, lastPt, fmtClock, totalKm, endS);
  const controlsLayer = controls.length ? drawControlMarkers(map, controls, cumKm, fmtClock) : null;
  if (hasDaynight) addMapLegend(map, controls.length > 0);

  const bounds = L.featureGroup(segLines).getBounds();
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
  mapInstance = map;
}

function addLayerToggle(map, layer, { className, label, hideTitle, showTitle }) {
  let on = true;
  addToggleControl(map, {
    className,
    label,
    title: hideTitle,
    onClick: (btn) => {
      on = !on;
      if (on) layer.addTo(map);
      else map.removeLayer(layer);
      btn.classList.toggle("off", !on);
      btn.title = on ? hideTitle : showTitle;
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
  let on = false;
  let escHandler = null;
  let btnRef;

  const applyClasses = () => {
    container.classList.toggle("map-fullscreen", on);
    document.body.classList.toggle("map-fullscreen-active", on);
    btnRef.innerHTML = on ? "⤡" : "⤢";
    btnRef.title = on ? "Exit fullscreen" : "Toggle fullscreen";
  };

  const toggle = () => {
    on = !on;
    if (on) {
      escHandler = (e) => {
        if (e.key === "Escape") toggle();
      };
      document.addEventListener("keydown", escHandler);
    } else if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
    applyClasses();
    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [20, 20] });
    }, 0);
  };

  const cleanup = () => {
    if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
    if (on) {
      on = false;
      applyClasses();
    }
  };

  addToggleControl(map, {
    className: "fullscreen-btn",
    label: "⤢",
    title: "Toggle fullscreen",
    onClick: (btn) => {
      btnRef = btn;
      toggle();
    },
  });
  map.on("unload", cleanup);
}

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
  currentView = {
    unmount: () => {
      if (mapInstance) {
        mapInstance.remove();
        mapInstance = null;
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

  root.appendChild(
    el(
      "div",
      { class: "summary" },
      el(
        "div",
        { class: "item" },
        el("span", { class: "label" }, "Distance:"),
        el("span", { class: "value" }, `${(a.distance_m / 1000).toFixed(1)} km`),
      ),
      el(
        "div",
        { class: "item" },
        el("span", { class: "label" }, "Elapsed:"),
        el("span", { class: "value" }, fmtDur(a.elapsed_time_s)),
      ),
      el(
        "div",
        { class: "item" },
        el("span", { class: "label" }, "Moving:"),
        el("span", { class: "value" }, fmtDur(a.moving_time_s)),
      ),
      el(
        "div",
        { class: "item" },
        el("span", { class: "label" }, "Climb:"),
        el("span", { class: "value" }, `${Math.round(a.total_elevation_gain_m || 0)} m`),
      ),
    ),
  );

  const minStopInput = el("input", { type: "text", value: minStop });
  const apply = () => {
    const v = minStopInput.value.trim() || DEFAULT_MIN_STOP;
    navigate(rideId, v);
  };
  minStopInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply();
  });
  root.appendChild(
    el(
      "div",
      { class: "controls-row" },
      el("label", {}, "Min stop:"),
      minStopInput,
      el("button", { onclick: apply }, "Apply"),
    ),
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
  // Leaflet needs the container in the DOM with size before init.
  setTimeout(
    () =>
      renderMap(
        mapDiv,
        data.latlng,
        data.segments,
        data.controls,
        data.activity,
        model,
        data.daynight,
      ),
    0,
  );

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

function navigate(rideId, minStop = DEFAULT_MIN_STOP) {
  if (rideId == null) {
    window.location.hash = "";
  } else {
    const p = new URLSearchParams({ ride: rideId, min_stop: minStop });
    window.location.hash = p.toString();
  }
}

function navigateList(minDist) {
  const p = new URLSearchParams({ min_dist: String(minDist) });
  window.location.hash = p.toString();
}

function route() {
  unmountCurrentView();
  const r = parseHash();
  if (r.view === "analysis") renderAnalysis(r.rideId, r.minStop);
  else renderList(r.minDist);
}

window.addEventListener("hashchange", route);
route();
