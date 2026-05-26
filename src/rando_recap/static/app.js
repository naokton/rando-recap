const root = document.getElementById("root");

// --- constants ---------------------------------------------------------
const DEFAULT_MIN_DIST_KM = 190;
const DEFAULT_MIN_STOP = "5m";
const DEFAULT_MERGE_WITHIN_M = 100;
const DEFAULT_FETCH_SINCE = "1m";
const STORAGE_KEY_USER_PARAMS = "rando-recap.user-params";
// Windows offered by the Fetch popover; values are what the API's `since` param
// accepts (Nd/Nw/Nm/Ny or 'all'). Labels are user-facing.
const FETCH_WINDOWS = [
  { value: "1w", label: "Last week" },
  { value: "1m", label: "Last month" },
  { value: "6m", label: "Last 6 months" },
  { value: "1y", label: "Last year" },
  { value: "all", label: "All time" },
];
// Mirror of the backend floor (stops.py MIN_STOP_FLOOR_S): the ~1s sample
// interval means a threshold at or below 1s flags every point as a stop, so
// the API rejects it. Require strictly more than this in the form too.
const MIN_STOP_FLOOR_S = 1;

// Parse a duration string ('5m', '300s', '1h', '90') to seconds, mirroring
// the backend parse_duration. Returns null on unrecognized input.
function minStopToSeconds(value) {
  const m = String(value)
    .trim()
    .match(/^(\d+)\s*([smh]?)$/i);
  if (!m) return null;
  const unit = (m[2] || "m").toLowerCase();
  return parseInt(m[1], 10) * { s: 1, m: 60, h: 3600 }[unit];
}

// Break total seconds into {h, m, s} for the form fields.
function secondsToHMS(total) {
  const t = Math.max(0, Math.floor(total));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

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
          fetchSince: parseFetchSince(parsed.fetchSince),
        };
      }
    }
  } catch {}
  return {
    minDist: DEFAULT_MIN_DIST_KM,
    minStop: DEFAULT_MIN_STOP,
    mergeWithinM: DEFAULT_MERGE_WITHIN_M,
    fetchSince: DEFAULT_FETCH_SINCE,
  };
}

function saveUserParams(partial) {
  try {
    const merged = { ...loadUserParams(), ...partial };
    localStorage.setItem(STORAGE_KEY_USER_PARAMS, JSON.stringify(merged));
  } catch {}
}

// Map colors live in style.css (:root) so the palette has one home; Leaflet
// can't read CSS vars itself, so we resolve them once at load. The stylesheet
// is <link>ed in <head> before this script runs, so the values are available.
const cssVar = (() => {
  const root = getComputedStyle(document.documentElement);
  return (name) => root.getPropertyValue(name).trim();
})();
const SEGMENT_COLOR = cssVar("--segment");
const SEGMENT_HOVER_COLOR = cssVar("--segment-hover");
const STOP_COLOR = cssVar("--stop");
const DAYNIGHT_COLORS = {
  day: SEGMENT_COLOR,
  twilight: cssVar("--twilight"),
  night: cssVar("--night"),
};

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
function fmtPct(frac) {
  return frac == null ? "-" : `${Math.round(frac * 100)}%`;
}
// "18°C (9–27°C)" — drops the range when min/max round equal or are missing.
function fmtTempRange(avg, min, max) {
  if (avg == null) return "-";
  const a = `${Math.round(avg)}°C`;
  if (min != null && max != null && Math.round(min) !== Math.round(max))
    return `${a} (${Math.round(min)}–${Math.round(max)}°C)`;
  return a;
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
    // Any on* key whose value is a function binds that event listener, so
    // handlers declare inline alongside the element instead of a trailing
    // addEventListener (onclick, onsubmit, onchange, …).
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
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

function parseFetchSince(s) {
  return FETCH_WINDOWS.some((w) => w.value === s) ? s : DEFAULT_FETCH_SINCE;
}

// Toolbar popover holding the rides-list filters (currently just minimum
// distance). Applying routes via the hash so the list re-fetches through route().
function buildFilterControl(minDist) {
  const active = minDist !== DEFAULT_MIN_DIST_KM;
  const input = el("input", { type: "number", min: "0", step: "10", value: minDist });
  const form = el(
    "form",
    { class: "filter-panel" },
    el(
      "div",
      { class: "field" },
      el("label", {}, "Min distance"),
      input,
      el("span", { class: "unit" }, "km"),
    ),
    el(
      "div",
      { class: "filter-footer" },
      el("button", { type: "submit", class: "btn primary" }, "Apply"),
    ),
  );
  const btn = el("button", {
    class: `btn filter-btn icon${active ? " active" : ""}`,
    type: "button",
    title: "Filter",
    "aria-label": "Filter",
    onclick: () => toggle(),
  });
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

// Toolbar popover that pulls activity summaries from Strava. Picking a window
// and submitting hands off to renderFetch, which streams progress.
function buildFetchControl() {
  const saved = loadUserParams();
  const select = el(
    "select",
    { class: "fetch-since" },
    ...FETCH_WINDOWS.map((w) => el("option", { value: w.value }, w.label)),
  );
  select.value = saved.fetchSince;
  const form = el(
    "form",
    { class: "filter-panel" },
    el("div", { class: "field fetch-field" }, el("label", {}, "Fetch rides from"), select),
    el(
      "div",
      { class: "filter-footer" },
      el("button", { type: "submit", class: "btn primary" }, "Fetch"),
    ),
  );
  const btn = el(
    "button",
    { class: "btn fetch-btn", type: "button", title: "Fetch rides from Strava" },
    "Fetch rides",
  );
  const wrap = el("div", { class: "filter-wrap fetch-wrap" }, btn, form);

  const close = () => {
    wrap.classList.remove("open");
    document.removeEventListener("mousedown", onOutside);
  };
  const onOutside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  btn.addEventListener("click", () => {
    if (wrap.classList.toggle("open")) document.addEventListener("mousedown", onOutside);
    else close();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    close();
    const since = parseFetchSince(select.value);
    saveUserParams({ fetchSince: since });
    renderFetch(since);
  });

  return wrap;
}

// Consume the SSE stream from POST /api/fetch, invoking callbacks per event.
// Uses a fetch() reader (not EventSource, which can't POST) and parses the
// `data: <json>\n\n` frames by hand. `signal` aborts an in-flight fetch when
// the view unmounts.
async function streamFetch(since, signal, { onProgress, onDone, onError }) {
  let resp;
  try {
    resp = await fetch(`/api/fetch?since=${encodeURIComponent(since)}`, { method: "POST", signal });
  } catch (e) {
    if (e.name !== "AbortError") onError(e.message);
    return;
  }
  if (!resp.ok) {
    let msg = `${resp.status} ${resp.statusText}`;
    try {
      const body = await resp.json();
      if (body.detail) msg = body.detail;
    } catch {}
    onError(msg);
    return;
  }
  const dispatch = (frame) => {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    let ev;
    try {
      ev = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (ev.type === "progress") onProgress(ev);
    else if (ev.type === "done") onDone(ev);
    else if (ev.type === "error") onError(ev.detail);
  };

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        dispatch(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    }
    // Flush a final frame that arrived without its trailing blank line so a
    // terminal done/error event isn't lost to proxy buffering / abrupt close.
    if (buf.trim()) dispatch(buf);
  } catch (e) {
    if (e.name !== "AbortError") onError(e.message);
  }
}

// Full-screen progress view shown while a fetch runs: a live log mirroring the
// old CLI output, running counts, and a "Back to rides" exit that re-renders the
// list (so freshly fetched rides show). Aborts the stream if unmounted early.
function renderFetch(since) {
  unmountCurrentView();
  root.innerHTML = "";

  const counts = el("div", { class: "fetch-counts" });
  const log = el("div", { class: "fetch-log" });
  const footer = el("div", { class: "fetch-footer" });
  root.appendChild(
    el("div", { class: "fetch-view" }, el("h2", {}, "Fetching rides"), counts, log, footer),
  );

  const controller = new AbortController();
  currentView = { unmount: () => controller.abort() };

  let seen = 0;
  let added = 0;
  let updated = 0;
  const setCounts = (status) => {
    counts.textContent = `seen ${seen} · added ${added} · updated ${updated}${
      status ? ` — ${status}` : ""
    }`;
  };
  setCounts("starting…");

  const appendLine = (cls, text) => {
    log.appendChild(el("div", { class: `fetch-line ${cls}` }, text));
    log.scrollTop = log.scrollHeight;
  };
  const showBack = () => {
    // The fetch view never changed the hash, so it still encodes the list. A
    // plain route() re-parses it and re-renders the (now repopulated) list.
    footer.appendChild(
      el("button", { class: "btn", type: "button", onclick: () => route() }, "Back to rides"),
    );
  };

  streamFetch(since, controller.signal, {
    onProgress: (ev) => {
      seen += 1;
      if (ev.action === "add") added += 1;
      else updated += 1;
      setCounts("");
      const km = (ev.distance_km ?? 0).toFixed(1).padStart(6);
      appendLine(
        ev.action,
        `${ev.action.padEnd(8)}${(ev.datetime || "").slice(0, 10)}  ${km} km  ${ev.name || ""}`,
      );
    },
    onDone: (ev) => {
      setCounts("done");
      appendLine("done", `Done. seen=${ev.seen} added=${ev.added} updated=${ev.updated}`);
      showBack();
    },
    onError: (detail) => {
      setCounts("failed");
      appendLine("error", detail);
      showBack();
    },
  });
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

  if (!data.rides.length) {
    const message = data.total_cached
      ? `No rides match. ${data.total_cached} cached. Use “Fetch rides” to pull more from Strava, or lower the minimum distance.`
      : "No rides cached yet. Use “Fetch rides” to pull them from Strava.";
    body.replaceChildren(
      el("div", { class: "list-toolbar" }, buildFetchControl(), buildFilterControl(minDist)),
      el("div", { class: "empty" }, message),
    );
    return;
  }

  let mergeMode = false;
  const selected = new Set();

  const toolbar = el("div", { class: "list-toolbar" });
  const filterControl = buildFilterControl(minDist);
  const fetchControl = buildFetchControl();
  const mergeControls = el("div", { class: "merge-controls" });
  toolbar.append(mergeControls, fetchControl, filterControl);
  const table = el("table", { class: "rides" });
  body.replaceChildren(toolbar, table);

  // Link only the ride id; analysis params are filled from saved prefs by
  // parseHash at navigation time. Baking them into the href here would
  // capture them at render time and ignore later Settings changes.
  const rideHash = (rideId) => `#${new URLSearchParams({ ride: rideId })}`;

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
    // In merge mode only Cancel/Open show; the filter and fetch controls hide.
    filterControl.classList.toggle("hidden", mergeMode);
    fetchControl.classList.toggle("hidden", mergeMode);
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
          "Stitch rides",
        ),
      );
      return;
    }
    mergeControls.appendChild(
      el(
        "span",
        { class: "merge-hint" },
        "Stitch selected rides into one view. Your activity data stay separate.",
      ),
    );
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
        el("th", {}, "HR"),
        el("th", {}, "Cad"),
        el("th", {}, "Power"),
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
          el("td", {}, fmtNum(s.avg_hr)),
          el("td", {}, fmtNum(s.avg_cadence)),
          el("td", {}, fmtNum(s.avg_watts)),
          el("td", {}, fmtNum(s.avg_temp)),
          el("td", {}, fmtPct(s.coasting_frac)),
          el("td", {}, fmtNum(s.climb_m)),
          el("td", {}, fmtNum(s.climb_m_per_km, 1)),
        ),
      ),
    ),
  );
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

function drawEndpointMarkers(map, latlng, range, fmtClock, endS, stops, startSplitStop, endSplitStop) {
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
      .bindTooltip(`<b>S${startSplitStop + 1}</b><br>departs ${fmtClock(c.time_after_s)}`, tooltipOpts);
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
      .bindTooltip(`<b>S${endSplitStop + 1}</b><br>arrives ${fmtClock(c.time_before_s)}`, tooltipOpts);
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
  const { endS } = model;

  const hasDaynight = drawDaynightPath(map, latlng, daynight, range);
  const segLines = drawSegmentLines(map, latlng, segments, hasDaynight, range);
  drawEndpointMarkers(map, latlng, range, fmtClock, endS, stops, ctx.startSplitStop, ctx.endSplitStop);
  const stopsLayer = drawStopMarkers(map, stops, range, ctx.onClickStop, ctx.startSplitStop, ctx.endSplitStop);
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

// Shared summary builders, used by both the whole-ride summary and the
// per-pane summaries shown under each split map.
function summaryItem(label, value) {
  return el(
    "div",
    { class: "item" },
    el("span", { class: "label" }, `${label}:`),
    el("span", { class: "value" }, value),
  );
}

function summaryDnRow(state, value) {
  return el(
    "div",
    { class: "dn-row" },
    el("span", { class: `dn-label icon dn-${state}`, title: state }),
    el("span", { class: "dn-value" }, value),
  );
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
  return el(
    "div",
    { class: "pane-summary" },
    summaryItem("Dist", `${(sum((s) => s.distance_m) / 1000).toFixed(1)} km`),
    summaryItem("Climb", `${Math.round(sum((s) => s.climb_m))} m`),
    summaryItem("Coast", fmtPct(coastFrac)),
    summaryItem("Elapsed", fmtDur(elapsedS)),
    summaryItem("Moving", fmtDur(movingS)),
    summaryItem("Rest", fmtDur(Math.max(0, elapsedS - movingS))),
    summaryItem("Temp", fmtTempRange(tempAvg, tempMin, tempMax)),
    el(
      "div",
      { class: "pane-dn" },
      summaryDnRow("day", fmtDur(sum((s) => s.day_s))),
      summaryDnRow("twilight", fmtDur(sum((s) => s.twilight_s))),
      summaryDnRow("night", fmtDur(sum((s) => s.night_s))),
    ),
  );
}

function buildMapArea(mapWrap, summaryWrap, data, model) {
  let splits = []; // sorted ascending stop indices; [] = single-map mode
  let maps = [];

  const teardown = () => {
    closeMarkerMenu();
    for (const m of maps) m.remove();
    maps = [];
    clearMapPeers();
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
    const last = data.latlng.length - 1;
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
        if (m) maps.push(m);
      });
    }, 0);
  };

  render();
  return { destroy: teardown, toggleSplit };
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

// --- analysis view -----------------------------------------------------
// `refresh` is a one-shot: when true we ask the backend to re-fetch this ride's
// streams from Strava (costs an API call). It is deliberately NOT persisted to
// user-params and NOT carried in the URL hash — a reload or back-nav must reload
// from cache, never silently re-spend quota. The refresh button just re-invokes
// renderAnalysis with it set; the next route() drops back to refresh=false.
async function renderAnalysis(rideId, minStop, mergeWithinM, refresh = false) {
  saveUserParams({ minStop, mergeWithinM });
  // ---------------------
  // Loading
  root.innerHTML = "";
  root.appendChild(el("div", { class: "empty" }, refresh ? "Refreshing from Strava…" : "Loading…"));
  let data;
  try {
    const qs = new URLSearchParams({ min_stop: minStop, merge_within_m: mergeWithinM });
    if (refresh) qs.set("refresh", "true");
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
  // Re-fetch this ride's streams from Strava. unmountCurrentView() first so the
  // current map/listeners are torn down before the re-render replaces the DOM
  // (route() does this for hash navigations, but this is a direct re-invoke).
  const refreshBtn = el("button", {
    class: "icon refresh-btn",
    type: "button",
    title: "Refresh GPS data from Strava",
    "aria-label": "Refresh GPS data from Strava",
    onclick: () => {
      unmountCurrentView();
      renderAnalysis(rideId, minStop, mergeWithinM, true);
    },
  });
  root.appendChild(
    el(
      "h2",
      { class: "ride-title" },
      a.name || "(unnamed ride)",
      el("span", { class: "date" }, `(${(a.start_date_local || a.start_date || "").slice(0, 10)})`),
      refreshBtn,
    ),
  );

  // Strava attribution: link displayed data back to its source activity on
  // Strava. Combined rides expose their component ids as `combined:N,N,...`.
  const rawId = String(a.id || "");
  const sourceIds = rawId.startsWith("combined:")
    ? rawId.slice("combined:".length).split(",").filter(Boolean)
    : rawId
      ? [rawId]
      : [];
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
    root.appendChild(el("div", { class: "source-links" }, ...links));
  }

  root.appendChild(
    el(
      "div",
      { class: "summary" },
      summaryItem("Distance", `${(a.distance_m / 1000).toFixed(1)} km`),
      summaryItem("Climb", `${Math.round(a.total_elevation_gain_m || 0)} m`),
      summaryItem("Coast", fmtPct(a.coasting_frac)),
      summaryItem("Elapsed", fmtDur(a.elapsed_time_s)),
      el(
        "div",
        { class: "item" },
        el("span", { class: "label" }, "Moving:"),
        el("span", { class: "value" }, fmtDur(a.moving_time_s)),
        el(
          "div",
          { class: "breakdown" },
          summaryDnRow("day", fmtDur(a.moving_day_time_s)),
          summaryDnRow("twilight", fmtDur(a.moving_twilight_time_s)),
          summaryDnRow("night", fmtDur(a.moving_night_time_s)),
        ),
      ),
      summaryItem("Rest", fmtDur(a.elapsed_time_s - a.moving_time_s)),
      summaryItem("Temp", fmtTempRange(a.temp_avg_c, a.temp_min_c, a.temp_max_c)),
    ),
  );

  const model = buildTimelineModel(data.stops, data.segments);

  // ---------------------
  // Map
  const mapDiv = el("div", { id: "map" });
  const resizeHandle = el("div", { class: "map-resize-handle", title: "Drag to resize map" });
  const summariesDiv = el("div", { class: "pane-summaries" });
  root.appendChild(mapDiv);
  root.appendChild(resizeHandle);
  root.appendChild(summariesDiv);
  attachMapResizer(mapDiv, resizeHandle);
  mapArea = buildMapArea(mapDiv, summariesDiv, data, model);

  // ---------------------
  // Timeline / Tables — tabbed so only one shows at a time.
  const timelinePanel = renderTimeline(data.activity, data.stops, model);
  const tablesPanel = el(
    "div",
    { class: "tables-row" },
    el(
      "section",
      {},
      el("h2", {}, "Stops"),
      renderStopsTable(data.activity, data.stops, model, (i) => mapArea && mapArea.toggleSplit(i)),
    ),
    el("section", {}, el("h2", {}, "Segments"), renderSegmentsTable(data.segments)),
  );
  root.appendChild(
    buildSectionTabs([
      { label: "Tables", panel: tablesPanel },
      { label: "Timeline", panel: timelinePanel },
    ]),
  );
}

// --- routing ------------------------------------------------------------
function parseHash() {
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

function setHash(params) {
  window.location.hash = new URLSearchParams(params).toString();
}

// Persist app config (min_stop / merge_within_m) and re-render if the view in
// front of the user derives from it. These prefs live in localStorage, not the
// URL, so a change can't ride the hashchange event — the router refreshes
// explicitly. Only the analysis view consumes them; the list reads none, so
// it's left untouched (no needless re-fetch, transient merge-mode state kept).
// Keeping this here means the config dialog doesn't have to know which view is
// mounted or which fields matter.
function applyConfig(partial) {
  const before = parseHash();
  saveUserParams(partial);
  const after = parseHash();
  if (
    after.view === "analysis" &&
    (before.minStop !== after.minStop || before.mergeWithinM !== after.mergeWithinM)
  ) {
    route();
  }
}

function route() {
  unmountCurrentView();
  const r = parseHash();
  if (r.view === "analysis") renderAnalysis(r.rideId, r.minStop, r.mergeWithinM);
  else renderList(r.minDist);
}

// --- sign-in gate ------------------------------------------------------
// The whole app needs a Strava token. Check auth once at startup: render
// the sign-in screen when there's no token, otherwise wire up routing.
// The OAuth callback redirects back to "/", so a fresh load re-runs boot()
// and lands on the normal view once authenticated.
function renderSignIn(configured) {
  unmountCurrentView();
  root.innerHTML = "";
  const body = configured
    ? el(
        "div",
        { class: "signin" },
        el("p", {}, "Connect your Strava account to analyze your rides."),
        el(
          "a",
          { class: "strava-connect", href: "/auth/strava", "aria-label": "Connect with Strava" },
          el("img", {
            src: "/static/vendor/strava/btn_strava_connect_with_orange.svg",
            alt: "Connect with Strava",
            height: "48",
          }),
        ),
      )
    : el(
        "div",
        { class: "signin" },
        el("p", { class: "error" }, "Strava credentials are not configured."),
        el(
          "p",
          {},
          "Set ",
          el("code", {}, "STRAVA_CLIENT_ID"),
          " and ",
          el("code", {}, "STRAVA_CLIENT_SECRET"),
          " in ",
          el("code", {}, ".env"),
          ", then restart the server.",
        ),
      );
  root.appendChild(el("div", { class: "signin-wrap" }, body));
}

async function boot() {
  let status;
  try {
    status = await fetchJson("/api/auth/status");
  } catch {
    // If the status probe itself fails, fall through to normal routing so
    // the per-view error handling can surface what went wrong.
    status = { configured: true, authenticated: true };
  }
  if (!status.authenticated) {
    renderSignIn(status.configured);
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}

boot();

// --- config dialog ------------------------------------------------------
(function setupConfigDialog() {
  const dialog = document.getElementById("config-dialog");
  const form = document.getElementById("config-form");
  const minStopH = document.getElementById("cfg-min-stop-h");
  const minStopM = document.getElementById("cfg-min-stop-m");
  const minStopS = document.getElementById("cfg-min-stop-s");
  const mergeInput = document.getElementById("cfg-merge");

  const readMinStopSeconds = () =>
    (parseInt(minStopH.value, 10) || 0) * 3600 +
    (parseInt(minStopM.value, 10) || 0) * 60 +
    (parseInt(minStopS.value, 10) || 0);

  // Clear the custom invalid state as soon as a field changes; otherwise it
  // sticks and the browser blocks the next submit before our handler runs.
  for (const input of [minStopH, minStopM, minStopS]) {
    input.addEventListener("input", () => minStopS.setCustomValidity(""));
  }

  document.getElementById("config-btn").addEventListener("click", () => {
    const saved = loadUserParams();
    const { h, m, s } = secondsToHMS(
      minStopToSeconds(saved.minStop) ?? minStopToSeconds(DEFAULT_MIN_STOP),
    );
    minStopH.value = h;
    minStopM.value = m;
    minStopS.value = s;
    mergeInput.value = saved.mergeWithinM;
    dialog.showModal();
  });

  document.getElementById("cfg-cancel").addEventListener("click", () => dialog.close());

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const minStopSeconds = readMinStopSeconds();
    if (minStopSeconds <= MIN_STOP_FLOOR_S) {
      minStopS.setCustomValidity(`Min stop must be greater than ${MIN_STOP_FLOOR_S}s.`);
      minStopS.reportValidity();
      return;
    }
    minStopS.setCustomValidity("");
    const minStop = `${minStopSeconds}s`;
    const mergeWithinM = parseMergeWithin(mergeInput.value);

    dialog.close();
    // applyConfig persists the prefs and re-renders only if the current view
    // depends on them — the dialog stays oblivious to routing.
    applyConfig({ minStop, mergeWithinM });
  });
})();
