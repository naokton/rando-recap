// The settings button + dialog (min_stop / merge_within_m), built in JS and
// inserted into the page chrome. mountConfig() is called from boot() only once
// the user is authenticated, so the sign-in screen never carries settings UI —
// the elements simply don't exist there. Closing over the created nodes also
// frees this from getElementById lookups; the ids that remain exist only for
// <label for> associations and the selectors style.css targets.
import { el } from "./utils.js";
import {
  loadUserParams,
  parseMergeWithin,
  minStopToSeconds,
  secondsToHMS,
  DEFAULT_MIN_STOP,
  MIN_STOP_FLOOR_S,
} from "./prefs.js";

// Build the button and dialog, wire them, and insert them into <header>/<body>.
// onApply is the router's applyConfig: it persists the prefs and re-renders the
// current view if it depends on them, so this module stays oblivious to routing.
//
// This self-appends rather than returning the { el, destroy } the views use.
// That contract is for swappable views ViewHost mounts inside #root and tears
// down on every navigation; the settings button + dialog are persistent chrome
// that must outlive those swaps, so they live outside #root (as they did when
// they were static markup) and are never destroyed — a destroy() hook would be
// dead code with no caller.
export function mountConfig(onApply) {
  const minStopH = el("input", {
    id: "cfg-min-stop-h",
    type: "number",
    min: "0",
    step: "1",
  });
  const minStopM = el("input", {
    type: "number",
    min: "0",
    max: "59",
    step: "1",
  });
  const minStopS = el("input", {
    type: "number",
    min: "0",
    max: "59",
    step: "1",
  });
  const mergeInput = el("input", {
    id: "cfg-merge",
    type: "number",
    min: "0",
    step: "10",
  });

  const readMinStopSeconds = () =>
    (parseInt(minStopH.value, 10) || 0) * 3600 +
    (parseInt(minStopM.value, 10) || 0) * 60 +
    (parseInt(minStopS.value, 10) || 0);

  // Clear the custom invalid state as soon as a field changes; otherwise it
  // sticks and the browser blocks the next submit before our handler runs.
  for (const input of [minStopH, minStopM, minStopS]) {
    input.addEventListener("input", () => minStopS.setCustomValidity(""));
  }

  const form = el(
    "form",
    {
      method: "dialog",
      onsubmit: (e) => {
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
        onApply({ minStop, mergeWithinM });
      },
    },
    el("div", { class: "dlg-header" }, el("h2", {}, "Settings")),
    el(
      "div",
      { class: "dlg-body" },
      el(
        "div",
        { class: "field" },
        el("label", { for: "cfg-min-stop-h" }, "Min stop"),
        el(
          "div",
          { class: "hms" },
          minStopH,
          el("span", { class: "unit" }, "h"),
          minStopM,
          el("span", { class: "unit" }, "m"),
          minStopS,
          el("span", { class: "unit" }, "s"),
        ),
      ),
      el(
        "div",
        { class: "field" },
        el("label", { for: "cfg-merge" }, "Merge stops within"),
        mergeInput,
        el("span", { class: "unit" }, "m"),
      ),
    ),
    el(
      "div",
      { class: "dlg-footer" },
      el("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"),
      el("button", { type: "submit", class: "btn primary" }, "Apply"),
    ),
  );

  const dialog = el("dialog", { id: "config-dialog" }, form);

  const btn = el("button", {
    class: "config-btn icon",
    title: "Settings",
    "aria-label": "Settings",
    onclick: () => {
      const saved = loadUserParams();
      const { h, m, s } = secondsToHMS(
        minStopToSeconds(saved.minStop) ?? minStopToSeconds(DEFAULT_MIN_STOP),
      );
      minStopH.value = h;
      minStopM.value = m;
      minStopS.value = s;
      mergeInput.value = saved.mergeWithinM;
      dialog.showModal();
    },
  });

  document.querySelector("header").append(btn);
  document.body.append(dialog);
}
