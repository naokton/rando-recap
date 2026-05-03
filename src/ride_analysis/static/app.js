const root = document.getElementById("root");
const crumb = document.getElementById("crumb");

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
    try { const body = await r.json(); if (body.detail) msg = body.detail; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// --- list view ----------------------------------------------------------
async function renderList() {
  crumb.textContent = "";
  // loading
  root.innerHTML = "";
  root.appendChild(el("div", { class: "empty" }, "Loading rides…"));
  let data;
  try { data = await fetchJson("/api/rides"); }
  catch (e) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "error" }, `Failed to load rides: ${e.message}`));
    return;
  }

  // no list item
  root.innerHTML = "";
  if (!data.rides.length) {
    root.appendChild(el("div", { class: "empty" },
      `No rides match. ${data.total_cached} cached. Run `,
      el("code", {}, "ride fetch"), " to populate."));
    return;
  }

  // render list
  const table = el("table", { class: "rides" },
    el("thead", {}, el("tr", {},
      el("th", { class: "date" }, "Date"),
      el("th", { class: "dist" }, "Distance"),
      el("th", { class: "name" }, "Name"),
    )),
    el("tbody", {},
      data.rides.map(r =>
        el("tr", { class: "row", onclick: () => navigate(r.id) },
          el("td", { class: "date" }, r.date),
          el("td", { class: "dist" }, `${r.distance_km.toFixed(1)} km`),
          el("td", { class: "name" }, r.name),
        )
      )
    ),
  );
  root.appendChild(table);
}

// --- analysis view ------------------------------------------------------
function buildTimelineModel(controls, segments) {
  const stopLabels = ["Start", ...controls.map((_, i) => `C${i + 1}`), "End"];
  const segByLabel = Object.fromEntries(segments.map(s => [s.label, s]));
  const segLabels = stopLabels.slice(0, -1).map((s, i) => `${s} → ${stopLabels[i + 1]}`);
  const orderedSegs = segLabels.map(l => segByLabel[l] ?? null);
  const cumKm = [0];
  for (const s of orderedSegs) cumKm.push(cumKm[cumKm.length - 1] + (s ? s.distance_m / 1000 : 0));
  return { stopLabels, orderedSegs, cumKm };
}

function endSeconds(controls, orderedSegs) {
  if (controls.length) {
    const last = orderedSegs[orderedSegs.length - 1];
    return controls[controls.length - 1].time_after_s + (last ? last.duration_s : 0);
  }
  return orderedSegs[0] ? orderedSegs[0].duration_s : 0;
}

function renderTimeline(activity, controls, model) {
  const fmtClock = makeClockFmt(activity.start_date, activity.utc_offset_s);
  const { stopLabels, orderedSegs, cumKm } = model;
  const endS = endSeconds(controls, orderedSegs);

  const wrap = el("div", { class: "timeline-wrap" });
  const grid = el("div", { class: "timeline" });

  // Build columns: stop, seg, stop, seg, ..., stop
  let col = 1;
  stopLabels.forEach((label, i) => {
    let arrive = null, depart = null, rest = null;
    if (label === "Start") { depart = fmtClock(0); rest = 0; }
    else if (label === "End") { arrive = fmtClock(endS); rest = 0; }
    else {
      const c = controls[i - 1];
      arrive = fmtClock(c.time_before_s);
      depart = fmtClock(c.time_after_s);
      rest = c.rest_s;
    }
    const stopCol = col++;
    grid.appendChild(el("div", { class: "stop-cell", style: `grid-column: ${stopCol}` },
      el("div", { class: "lab" }, label),
      el("div", { class: "km" }, `${cumKm[i].toFixed(1)} km`),
      el("div", { class: "clock" },
        arrive && depart ? `${arrive} → ${depart}` : (depart || arrive)),
      el("div", { class: "rest" }, rest != null ? (rest === 0 ? "0m" : fmtDur(rest)) : ""),
    ));
    grid.appendChild(el("div", { class: "track-stop", style: `grid-column: ${stopCol}` },
      el("span", { class: "dot" })));

    if (i < orderedSegs.length) {
      const segCol = col++;
      grid.appendChild(el("div", { class: "track-seg", style: `grid-column: ${segCol}` }));
      const s = orderedSegs[i];
      const cell = el("div", { class: "seg-cell", style: `grid-column: ${segCol}` });
      if (!s) {
        cell.appendChild(el("div", {}, "(no movement)"));
      } else {
        cell.appendChild(el("div", { class: "km" }, `${(s.distance_m / 1000).toFixed(1)} km`));
        cell.appendChild(el("div", {}, fmtDur(s.duration_s)));
        cell.appendChild(el("div", {}, s.avg_speed_mps == null ? "-" : `${fmtKmh(s.avg_speed_mps)} km/h`));
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
  return el("table", { class: "data" },
    el("thead", {}, el("tr", {},
      el("th", {}, "#"),
      el("th", {}, "Dist (km)"),
      el("th", {}, "Arrive"),
      el("th", {}, "Depart"),
      el("th", {}, "Rest"),
    )),
    el("tbody", {}, controls.map((c, i) => el("tr", { class: "row" },
      el("td", {}, `C${i + 1}`),
      el("td", {}, cumKm[i + 1].toFixed(1)),
      el("td", {}, fmtClock(c.time_before_s)),
      el("td", {}, fmtClock(c.time_after_s)),
      el("td", {}, fmtDur(c.rest_s)),
    ))),
  );
}

function renderSegmentsTable(segments) {
  return el("table", { class: "data" },
    el("thead", {}, el("tr", {},
      el("th", {}, "Segment"),
      el("th", {}, "Dist (km)"),
      el("th", {}, "Time"),
      el("th", {}, "Avg km/h"),
      el("th", {}, "Avg HR"),
      el("th", {}, "Avg Cad"),
      el("th", {}, "Avg W"),
      el("th", {}, "Climb (m)"),
      el("th", {}, "m/km"),
    )),
    el("tbody", {}, segments.map(s => el("tr", { class: "row" },
      el("td", {}, s.label),
      el("td", {}, (s.distance_m / 1000).toFixed(2)),
      el("td", {}, fmtDur(s.duration_s)),
      el("td", {}, fmtKmh(s.avg_speed_mps)),
      el("td", {}, fmtNum(s.avg_hr)),
      el("td", {}, fmtNum(s.avg_cadence)),
      el("td", {}, fmtNum(s.avg_watts)),
      el("td", {}, fmtNum(s.climb_m)),
      el("td", {}, fmtNum(s.climb_m_per_km, 1)),
    ))),
  );
}

let mapInstance = null;
function renderMap(container, polyline, controls, activity, model) {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  if (!polyline || !polyline.length) {
    container.appendChild(el("div", { class: "empty" }, "No GPS data."));
    return;
  }
  const map = L.map(container).setView(polyline[0], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const line = L.polyline(polyline, { color: "#047857", weight: 3 }).addTo(map);
  const fmtClock = makeClockFmt(activity.start_date, activity.utc_offset_s);
  const { cumKm, orderedSegs } = model;
  const endS = endSeconds(controls, orderedSegs);
  const totalKm = cumKm[cumKm.length - 1].toFixed(1);

  L.marker(polyline[0]).addTo(map)
    .bindPopup(
      `<b>Start</b><br>` +
      `0.0 km<br>` +
      `${fmtClock(0)}`
    );

  const maxRest = Math.max(1, ...controls.map(c => c.rest_s || 0));
  const minR = 3, maxR = 40;
  // Render largest circles first so smaller ones land on top — when controls
  // cluster at the same place, the smaller circle stays hoverable instead of
  // being buried under the larger one.
  const ordered = controls
    .map((c, i) => ({
      c,
      i,
      // Radius scales with sqrt(rest_s / maxRest) so circle *area* is roughly
      // proportional to rest time. Normalizing to maxRest keeps the longest
      // rest at maxR (so it always fits on the map) while preserving relative
      // size differences between shorter rests.
      radius: minR + (maxR - minR) * Math.sqrt((c.rest_s || 0) / maxRest),
    }))
    .sort((a, b) => b.radius - a.radius);
  ordered.forEach(({ c, i, radius }) => {
    const km = cumKm[i + 1].toFixed(1);
    const arrive = fmtClock(c.time_before_s);
    const depart = fmtClock(c.time_after_s);
    const marker = L.circleMarker([c.lat, c.lng], {
      radius,
      color: "#dc2626",
      weight: 1,
      fillColor: "#dc2626",
      fillOpacity: 0.2,
    }).addTo(map).bindTooltip(
      `<b>C${i + 1}</b><br>` +
      `${km} km<br>` +
      `${arrive} → ${depart}<br>` +
      `${fmtDur(c.rest_s)}`,
      { direction: "top", offset: [0, -4] }
    );
    marker.on("mouseover", () => marker.setStyle({ weight: 3 }));
    marker.on("mouseout", () => marker.setStyle({ weight: 1 }));
  });

  L.marker(polyline[polyline.length - 1]).addTo(map)
    .bindPopup(
      `<b>End</b><br>` +
      `${totalKm} km<br>` +
      `${fmtClock(endS)}`
    );

  const bounds = line.getBounds();
  map.fitBounds(bounds, { padding: [20, 20] });
  addFullscreenControl(map, container, bounds);
  mapInstance = map;
}

function addFullscreenControl(map, container, bounds) {
  let btn;
  let on = false;
  let escHandler = null;

  const applyClasses = () => {
    container.classList.toggle("map-fullscreen", on);
    document.body.classList.toggle("map-fullscreen-active", on);
    btn.innerHTML = on ? "⤡" : "⤢";
    btn.title = on ? "Exit fullscreen" : "Toggle fullscreen";
  };

  const toggle = () => {
    on = !on;
    if (on) {
      escHandler = (e) => { if (e.key === "Escape") toggle(); };
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

  const Ctrl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      btn = el("a", {
        class: "leaflet-bar leaflet-control fullscreen-btn",
        href: "#",
        title: "Toggle fullscreen",
        role: "button",
      }, "⤢");
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.disableScrollPropagation(btn);
      L.DomEvent.on(btn, "click", (e) => { L.DomEvent.preventDefault(e); toggle(); });
      return btn;
    },
  });
  map.addControl(new Ctrl());
  map.on("unload", cleanup);
}

async function renderAnalysis(rideId, minStop) {
  crumb.textContent = `ride ${rideId}`;

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

  // ---------------------
  // Title & Info
  const a = data.activity;
  root.appendChild(el("h2", { class: "ride-title" },
    a.name || "(unnamed ride)",
    el("span", { class: "date" },
      `(${(a.start_date_local || a.start_date || "").slice(0, 10)})`)));

  root.appendChild(el("div", { class: "summary" },
    el("div", { class: "item" }, el("span", { class: "label" }, "Distance:"),
      el("span", { class: "value" }, `${(a.distance_m / 1000).toFixed(1)} km`)),
    el("div", { class: "item" }, el("span", { class: "label" }, "Elapsed:"),
      el("span", { class: "value" }, fmtDur(a.elapsed_time_s))),
    el("div", { class: "item" }, el("span", { class: "label" }, "Moving:"),
      el("span", { class: "value" }, fmtDur(a.moving_time_s))),
    el("div", { class: "item" }, el("span", { class: "label" }, "Climb:"),
      el("span", { class: "value" }, `${Math.round(a.total_elevation_gain_m || 0)} m`)),
  ));

  const minStopInput = el("input", { type: "text", value: minStop });
  const apply = () => {
    const v = minStopInput.value.trim() || "5m";
    navigate(rideId, v);
  };
  minStopInput.addEventListener("keydown", e => { if (e.key === "Enter") apply(); });
  root.appendChild(el("div", { class: "controls-row" },
    el("label", {}, "Min stop:"), minStopInput,
    el("button", { onclick: apply }, "Apply"),
  ));

  // ---------------------
  // Map
  root.appendChild(el("h2", {}, "Map"));
  const mapDiv = el("div", { id: "map" });
  root.appendChild(mapDiv);
  // Leaflet needs the container in the DOM with size before init.
  setTimeout(() => renderMap(mapDiv, data.polyline, data.controls, data.activity, model), 0);

  // ---------------------
  // Timeline
  const model = buildTimelineModel(data.controls, data.segments);
  root.appendChild(renderTimeline(data.activity, data.controls, model));

  // ---------------------
  // Table
  root.appendChild(el("div", { class: "tables-row" },
    el("section", {},
      el("h2", {}, "Controls"),
      renderControlsTable(data.activity, data.controls, model.cumKm)),
    el("section", {},
      el("h2", {}, "Segments"),
      renderSegmentsTable(data.segments)),
  ));
}

// --- routing ------------------------------------------------------------
function parseHash() {
  const h = window.location.hash.replace(/^#/, "");
  if (!h) return { view: "list" };
  const params = new URLSearchParams(h);
  const ride = params.get("ride");
  if (ride) return { view: "analysis", rideId: ride, minStop: params.get("min_stop") || "5m" };
  return { view: "list" };
}

function navigate(rideId, minStop = "5m") {
  if (rideId == null) {
    window.location.hash = "";
  } else {
    const p = new URLSearchParams({ ride: rideId, min_stop: minStop });
    window.location.hash = p.toString();
  }
}

function route() {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  const r = parseHash();
  if (r.view === "analysis") renderAnalysis(r.rideId, r.minStop);
  else renderList();
}

window.addEventListener("hashchange", route);
route();
