// Leaflet drawing, the map controls, the marker context menu, and buildMapArea
// — the disposable component that owns the whole map subtree (the maps, the
// resize handle, and the per-pane summaries) and returns
// { el, destroy, toggleSplit, setHoverIndex }. Leaflet (`L`) is a global,
// touched only inside functions that run after boot().
import {
  root,
  el,
  fmtDur,
  fmtUnit,
  fmtPct,
  fmtTempRange,
  makeClockFmt,
  SEGMENT_COLOR,
  SEGMENT_HOVER_COLOR,
  STOP_COLOR,
  DAYNIGHT_COLORS,
} from "./utils.js";
import { registerMapPeer, clearMapPeers } from "./hover.js";
import { summaryItem, dnRestBar, dnRestLegend } from "./summary.js";

const MIN_MAP_HEIGHT_PX = 200;
// Stop marker radius (px) by *absolute* rest duration, so a given rest length
// looks the same size across rides. [rest_seconds, radius] anchors are
// interpolated linearly; the last anchor (6h→40px) is the max, and anything
// longer caps at 40px.
const STOP_MARKER_ANCHORS = [
  [0, 6], // very short rests (a few seconds): minimum size
  [1800, 15], // 30 minutes
  [3600, 25], // 1 hour
  [21600, 40], // 6 hours
];
const STOP_MARKER_MAX_R = 40; // cap for very long rests

function stopMarkerRadius(restS) {
  const s = Math.max(0, restS || 0);
  const a = STOP_MARKER_ANCHORS;
  for (let k = 1; k < a.length; k++) {
    if (s <= a[k][0]) {
      const [s0, r0] = a[k - 1];
      const [s1, r1] = a[k];
      return r0 + ((r1 - r0) * (s - s0)) / (s1 - s0);
    }
  }
  // Beyond the last anchor: keep the final segment's slope, capped at the max.
  const [s0, r0] = a[a.length - 2];
  const [s1, r1] = a[a.length - 1];
  const slope = (r1 - r0) / (s1 - s0);
  return Math.min(STOP_MARKER_MAX_R, r1 + slope * (s - s1));
}

function splitInfoForStop(stops, idx) {
  const c = stops[idx];
  return { beforeIdx: c.index_before, afterIdx: c.index_after, stopIdx: idx };
}

// --- marker context menu ----------------------------------------------
// Lightweight native-style context menu shown at the cursor on click.
// Only one menu can be open at a time; closes on outside click, Escape, or
// scroll/resize (positions go stale).
let activeMarkerMenu = null;

function closeMarkerMenu() {
  if (activeMarkerMenu) {
    activeMarkerMenu.teardown();
    activeMarkerMenu = null;
  }
}

function openMarkerMenu(originalEvent, items) {
  closeMarkerMenu();
  const menu = el("div", { class: "marker-menu" });
  for (const { label, onSelect } of items) {
    menu.appendChild(
      el(
        "div",
        {
          class: "marker-menu-item",
          onclick: () => {
            closeMarkerMenu();
            onSelect();
          },
        },
        label,
      ),
    );
  }
  document.body.appendChild(menu);

  // Clamp into the viewport so the menu never overflows off-screen.
  const rect = menu.getBoundingClientRect();
  const x = Math.max(0, Math.min(originalEvent.clientX, window.innerWidth - rect.width - 4));
  const y = Math.max(0, Math.min(originalEvent.clientY, window.innerHeight - rect.height - 4));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const onDocDown = (e) => {
    if (!menu.contains(e.target)) closeMarkerMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeMarkerMenu();
  };
  const onMove = () => closeMarkerMenu();
  // Defer the outside-click binding so the same click that opened the
  // menu doesn't immediately close it.
  setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onMove);
  window.addEventListener("scroll", onMove, true);

  activeMarkerMenu = {
    teardown: () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      menu.remove();
    },
  };
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
        line.setStyle({ color: SEGMENT_HOVER_COLOR, weight: 4.5, opacity: 1 });
        line.bringToFront();
      } else {
        line.setStyle(baseStyle);
      }
    });
    lines.push(line);
  }
  return lines;
}

// A teardrop pin: "start" role (start / split departure) labeled
// S, "end" role (end / split arrival) labeled E. The tip is anchored to the
// geographic point; tooltipAnchor lifts hover tooltips clear of the head. CSS
// lives in style.css (.map-pin).
function pinIcon(role) {
  const label = role === "start" ? "S" : "E";
  return L.divIcon({
    className: "",
    html: `<div class="map-pin map-pin--${role}"><div class="map-pin__head"><span class="map-pin__label">${label}</span></div></div>`,
    iconSize: [28, 38],
    iconAnchor: [14, 36],
    tooltipAnchor: [0, -34],
  });
}

function drawEndpointMarkers(
  map,
  latlng,
  range,
  fmtClock,
  endS,
  stops,
  startSplitStop,
  endSplitStop,
) {
  // Each pane gets a pin at both ends. The outer ends use the ride's global
  // Start/End when the range reaches the track ends; otherwise the border is a
  // split stop, drawn as a pin on both panes it divides.
  const last = latlng.length - 1;
  const iconHighlight = (marker) => (on) => {
    const elt = marker.getElement();
    if (elt) elt.classList.toggle("hl-marker", on);
  };
  const tooltipOpts = { direction: "top" };
  if (range.startIdx === 0) {
    const start = L.marker(latlng[0], { icon: pinIcon("start") })
      .addTo(map)
      .bindTooltip(`<b>Start</b><br>departs ${fmtClock(0)}`, tooltipOpts);
    registerMapPeer("stop", "start", start, iconHighlight(start));
  } else if (startSplitStop != null) {
    // Split stop opening this pane: a Start-like pin showing departure time.
    const c = stops[startSplitStop];
    const pin = L.marker([c.lat, c.lng], { icon: pinIcon("start") })
      .addTo(map)
      .bindTooltip(
        `<b>S${startSplitStop + 1}</b><br>departs ${fmtClock(c.time_after_s)}`,
        tooltipOpts,
      );
    registerMapPeer("stop", `c${startSplitStop}`, pin, iconHighlight(pin));
  }
  if (range.endIdx === last) {
    const end = L.marker(latlng[last], { icon: pinIcon("end") })
      .addTo(map)
      .bindTooltip(`<b>End</b><br>arrives ${fmtClock(endS)}`, tooltipOpts);
    registerMapPeer("stop", "end", end, iconHighlight(end));
  } else if (endSplitStop != null) {
    // Split stop closing this pane: an End-like pin showing arrival time.
    const c = stops[endSplitStop];
    const pin = L.marker([c.lat, c.lng], { icon: pinIcon("end") })
      .addTo(map)
      .bindTooltip(
        `<b>S${endSplitStop + 1}</b><br>arrives ${fmtClock(c.time_before_s)}`,
        tooltipOpts,
      );
    registerMapPeer("stop", `c${endSplitStop}`, pin, iconHighlight(pin));
  }
}

function drawStopMarkers(map, stops, range, onClickStop, startSplitStop, endSplitStop) {
  const visible = stops
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => {
      // The stops bordering this pane are drawn as start/end pins, not circles.
      if (i === startSplitStop || i === endSplitStop) return false;
      return c.index_before >= range.startIdx && c.index_before <= range.endIdx;
    });
  if (!visible.length) return null;
  // Render largest circles first so smaller ones land on top — when stops
  // cluster at the same place, the smaller circle stays hoverable instead of
  // being buried under the larger one.
  const ordered = visible
    .map(({ c, i }) => ({ c, i, radius: stopMarkerRadius(c.rest_s) }))
    .sort((a, b) => b.radius - a.radius);
  const markers = ordered.map(({ c, i, radius }) => {
    const marker = L.circleMarker([c.lat, c.lng], {
      radius,
      color: STOP_COLOR,
      weight: 1,
      fillColor: STOP_COLOR,
      fillOpacity: 0.2,
    }).bindTooltip(`<b>S${i + 1}</b><br>${fmtDur(c.rest_s)}`, {
      direction: "top",
      offset: [0, -4],
    });
    registerMapPeer("stop", `c${i}`, marker, (on) => {
      marker.setStyle({ weight: on ? 3 : 1, fillOpacity: on ? 0.5 : 0.2 });
    });
    if (onClickStop) {
      marker.on("click", (ev) => {
        openMarkerMenu(ev.originalEvent, [{ label: "Split here", onSelect: () => onClickStop(i) }]);
      });
    }
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
  const { segments, stops, daynight, activity } = data;
  const latlng = data.series.latlng;
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
  const { endS } = model;

  const hasDaynight = drawDaynightPath(map, latlng, daynight, range);
  const segLines = drawSegmentLines(map, latlng, segments, hasDaynight, range);
  drawEndpointMarkers(
    map,
    latlng,
    range,
    fmtClock,
    endS,
    stops,
    ctx.startSplitStop,
    ctx.endSplitStop,
  );
  const stopsLayer = drawStopMarkers(
    map,
    stops,
    range,
    ctx.onClickStop,
    ctx.startSplitStop,
    ctx.endSplitStop,
  );
  if (hasDaynight) addMapLegend(map, !!stopsLayer);

  const bounds = segLines.length
    ? L.featureGroup(segLines).getBounds()
    : L.latLngBounds(latlng.slice(a, b + 1));
  map.fitBounds(bounds, { padding: [20, 20] });

  // Leaflet needs invalidateSize() when the container resizes (drag handle).
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(container);
  map.on("unload", () => ro.disconnect());

  addFullscreenControl(map, container, bounds);
  if (stopsLayer)
    addLayerToggle(map, stopsLayer, {
      className: "stops-btn",
      label: "●",
      hideTitle: "Hide stops",
      showTitle: "Show stops",
    });
  if (ctx.onRemoveSplit)
    addToggleControl(map, {
      className: "merge-btn",
      label: "✕",
      title: "Remove this split",
      onClick: () => ctx.onRemoveSplit(),
      position: "topright",
    });
  return map;
}

// Per-split summary: the whole-ride distance/elapsed/etc are Strava aggregates
// that can't be subdivided, so each pane's figures are pooled from its segments
// (stream-derived) instead — Moving and the day/night breakdown come straight
// from the per-segment fields, Rest is Elapsed − Moving. Elapsed is the wall
// clock between the pane's bordering split stops (passed in by the caller).
function paneSummary(segs, elapsedS) {
  const sum = (f) => segs.reduce((acc, s) => acc + (f(s) || 0), 0);
  const movingS = sum((s) => s.moving_s);
  const coastD = sum((s) => s.coasting_d);
  const coastFrac = coastD ? sum((s) => s.coasting_n) / coastD : null;
  // Temperature has no whole-pane aggregate, so pool it from segments: a
  // sample-count-weighted mean, and the extremes across each segment's range.
  const tempN = sum((s) => s.temp_n);
  const tempAvg = tempN ? sum((s) => (s.avg_temp || 0) * s.temp_n) / tempN : null;
  const tempMins = segs.map((s) => s.temp_min).filter((v) => v != null);
  const tempMaxs = segs.map((s) => s.temp_max).filter((v) => v != null);
  const tempMin = tempMins.length ? Math.min(...tempMins) : null;
  const tempMax = tempMaxs.length ? Math.max(...tempMaxs) : null;
  // Same four parts the whole-ride summary bar draws, scoped to this pane:
  // moving as day/twilight/night, then rest = Elapsed − Moving.
  const restS = Math.max(0, elapsedS - movingS);
  const dnParts = [
    ["day", "Day", sum((s) => s.day_s)],
    ["twilight", "Twilight", sum((s) => s.twilight_s)],
    ["night", "Night", sum((s) => s.night_s)],
    ["rest", "Rest", restS],
  ];
  return el(
    "div",
    { class: "pane-summary" },
    summaryItem("Dist", fmtUnit(sum((s) => s.distance_m) / 1000, "km", 1)),
    summaryItem(
      "Climb",
      fmtUnit(
        sum((s) => s.climb_m),
        "m",
      ),
    ),
    summaryItem("Coast", fmtPct(coastFrac)),
    summaryItem("Temp", fmtTempRange(tempAvg, tempMin, tempMax)),
    summaryItem("Elapsed", fmtDur(elapsedS)),
    summaryItem("Moving", fmtDur(movingS)),
    // Stacked bar + its day/twilight/night/rest legend, in the same order and
    // shape as the whole-ride summary's bar + legend, scoped to this pane.
    dnRestBar(dnParts),
    dnRestLegend(dnParts),
  );
}

// Disposable map component. Owns its whole subtree — the maps (#map), the
// resize handle, and the per-pane summaries — under one wrapper returned as
// `el`. The handle resizes only #map (as before). destroy() removes every
// Leaflet map, closes any open marker menu, and clears the hover peers it
// registered.
export function buildMapArea(data, model) {
  // Maps live in #map (the only thing the drag handle resizes); the per-pane
  // summaries live in a matching column row below the handle.
  const mapWrap = el("div", { id: "map" });
  const resizeHandle = el("div", { class: "map-resize-handle", title: "Drag to resize map" });
  const summaryWrap = el("div", { class: "pane-summaries" });
  const elRoot = el("div", { class: "map-area" }, mapWrap, resizeHandle, summaryWrap);
  attachMapResizer(mapWrap, resizeHandle);

  let splits = []; // sorted ascending stop indices; [] = single-map mode
  // One entry per rendered pane: its Leaflet map, the stream-index range it
  // covers, and a lazily-created hover marker (the dot synced to the chart).
  let panesRendered = [];

  const teardown = () => {
    closeMarkerMenu();
    for (const p of panesRendered) p.map.remove();
    panesRendered = [];
    clearMapPeers();
  };

  // Show a small circle on the route at stream index `idx` (null hides it),
  // driven by the chart's crosshair. The marker lands on whichever pane owns
  // that index; other panes hide theirs.
  const setHoverIndex = (idx) => {
    const ll = idx == null ? null : data.series.latlng[idx];
    for (const p of panesRendered) {
      const inRange = ll && idx >= p.range.startIdx && idx <= p.range.endIdx;
      if (inRange) {
        if (!p.hoverMarker) {
          p.hoverMarker = L.circleMarker(ll, {
            radius: 5,
            color: "white",
            weight: 2,
            fillColor: SEGMENT_HOVER_COLOR,
            fillOpacity: 1,
            interactive: false,
          }).addTo(p.map);
        } else {
          p.hoverMarker.setLatLng(ll);
        }
      } else if (p.hoverMarker) {
        p.hoverMarker.remove();
        p.hoverMarker = null;
      }
    }
  };

  // Clicking "Split here" on a stop marker adds a split at that stop,
  // carving the route into one more pane. Splitting an existing split stop
  // is a no-op. Each split is removed via the ✕ on the pane to its right.
  const onClickStop = (i) => {
    if (splits.includes(i)) return;
    splits = [...splits, i].sort((a, b) => a - b);
    render();
  };

  const removeSplit = (stopIdx) => {
    splits = splits.filter((i) => i !== stopIdx);
    render();
  };

  // Toggle a split from the Stops table: add it if absent, drop it if already
  // a split point. Same effect as "Split here" / the pane ✕, just driven by
  // the table's per-row checkbox.
  const toggleSplit = (i) => {
    if (splits.includes(i)) splits = splits.filter((x) => x !== i);
    else splits = [...splits, i].sort((a, b) => a - b);
    render();
  };

  // Mark the current split stops in the timeline and Stops table (which carry
  // matching data-stop keys) so they read as distinct from ordinary stops, and
  // thicken the Segments-table divider at each split: the segment row arriving
  // at stop i is labelled "<prev> → S{i+1}", so its bottom border is the line
  // between that stop's incoming and outgoing segments.
  // The split markings live in the timeline and the Stops/Segments tables,
  // which are siblings of this component under the analysis view — not inside
  // elRoot — so query the shared #root that hosts the whole mounted view.
  const syncSplitStops = () => {
    root.querySelectorAll(".split-stop").forEach((e) => e.classList.remove("split-stop"));
    root.querySelectorAll(".split-border").forEach((e) => e.classList.remove("split-border"));
    // The Stops-table checkboxes mirror the splits set; clear then re-check so
    // they stay in sync however a split was added (table, map menu, or ✕).
    root.querySelectorAll("input.split-toggle").forEach((cb) => (cb.checked = false));
    for (const i of splits) {
      root.querySelectorAll(`[data-stop="c${i}"]`).forEach((e) => e.classList.add("split-stop"));
      const cb = root.querySelector(`tr[data-stop="c${i}"] input.split-toggle`);
      if (cb) cb.checked = true;
    }
    const suffixes = splits.map((i) => `→ S${i + 1}`);
    root.querySelectorAll("table.segments tr.row[data-seg]").forEach((tr) => {
      if (suffixes.some((suf) => tr.dataset.seg.endsWith(suf))) tr.classList.add("split-border");
    });
  };

  const render = () => {
    teardown();
    mapWrap.innerHTML = "";
    summaryWrap.innerHTML = "";
    const last = data.series.latlng.length - 1;
    const boundaries = splits.map((i) => splitInfoForStop(data.stops, i));
    // N splits → N+1 panes. Pane k runs from the previous split's afterIdx (or
    // the track start) to the next split's beforeIdx (or the track end). Each
    // split stop is shown on the two panes it borders, and every pane but the
    // first carries a ✕ that removes the split on its left edge.
    const nStops = data.stops.length;
    const panes = [];
    for (let k = 0; k <= boundaries.length; k++) {
      const left = boundaries[k - 1]; // undefined on the first pane
      const right = boundaries[k]; // undefined on the last pane
      // A split at stop i cuts after S{i+1}, between orderedSegs[i] (arriving)
      // and orderedSegs[i+1] (leaving). So a pane owns the segments from just
      // after its left split through its right split, inclusive of nulls
      // (zero-length legs) which filter out in paneSummary.
      const leftStop = left ? left.stopIdx : -1;
      const rightStop = right ? right.stopIdx : nStops;
      const segs = model.orderedSegs.slice(leftStop + 1, rightStop + 1).filter(Boolean);
      const startTime = left ? data.stops[left.stopIdx].time_after_s : 0;
      const endTime = right ? data.stops[right.stopIdx].time_before_s : model.endS;
      panes.push({
        range: {
          startIdx: left ? left.afterIdx : 0,
          endIdx: right ? right.beforeIdx : last,
        },
        ctx: {
          startSplitStop: left ? left.stopIdx : null,
          endSplitStop: right ? right.stopIdx : null,
          onClickStop,
          onRemoveSplit: left ? () => removeSplit(left.stopIdx) : undefined,
        },
        segs,
        elapsed: endTime - startTime,
      });
    }
    const isSplit = splits.length > 0;
    summaryWrap.classList.toggle("split", isSplit);
    syncSplitStops();
    // Single-map mode keeps the whole-ride summary up top; only split panes get
    // their own summary. Maps live in #map (the only thing the drag handle
    // resizes); the per-pane summaries live in a matching column row below the
    // handle.
    const inners = panes.map((p) => {
      const d = el("div", { class: "leaflet-map" });
      mapWrap.appendChild(d);
      if (isSplit) summaryWrap.appendChild(paneSummary(p.segs, p.elapsed));
      return d;
    });
    // Leaflet needs the container in the DOM with size before init.
    setTimeout(() => {
      panes.forEach((p, i) => {
        const m = renderMap(inners[i], data, model, p.range, p.ctx);
        if (m) panesRendered.push({ map: m, range: p.range, hoverMarker: null });
      });
    }, 0);
  };

  render();
  return { el: elRoot, destroy: teardown, toggleSplit, setHoverIndex };
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
    const span = b.querySelector("span");
    const txt = on ? labelOn : (labelOff ?? labelOn);
    if (span) span.textContent = txt;
    const t = on ? titleOn : titleOff;
    b.title = t;
    b.setAttribute("aria-label", t);
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

function addToggleControl(map, { className, label, title, onClick, position = "topleft" }) {
  let btn;
  const Ctrl = L.Control.extend({
    options: { position },
    onAdd() {
      btn = el(
        "a",
        {
          class: `map-toggle-btn ${className}`,
          href: "#",
          title,
          role: "button",
          "aria-label": title,
        },
        el("span", { "aria-hidden": "true" }, label),
      );
      const wrapper = el("div", { class: "leaflet-bar leaflet-control" }, btn);
      L.DomEvent.disableClickPropagation(wrapper);
      L.DomEvent.disableScrollPropagation(wrapper);
      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.preventDefault(e);
        onClick(btn);
      });
      return wrapper;
    },
  });
  map.addControl(new Ctrl());
}

function addMapLegend(map, hasStops) {
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
      if (hasStops) {
        items.push(
          el(
            "div",
            { class: "legend-item" },
            el("span", {
              class: "swatch-dot",
              style: `background:${STOP_COLOR}33;border-color:${STOP_COLOR}`,
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
    className: "fullscreen-btn icon",
    // Icons come from CSS (.fullscreen-btn[.is-fullscreen]::before); the label
    // text stays empty and `is-fullscreen` selects maximize vs. minimize.
    labelOn: "",
    labelOff: "",
    titleOn: "Exit fullscreen",
    titleOff: "Toggle fullscreen",
    onChange: (on, btn) => {
      if (btn) btn.classList.toggle("is-fullscreen", on);
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
