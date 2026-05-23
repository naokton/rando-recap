const root = document.getElementById("root");

// --- constants ---------------------------------------------------------
const DEFAULT_MIN_DIST_KM = 190;
const DEFAULT_MIN_STOP = "5m";
const DEFAULT_MERGE_WITHIN_M = 100;
const STORAGE_KEY_USER_PARAMS = "rando-recap.user-params";

// Persisted UI preferences so they survive list → analysis → list navigation
// and reloads. The URL hash still carries authoritative state when present;
// these values fill in defaults when params are absent (e.g. on `#`).
function loadUserParams() {
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
        };
      }
    }
  } catch {}
  return {
    minDist: DEFAULT_MIN_DIST_KM,
    minStop: DEFAULT_MIN_STOP,
    mergeWithinM: DEFAULT_MERGE_WITHIN_M,
  };
}

function saveUserParams(partial) {
  try {
    const merged = { ...loadUserParams(), ...partial };
    localStorage.setItem(STORAGE_KEY_USER_PARAMS, JSON.stringify(merged));
  } catch {}
}

const SEGMENT_COLOR = "#048f67";
const SEGMENT_HOVER_COLOR = "#0ea5e9";
const STOP_COLOR = "#dc2626";
const DAYNIGHT_COLORS = { day: SEGMENT_COLOR, twilight: "#1c8bc4", night: "#033b73" };

const MIN_MAP_HEIGHT_PX = 200;
const STOP_MARKER_MIN_R = 3;
const STOP_MARKER_MAX_R = 40;

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

function splitInfoForStop(stops, idx) {
  const c = stops[idx];
  return { beforeIdx: c.index_before, afterIdx: c.index_after, stopIdx: idx };
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
// snap stop's marker is shown on both maps, so a key may have >1 peer.
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

// --- list view ----------------------------------------------------------
function parseMinDist(s) {
  const v = parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_DIST_KM;
}

function parseMergeWithin(s) {
  const v = parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MERGE_WITHIN_M;
}

// Toolbar popover holding the rides-list filters (currently just minimum
// distance). Applying routes via the hash so the list re-fetches through route().
function buildFilterControl(minDist) {
  const active = minDist !== DEFAULT_MIN_DIST_KM;
  const input = el("input", { type: "number", min: "0", step: "10", value: minDist });
  const form = el(
    "form",
    { class: "filter-panel" },
    el("div", { class: "field" }, el("label", {}, "Min distance"), input, el("span", { class: "unit" }, "km")),
    el("div", { class: "filter-footer" }, el("button", { type: "submit", class: "btn primary" }, "Apply")),
  );
  const btn = el(
    "button",
    { class: `btn filter-btn${active ? " active" : ""}`, type: "button", onclick: () => toggle() },
    "Filter",
  );
  const wrap = el("div", { class: "filter-wrap" }, btn, form);

  const close = () => {
    wrap.classList.remove("open");
    document.removeEventListener("mousedown", onOutside);
  };
  const onOutside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  // Opening on click means the triggering mousedown already fired, so the
  // outside-click listener can be added immediately without re-closing.
  function toggle() {
    if (wrap.classList.toggle("open")) document.addEventListener("mousedown", onOutside);
    else close();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    close();
    const next = parseMinDist(input.value);
    if (next !== minDist) setHash({ min_dist: next });
  });

  return wrap;
}

async function renderList(minDist) {
  saveUserParams({ minDist });
  root.innerHTML = "";

  const body = el("div", {}, el("div", { class: "empty" }, "Loading rides…"));
  root.appendChild(body);

  let data;
  try {
    data = await fetchJson(`/api/rides?min_distance_km=${encodeURIComponent(minDist)}`);
  } catch (e) {
    body.replaceChildren(el("div", { class: "error" }, `Failed to load rides: ${e.message}`));
    return;
  }

  const { minStop: rideMinStop, mergeWithinM: rideMergeWithin } = loadUserParams();

  if (!data.rides.length) {
    body.replaceChildren(
      el("div", { class: "list-toolbar" }, buildFilterControl(minDist)),
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

  let mergeMode = false;
  const selected = new Set();

  const toolbar = el("div", { class: "list-toolbar" });
  const mergeControls = el("div", { class: "merge-controls" });
  toolbar.append(buildFilterControl(minDist), mergeControls);
  const table = el("table", { class: "rides" });
  body.replaceChildren(toolbar, table);

  const rideHash = (rideId) =>
    `#${new URLSearchParams({
      ride: rideId,
      min_stop: rideMinStop,
      merge_within_m: rideMergeWithin,
    })}`;

  const openCombined = () => {
    if (selected.size < 2) return;
    // Sort by start datetime so the backend doesn't have to guess intent.
    const ordered = data.rides
      .filter((r) => selected.has(r.id))
      .sort((a, b) => (a.datetime || "").localeCompare(b.datetime || ""));
    const combinedId = `combined:${ordered.map((r) => r.id).join(",")}`;
    window.location.hash = rideHash(combinedId).slice(1);
  };

  const renderToolbar = () => {
    mergeControls.replaceChildren();
    if (!mergeMode) {
      mergeControls.appendChild(
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              mergeMode = true;
              renderToolbar();
              renderTable();
            },
          },
          "Merge rides",
        ),
      );
      return;
    }
    const openBtn = el(
      "button",
      {
        class: "btn primary",
        type: "button",
        onclick: openCombined,
      },
      selected.size >= 2 ? `Open (${selected.size})` : "Open",
    );
    if (selected.size < 2) openBtn.setAttribute("disabled", "");
    mergeControls.appendChild(
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            mergeMode = false;
            selected.clear();
            renderToolbar();
            renderTable();
          },
        },
        "Cancel",
      ),
    );
    mergeControls.appendChild(openBtn);
  };

  const renderTable = () => {
    table.classList.toggle("merge-mode", mergeMode);
    table.replaceChildren(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          mergeMode ? el("th", { class: "pick" }) : null,
          el("th", { class: "date" }, "Date"),
          el("th", { class: "dist" }, "Distance"),
          el("th", { class: "name" }, "Name"),
        ),
      ),
      el(
        "tbody",
        {},
        data.rides.map((r) => {
          const cells = [];
          let cb = null;
          if (mergeMode) {
            cb = el("input", { type: "checkbox" });
            cells.push(el("td", { class: "pick" }, cb));
          }
          cells.push(el("td", { class: "date" }, (r.datetime || "").slice(0, 10)));
          cells.push(el("td", { class: "dist" }, `${r.distance_km.toFixed(1)} km`));
          cells.push(
            el(
              "td",
              { class: "name" },
              mergeMode ? r.name : el("a", { href: rideHash(r.id) }, r.name),
            ),
          );
          const row = el("tr", {}, cells);
          if (mergeMode) {
            cb.addEventListener("change", () => {
              if (cb.checked) selected.add(r.id);
              else selected.delete(r.id);
              row.classList.toggle("selected", cb.checked);
              renderToolbar();
            });
            // Whole-row click toggles the checkbox so users don't have to aim.
            row.addEventListener("click", (e) => {
              if (e.target.tagName === "INPUT") return;
              cb.checked = !cb.checked;
              cb.dispatchEvent(new Event("change"));
            });
          }
          return row;
        }),
      ),
    );
  };

  renderToolbar();
  renderTable();
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
function renderStopsTable(activity, stops, cumKm) {
  if (!stops.length) {
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
      stops.map((c, i) =>
        el(
          "tr",
          { class: "row", "data-stop": `c${i}` },
          el("td", {}, `S${i + 1}`),
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

// --- marker context menu ----------------------------------------------
// Lightweight native-style context menu shown at the cursor on right-click.
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
    const item = el("div", { class: "marker-menu-item" }, label);
    item.addEventListener("click", () => {
      closeMarkerMenu();
      onSelect();
    });
    menu.appendChild(item);
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
  // Defer the outside-click binding so the same right-click that opened the
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

function drawStopMarkers(map, stops, cumKm, fmtClock, range, splitInfo, onClickStop) {
  // The split stop is shown on both halves so it anchors visibly on each map.
  const visible = stops
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => {
      const inRange = c.index_before >= range.startIdx && c.index_before <= range.endIdx;
      const isSnap = splitInfo && splitInfo.stopIdx === i;
      return inRange || isSnap;
    });
  if (!visible.length) return null;
  // Radius normalization uses the global maxRest so marker sizes are
  // comparable across the two split maps, not just within a half.
  const maxRest = Math.max(1, ...stops.map((c) => c.rest_s || 0));
  // Render largest circles first so smaller ones land on top — when stops
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
        STOP_MARKER_MIN_R +
        (STOP_MARKER_MAX_R - STOP_MARKER_MIN_R) * Math.sqrt((c.rest_s || 0) / maxRest),
    }))
    .sort((a, b) => b.radius - a.radius);
  const markers = ordered.map(({ c, i, radius }) => {
    const km = cumKm[i + 1].toFixed(1);
    const arrive = fmtClock(c.time_before_s);
    const depart = fmtClock(c.time_after_s);
    const marker = L.circleMarker([c.lat, c.lng], {
      radius,
      color: STOP_COLOR,
      weight: 1,
      fillColor: STOP_COLOR,
      fillOpacity: 0.2,
    }).bindTooltip(`<b>S${i + 1}</b><br>${km} km<br>${arrive} → ${depart}<br>${fmtDur(c.rest_s)}`, {
      direction: "top",
      offset: [0, -4],
    });
    registerMapPeer("stop", `c${i}`, marker, (on) => {
      marker.setStyle({ weight: on ? 3 : 1, fillOpacity: on ? 0.5 : 0.2 });
    });
    if (onClickStop) {
      marker.on("contextmenu", (ev) => {
        L.DomEvent.preventDefault(ev.originalEvent);
        if (splitInfo && splitInfo.stopIdx === i) return;
        const label = splitInfo ? "Move split here" : "Split here";
        openMarkerMenu(ev.originalEvent, [{ label, onSelect: () => onClickStop(i) }]);
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
  const { latlng, segments, stops, daynight, activity } = data;
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
  const stopsLayer = drawStopMarkers(
    map,
    stops,
    cumKm,
    fmtClock,
    range,
    ctx.splitInfo,
    ctx.onClickStop,
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
  if (ctx.onMerge)
    addToggleControl(map, {
      className: "merge-btn",
      label: "✕",
      title: "Close split view",
      onClick: () => ctx.onMerge(),
      position: "topright",
    });
  return map;
}

function buildMapArea(wrapper, data, model) {
  let splitInfo = null; // null = single-map mode
  let maps = [];

  const teardown = () => {
    closeMarkerMenu();
    for (const m of maps) m.remove();
    maps = [];
    clearMapPeers();
  };

  // Right-click menu on a stop marker drives splitting: it both opens
  // a route at a chosen stop (pre-split) and relocates the split point
  // (post-split). Merging is done via the close button on the right pane.
  const onClickStop = (i) => {
    if (splitInfo && splitInfo.stopIdx === i) return;
    splitInfo = splitInfoForStop(data.stops, i);
    render();
  };

  const onMerge = () => {
    splitInfo = null;
    render();
  };

  const render = () => {
    teardown();
    wrapper.innerHTML = "";
    const last = data.latlng.length - 1;
    // Close button sits on the right pane; the left has no merge button.
    const panes = splitInfo
      ? [
          {
            range: { startIdx: 0, endIdx: splitInfo.beforeIdx },
            ctx: { splitInfo, onClickStop },
          },
          {
            range: { startIdx: splitInfo.afterIdx, endIdx: last },
            ctx: { splitInfo, onClickStop, onMerge },
          },
        ]
      : [
          {
            range: { startIdx: 0, endIdx: last },
            ctx: { splitInfo: null, onClickStop },
          },
        ];
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
    className: "fullscreen-btn",
    labelOn: "⇱",
    labelOff: "⛶",
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
async function renderAnalysis(rideId, minStop, mergeWithinM) {
  saveUserParams({ minStop, mergeWithinM });
  // ---------------------
  // Loading
  root.innerHTML = "";
  root.appendChild(el("div", { class: "empty" }, "Loading…"));
  let data;
  try {
    const qs = new URLSearchParams({ min_stop: minStop, merge_within_m: mergeWithinM });
    data = await fetchJson(`/api/rides/${rideId}/analysis?${qs}`);
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

  const item = (label, value) =>
    el(
      "div",
      { class: "item" },
      el("span", { class: "label" }, `${label}:`),
      el("span", { class: "value" }, value),
    );

  const dnRow = (state, value) =>
    el(
      "div",
      { class: "dn-row" },
      el("span", { class: "dn-dot", style: `background:${DAYNIGHT_COLORS[state]}` }),
      el("span", { class: "dn-label" }, state),
      el("span", { class: "dn-value" }, value),
    );

  root.appendChild(
    el(
      "div",
      { class: "summary" },
      el(
        "div",
        { class: "summary-col" },
        item("Distance", `${(a.distance_m / 1000).toFixed(1)} km`),
        item("Climb", `${Math.round(a.total_elevation_gain_m || 0)} m`),
      ),
      el(
        "div",
        { class: "summary-col" },
        item("Elapsed", fmtDur(a.elapsed_time_s)),
        item("Moving", fmtDur(a.moving_time_s)),
        el(
          "div",
          { class: "breakdown" },
          dnRow("day", fmtDur(a.moving_day_time_s)),
          dnRow("twilight", fmtDur(a.moving_twilight_time_s)),
          dnRow("night", fmtDur(a.moving_night_time_s)),
        ),
        item("Rest", fmtDur(a.elapsed_time_s - a.moving_time_s)),
      ),
    ),
  );

  const model = buildTimelineModel(data.stops, data.segments);

  // ---------------------
  // Map
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
  root.appendChild(renderTimeline(data.activity, data.stops, model));

  // ---------------------
  // Table
  root.appendChild(
    el(
      "div",
      { class: "tables-row" },
      el(
        "section",
        {},
        el("h2", {}, "Stops"),
        renderStopsTable(data.activity, data.stops, model.cumKm),
      ),
      el("section", {}, el("h2", {}, "Segments"), renderSegmentsTable(data.segments)),
    ),
  );
}

// --- routing ------------------------------------------------------------
function parseHash() {
  const saved = loadUserParams();
  const h = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(h);
  const ride = params.get("ride");
  if (ride) {
    const mergeParam = params.get("merge_within_m");
    return {
      view: "analysis",
      rideId: ride,
      minStop: params.get("min_stop") || saved.minStop,
      mergeWithinM: mergeParam != null ? parseMergeWithin(mergeParam) : saved.mergeWithinM,
    };
  }
  const minDistParam = params.get("min_dist");
  return {
    view: "list",
    minDist: minDistParam != null ? parseMinDist(minDistParam) : saved.minDist,
  };
}

function setHash(params) {
  window.location.hash = new URLSearchParams(params).toString();
}

function route() {
  unmountCurrentView();
  const r = parseHash();
  if (r.view === "analysis") renderAnalysis(r.rideId, r.minStop, r.mergeWithinM);
  else renderList(r.minDist);
}

window.addEventListener("hashchange", route);
route();

// --- config dialog ------------------------------------------------------
(function setupConfigDialog() {
  const dialog = document.getElementById("config-dialog");
  const form = document.getElementById("config-form");
  const minStopInput = document.getElementById("cfg-min-stop");
  const mergeInput = document.getElementById("cfg-merge");

  document.getElementById("config-btn").addEventListener("click", () => {
    const saved = loadUserParams();
    minStopInput.value = saved.minStop;
    mergeInput.value = saved.mergeWithinM;
    dialog.showModal();
  });

  document.getElementById("cfg-cancel").addEventListener("click", () => dialog.close());

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const minStop = minStopInput.value.trim() || DEFAULT_MIN_STOP;
    const mergeWithinM = parseMergeWithin(mergeInput.value);

    // Capture currently-rendered params *before* saving so we can detect
    // whether the change actually affects this view — these are analysis
    // params, so a list view gets the new values persisted but no re-fetch.
    const before = parseHash();
    saveUserParams({ minStop, mergeWithinM });
    dialog.close();

    if (
      before.view === "analysis" &&
      (before.minStop !== minStop || before.mergeWithinM !== mergeWithinM)
    ) {
      setHash({ ride: before.rideId, min_stop: minStop, merge_within_m: mergeWithinM });
    }
  });
})();
