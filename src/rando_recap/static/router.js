// The composition root: dispatches hash routes to views through the ViewHost,
// applies config changes, wires the settings dialog and linked-hover delegation,
// and boots the app. Nothing imports this module except the entry point — views
// reach the host and nav directly, so the graph stays a pure DAG.
import { root, fetchJson } from "./utils.js";
import { saveUserParams } from "./prefs.js";
import { parseHash } from "./url.js";
import * as ViewHost from "./view-host.js";
import { wireHover } from "./linked-hover.js";
import { ListView } from "./rides-view.js";
import { AnalysisView } from "./analysis-view.js";
import { SignInView } from "./signin-view.js";
import { mountConfig } from "./settings.js";

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

// The whole app needs a Strava token. Check auth once at startup: render the
// sign-in screen when there's no token, otherwise wire up routing. The OAuth
// callback redirects back to "/", so a fresh load re-runs boot() and lands on
// the normal view once authenticated.
export async function boot() {
  // Hover delegation lives on the persistent #root and is wiring-only (no side
  // effects until a view populates the DOM it delegates over), so it's wired
  // before the unauthenticated early-return.
  wireHover(root);

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
  // Settings are only meaningful once authenticated, so the button + dialog are
  // built and inserted here rather than living in the static shell — the
  // sign-in screen carries no settings UI. applyConfig is passed in so settings.js
  // stays oblivious to routing.
  mountConfig(applyConfig);
  window.addEventListener("hashchange", route);
  route();
}
