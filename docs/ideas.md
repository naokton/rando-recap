# Rando Recap: Architecture & Product Direction

> Status: exploratory ideas document. Captures the thinking on how to evolve
> Rando Recap from a developer-only tool into something accessible to ordinary
> randonneurs, while preserving privacy.

## Context

Rando Recap currently fetches activity streams from Strava (GPS, HR, cadence,
power, altitude), detects stops (Garmin recording gaps), builds per-segment
stats, classifies day/night riding, and renders an interactive map + timeline +
tables in a local web UI. Setup requires ~8 steps including registering a Strava
developer app — inaccessible to non-technical users.

Goals:
- Reduce entry friction to near-zero for non-technical randonneurs
- Reach users who don't use Strava (any device that exports FIT)
- Support multi-day brevet reconstruction (a strong differentiator)
- Handle ride-log PII (GPS tracks = home address, HR) responsibly
- Maintain the OSS self-hosted path without special effort

Out of scope (considered and dropped): sharing without login, PWA, an "app
account without Strava" tier, browser extension (deferred), Pyodide (see below).

---

## User Tiers

### T1 — No login, no Strava (FIT files)
Visit the app. Drop one or more FIT files. Analysis runs **client-side in the
browser** and renders immediately: map, stop timeline, segment table, day/night
coloring. No account, no API credentials, no setup.

- **Ephemeral by default**: closing the tab clears everything.
- **Optional local persistence**: parsed analysis saved to browser IndexedDB so
  a ride list appears on return visits; settings via localStorage. Device-specific.
- **Multi-FIT stitching from day one**: drop all files for a multi-day brevet →
  one unified analysis. A genuine differentiator over Strava's native UI.
- FIT is universal: Garmin, Wahoo, Polar, Suunto, RideWithGPS — Strava user or not.

### T2 — Strava-connected
"Sign in with Strava" is the single entry point — Strava OAuth is both identity
and data source. Adds over T1:
- Full ride history synced from Strava, no manual FIT export
- FIT upload still available alongside Strava
- Multi-activity combination for brevets split across Strava uploads
- Named stops (custom checkpoint labels) and saved thresholds, server-stored for
  cross-device access

### T3 — Self-hosted (OSS)
The existing uv/Python/FastAPI path. Same application as T2 in single-user mode
(see Hosting Model and Self-Hosting below).

---

## Hosting Model: One Environment

T2 requires a server, so there is no need to host T1 separately. **One server
serves everything**; auth state determines the experience.

```
One server (FastAPI), ideally behind a CDN:
  ├── serves the static frontend (HTML/JS/CSS)   ← T1 and T2 both load this
  └── API routes (auth, stream relay, prefs)     ← only T2 calls these

Browser (single-page app):
  ├── not logged in → drag-drop FIT → JS analyze → render   (T1, no API calls)
  └── logged in     → Strava sync, ride list, named stops   (T2, uses API)
```

Crucial distinction: **"served by the server" ≠ "processed by the server."** T1's
FIT file is parsed and analyzed in the browser; it never reaches the server. The
server only hands over the app's static bytes.

- **CDN in front** caches all static assets at the edge → T1 is fast, cheap, and
  resilient (serves from cache even if the origin hiccups). T1 does zero
  server-side compute, so it costs almost nothing.
- This matches the *existing* codebase: `server.py` already serves `static/` via
  `StaticFiles` and exposes API routes. We extend that shape, not replace it.
- One origin → no CORS between frontend and API.

---

## Technical Stack Decisions

### Analysis: port to JS (not Pyodide)
The analysis is pure arithmetic on lists (stop gaps, segment means, coasting
counts; day/night needs solar calc). Porting to JS is straightforward —
`suncalc` replaces `astral`, the only non-trivial piece.

**Pyodide was considered and rejected.** It would let the Python analysis run
unchanged in the browser, but adds an ~8–10MB WASM runtime, 1–3s cold-start, a
required Web Worker, and a JS↔Python data bridge — a real point of failure and a
load-time hit, for a port that is easy anyway.

### The JS analysis module is the shared hosted implementation
Because T1 and T2 both analyze client-side, **one JS module serves both**:

```
T1: FIT file → fit_to_streams() → analyze() → render
T2: GET /api/streams/{id} → analyze() → render
                                ↑
                       same JS analyze() module
```

This dissolves the JS/Python drift worry for the hosted product: JS is the only
hosted implementation. Python's analysis survives only in T3 self-host. Keep the
two honest with **shared golden-test fixtures** (`input streams → expected
stops/segments/stretches`) that both implementations must pass in CI.

### Frontend: evolve vanilla JS, add a build step
The current 1,430-line no-build vanilla JS worked for pure rendering. The new
scope (FIT parser, analysis, IndexedDB, multi-file, Strava client) needs npm
imports and modules, so introduce a build step (Vite/esbuild). Stay
framework-free but modularized initially; reach for something small (Lit/Svelte/
Preact) only if component complexity demands it. Avoid React/Next as overkill.
The existing Leaflet map / timeline / table rendering code is reused as-is.

---

## T2 Architecture & Security

T2 is unavoidable server involvement, so security/privacy must be designed in.

### The hinge decision: who fetches streams from Strava?
**Decision: the server proxies the stream fetch (Option B), transiently.**

```
Browser → authenticated request: GET /api/streams/{id}
Server  → GET strava.com/api/v3/activities/{id}/streams (using stored token)
Server  → returns stream JSON to browser (in memory only, NOT stored)
Browser → runs JS analyze() → renders; optionally caches in IndexedDB
```

Rationale — stream sensitivity vs. token sensitivity: a stolen stream is one
ride's GPS track; a stolen `access_token` (read_all) exposes *every* activity and
the athlete profile. Keep the high-value token server-side and accept that
streams pass through server RAM transiently but are never stored. This is the
processor-not-storage pattern, scoped to T2 stream fetching only — T1 stays fully
client-side.

### What T2 stores, and how

| Data | On server? | Protection |
|---|---|---|
| Strava access + refresh tokens | Yes (required) | Encrypt at rest; key in env var, not DB |
| `client_secret` (app-level) | Yes (operator env) | Env var, never in source |
| Activity metadata (name, date, distance, sport_type) | Yes (fast list sync) | Encrypt at rest (cheap once infra exists) |
| Named stops (lat/lng + label) | Yes (cross-device) | Encrypt at rest — contains stop locations |
| User preferences | Yes | Standard |
| Raw streams (GPS, HR, etc.) | **No** — transient relay only | Never persisted |
| T1 analysis / streams | No (browser IndexedDB) | Stays on device |

### Security surface
- **Sessions**: HttpOnly + Secure + SameSite=Strict cookie holding a session ID.
  Inaccessible to JS, so XSS can't steal it. Avoid JWT-in-localStorage.
- **OAuth callback**: validate the `state` parameter (CSRF protection); auth code
  is one-time/short-lived; never log it.
- **TLS everywhere**, HSTS, no mixed content.
- **Breach blast radius (Option B)**: encrypted tokens (useless without the env
  key), activity metadata, named-stop coordinates. **Not exposed**: raw GPS
  tracks, HR, streams — they are never stored.

### Activity list — store server-side (decided)
`/api/v3/athlete/activities` is paginated, has no sport-type filter, and each
page costs one API call — expensive to scan every visit. Store the list
server-side: full scan once on first connect, delta sync (1–2 calls) thereafter.
Metadata only (no PII beyond name/date). Browsing the list needs no Strava call.

### Streams cache — browser IndexedDB (recommended)
After the browser fetches/relays streams once, cache them in IndexedDB keyed by
activity_id, mirroring the current local SQLite cache but on-device. Keeps PII
off the server and consistent with T1. A server-side stream cache (cross-device)
stays a deferred opt-in.

---

## Self-Hosting (T3)

T3 is the **same application as T2 in single-user mode** — same frontend, same
OAuth flow, same server code. Differences are bounded:

| | T2 (hosted) | T3 (self-host) |
|---|---|---|
| Users | Multi-user | Single user |
| Strava credentials | Operator's `client_id`/`client_secret` (shared for all users) | Self-hoster's own, in `.env` |
| Tokens | Encrypted in DB | Local token file (as today) |
| Sessions | HttpOnly cookie | Not needed |

The OAuth code path is identical; only the credential source differs (an env-var
distinction). The web "Sign in with Strava" button replaces the current CLI
`uv run app login` step — a small UX win for self-hosters.

**T3 still requires its own Strava app registration.** Because Strava has no PKCE,
`client_secret` cannot be safely distributed (embedding it in OSS source makes it
public and forgeable). So self-hosters cannot reuse the hosted app's credentials;
they register their own. This is the ceiling of what Strava's API allows for
self-hosted use.

Possible future: one codebase with a `single-user`/`multi-user` mode flag. Keep
in mind, don't commit now — risk is multi-user concerns (sessions, encryption,
isolation) leaking into the simple self-host path.

---

## Key Tensions

1. **Setup vs. privacy (T1).** Resolved by choosing static-served client-side
   analysis: zero setup *and* data-never-leaves-browser, at the cost of a JS port.
2. **Strava has no PKCE** (verified). Every token exchange and 6-hour refresh
   needs `client_secret`, so (a) hosted T2 needs a permanent server-side
   token/proxy layer, and (b) self-hosters must register their own app.
3. **JS/Python analysis drift.** Minimized: JS is the single hosted
   implementation (T1+T2); Python only in T3. Golden-test fixtures keep them honest.
4. **Shared rate limits (T2).** All T2 users share the app quota (1000 req/day).
   Server-side activity list + browser stream cache keep per-visit calls near zero.
5. **Strava ToS for public apps.** Formal review required; approval not
   guaranteed. T1 (FIT, no Strava) is a meaningful fallback.

---

## Implementation Order (Dependency-Respecting)

The JS analysis port is foundational. FIT parsing needs the Streams interface
from the port. The T2 server can be built in parallel but needs the frontend.

```
1. JS analysis port  ──  defines Streams interface
   │
   ├── 2. FIT parser (JS)
   │       └── 3. Multi-FIT stitch
   │               └── 4. T1 web UI (drag-drop, render) + build step
   │                       └── 5. Browser IndexedDB  ← T1 milestone (ship)
   │
   └── 6. T2 server: FastAPI auth + OAuth + sessions
           └── 7. Activity list sync (server, metadata only)
                   ├── 8. Stream relay endpoint (transient) + browser JS analysis
                   │       └── 9. Browser IndexedDB stream cache
                   │               └── 10. Multi-activity stitch (Strava)
                   └── 11. Per-user preferences + named stops (encrypted)
                                                          ← T2 milestone
```

### Phase 1 — JS analysis core (no UI yet)
1. Port `detect_stops`, `merge_nearby_stops` (`stops.py`) — pure arithmetic
2. Port `build_segments`, `coasting_frac` (`segments.py`)
3. Port `build_stretches` (`daynight.py`) — `astral` → `suncalc` (timezone care)
4. Define the `Streams` JS interface accepting
   `{time, latlng, distance, heartrate, cadence, watts, altitude}` — the seam
   where FIT and Strava both plug in
5. Golden-test fixtures from existing Python tests; both impls must pass

### Phase 2 — FIT ingestion
6. Integrate a JS FIT parser (`fit-parser` or `@garmin/fitsdk`)
7. `fit_to_streams(fitFile) → Streams`: timestamp → elapsed seconds, semicircle
   coords → decimal degrees (`÷ 2³¹/180`), missing `distance` → haversine fallback
8. `stitch([streams...]) → Streams`: concatenate with time offset; analogous to
   existing `combine_activities` in `app.py`

### Phase 3 — T1 web app + build step (first shippable milestone)
9. Introduce build step (Vite/esbuild); web app shell — drag-drop, ride list,
   analysis view
10. Wire FIT parse → analysis → render (reuse existing `app.js` rendering)
11. Browser IndexedDB — save/load analysis results and raw streams

### Phase 4 — T2 backend (can overlap Phases 2/3)
12. FastAPI auth layer: `/auth/strava`, `/callback` (state validation), session
    cookie (HttpOnly/Secure/SameSite), encrypted token storage
13. Serve the same static frontend; login unlocks T2 features

### Phase 5 — T2 data path
14. User identity from Strava athlete ID; no separate account creation
15. Activity list sync — full scan first connect, delta sync after; metadata only
16. Stream relay endpoint (transient, not stored); browser runs JS analysis +
    IndexedDB cache; multi-activity combination for brevet reconstruction

### Phase 6 — T2 personalization
17. Per-user preferences API (threshold/merge defaults)
18. Named stops — label a (lat, lng, time) stop; encrypted server-side; rendered

### Self-host alignment (T3)
- Reuse Phases 1–6 frontend + backend; run in single-user mode with the
  self-hoster's own Strava credentials and a local token file (current behavior).

---

## Critical Files (Current Codebase)

| File | Role | Disposition |
|---|---|---|
| `src/rando_recap/streams.py` | `Streams` typed accessor | JS port targets this interface (Phase 1) |
| `src/rando_recap/stops.py` | `detect_stops`, `merge_nearby_stops` | Port to JS (Phase 1) |
| `src/rando_recap/segments.py` | `build_segments`, `coasting_frac` | Port to JS (Phase 1) |
| `src/rando_recap/daynight.py` | `build_stretches` (uses `astral`) | Port with `suncalc` (Phase 1) |
| `src/rando_recap/app.py` | `_analyze_core`, `combine_activities` | Reference for porting |
| `src/rando_recap/strava.py` | OAuth flow, token management | Reference for T2 auth (Phase 4) |
| `src/rando_recap/static/app.js` | 1,430-line frontend SPA | Modularized + extended (Phase 3) |
| `src/rando_recap/server.py` | FastAPI: serves static + API | Base for one-environment hosting |

---

## Deferred

- **Pyodide**: rejected for now — bundle size, cold start, worker/bridge
  complexity, and an extra point of failure for an easy JS port.
- **Browser extension** (Sauce-for-Strava style): injects analysis into
  strava.com using the user's existing session — no API credentials, no shared
  rate limit. Elegant for Strava users, but bars: install friction, no mobile,
  tracking Strava's internal changes. Would reuse the Phase 1 JS module.
- **Server-side stream cache** (cross-device): opt-in if cross-device stream sync
  becomes a real need; otherwise browser IndexedDB only.
- **Single codebase mode flag** unifying T2/T3: revisit once both are stable.
