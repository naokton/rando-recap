// The auth gate. The whole app needs a Strava token; boot() shows this view
// when there is none. Stateless and built once at boot, so its destroy is a
// no-op — it exists as its own view for uniformity under the { el, destroy }
// contract.
import { el } from "./utils.js";

export function SignInView(configured) {
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
  return {
    el: el("div", { class: "signin-wrap" }, body),
    destroy() {},
  };
}
