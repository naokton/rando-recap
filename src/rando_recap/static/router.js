// The composition root: dispatches hash routes to views through the ViewHost,
// applies config changes, wires the settings dialog and linked-hover delegation,
// and boots the app. Nothing imports this module except the entry point — views
// reach the host and nav directly, so the graph stays a pure DAG.
import { root, fetchJson } from "./utils.js";
import {
  saveUserParams,
  loadUserParams,
  parseMergeWithin,
  minStopToSeconds,
  secondsToHMS,
  DEFAULT_MIN_STOP,
  MIN_STOP_FLOOR_S,
} from "./prefs.js";
import { parseHash } from "./nav.js";
import * as ViewHost from "./viewhost.js";
import { wireHover } from "./hover.js";
import { ListView } from "./list.js";
import { AnalysisView } from "./analysis.js";
import { SignInView } from "./signin.js";

// Dispatch the current hash to a view. Invoked from boot()'s initial dispatch,
// the hashchange listener, and applyConfig — never from inside a view.
function route() {
  const r = parseHash();
  if (r.view === "analysis") ViewHost.show(AnalysisView(r.rideId, r.minStop, r.mergeWithinM));
  else ViewHost.show(ListView(r.minDist));
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

// --- config dialog ------------------------------------------------------
function setupConfigDialog() {
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
}

// The whole app needs a Strava token. Check auth once at startup: render the
// sign-in screen when there's no token, otherwise wire up routing. The OAuth
// callback redirects back to "/", so a fresh load re-runs boot() and lands on
// the normal view once authenticated.
export async function boot() {
  // wireHover and the config dialog must be wired before the unauthenticated
  // early-return: the header's settings button (#config-btn) lives outside #root
  // and is present on the sign-in screen too, and the hover delegation lives on
  // the persistent #root. Both are wiring-only — no side effects until a view
  // populates the DOM they delegate over.
  wireHover(root);
  setupConfigDialog();

  let status;
  try {
    status = await fetchJson("/api/auth/status");
  } catch {
    // If the status probe itself fails, fall through to normal routing so
    // the per-view error handling can surface what went wrong.
    status = { configured: true, authenticated: true };
  }
  if (!status.authenticated) {
    ViewHost.show(SignInView(status.configured));
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}
