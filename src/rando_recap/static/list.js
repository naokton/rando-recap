// The rides list and the Strava fetch progress view, plus the toolbar popovers
// (filter + fetch) they share. Each view returns { el, destroy }; each popover
// returns { el, close } so its owning view can dispose its document listener
// deterministically on teardown.
import { el, fetchJson } from "./utils.js";
import {
  loadUserParams,
  saveUserParams,
  parseMinDist,
  parseFetchSince,
  FETCH_WINDOWS,
  DEFAULT_MIN_DIST_KM,
} from "./prefs.js";
import { setHash, parseHash } from "./nav.js";
import * as ViewHost from "./viewhost.js";

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

  return { el: wrap, close };
}

// Toolbar popover that pulls activity summaries from Strava. Picking a window
// and submitting hands off to FetchView, which streams progress.
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
    // Same route, rebuilt: a re-render in place, not a navigation.
    ViewHost.show(FetchView(since));
  });

  return { el: wrap, close };
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
// list (so freshly fetched rides show). Aborts the stream on destroy.
export function FetchView(since) {
  const counts = el("div", { class: "fetch-counts" });
  const log = el("div", { class: "fetch-log" });
  const footer = el("div", { class: "fetch-footer" });
  const elRoot = el(
    "div",
    { class: "fetch-view" },
    el("h2", {}, "Fetching rides"),
    counts,
    log,
    footer,
  );

  const controller = new AbortController();

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
    // fresh ListView for that hash re-renders the (now repopulated) list — a
    // re-render in place, so it goes through ViewHost, not a hash navigation.
    footer.appendChild(
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => ViewHost.show(ListView(parseHash().minDist)),
        },
        "Back to rides",
      ),
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

  return { el: elRoot, destroy: () => controller.abort() };
}

export function ListView(minDist) {
  saveUserParams({ minDist });
  const elRoot = el("div", {}, el("div", { class: "empty" }, "Loading rides…"));
  // Popovers built during the fill; ListView.destroy closes each so an open
  // popover's document mousedown listener never outlives a navigation.
  const controls = [];

  fetchJson(`/api/rides?min_distance_km=${encodeURIComponent(minDist)}`)
    .then((data) => {
      if (!data.rides.length) {
        const message = data.total_cached
          ? `No rides match. ${data.total_cached} cached. Use “Fetch rides” to pull more from Strava, or lower the minimum distance.`
          : "No rides cached yet. Use “Fetch rides” to pull them from Strava.";
        const fetchControl = buildFetchControl();
        const filterControl = buildFilterControl(minDist);
        controls.push(fetchControl, filterControl);
        elRoot.replaceChildren(
          el("div", { class: "list-toolbar" }, fetchControl.el, filterControl.el),
          el("div", { class: "empty" }, message),
        );
        return;
      }

      let mergeMode = false;
      const selected = new Set();

      const toolbar = el("div", { class: "list-toolbar" });
      const filterControl = buildFilterControl(minDist);
      const fetchControl = buildFetchControl();
      controls.push(filterControl, fetchControl);
      const mergeControls = el("div", { class: "merge-controls" });
      toolbar.append(mergeControls, fetchControl.el, filterControl.el);
      const table = el("table", { class: "rides" });
      elRoot.replaceChildren(toolbar, table);

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
        filterControl.el.classList.toggle("hidden", mergeMode);
        fetchControl.el.classList.toggle("hidden", mergeMode);
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
    })
    .catch((e) =>
      elRoot.replaceChildren(el("div", { class: "error" }, `Failed to load rides: ${e.message}`)),
    );

  return {
    el: elRoot,
    destroy() {
      for (const c of controls) c.close();
    },
  };
}
