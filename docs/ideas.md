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
- Preserve privacy: GPS tracks are maximally sensitive PII
- Reach users who don't use Strava (any device that exports FIT)
- Support multi-day brevet reconstruction (a strong differentiator)
- Maintain the OSS self-hosted path without special effort

Out of scope (considered and dropped): sharing without login (no merit), PWA
(not widely used), an "app account without Strava" tier (low merit), browser
extension (interesting; deferred — bar of install + tracking Strava's internal
changes).

---

## User Tiers

### T1 — No login, no Strava (FIT files)
Visit the web app. Drop one or more FIT files. Analysis renders immediately:
map, stop timeline, segment table, day/night coloring. No account, no extension
install, no API credentials, no setup.

- **Ephemeral by default**: closing the tab clears everything.
- **Optional local persistence**: parsed analysis is saved to browser IndexedDB
  so a ride list appears on return visits; settings persist via localStorage.
  This is device-specific and lost if browser data is cleared — honest for a
  no-account tier.
- **Multi-FIT stitching from day one**: drop all files for a 4-day brevet at
  once → one unified analysis. A genuine differentiator over Strava's native UI.
- FIT is the universal format here: works for Garmin, Wahoo, Polar, Suunto,
  RideWithGPS — anyone, Strava user or not.

### T2 — Strava-connected
Strava OAuth is both the login and the data-source connection — one flow, not
two. "Sign in with Strava" is the single entry point.

Adds over T1:
- Full ride history synced from Strava, no manual FIT export
- FIT upload still available alongside Strava (non-Strava rides, borrowed
  device, partial uploads)
- Multi-activity combination for brevets split across Strava uploads (existing
  `combine_activities` logic, ported)
- Named stops (custom checkpoint labels) and saved thresholds, stored
  server-side for cross-device access

### T3 — Self-hosted (OSS)
The existing uv/Python/FastAPI path, maintained as a natural consequence of the
project being open source. No special effort required. For technical users who
want total control.

---

## T2 Server-Side Storage Design

### Activity list — store server-side (decided)
The Strava `/api/v3/athlete/activities` endpoint is paginated (~200/page), has
no sport-type filter, and each page costs one API call. A cyclist with years of
history needs many calls just to build the ride list, every visit. Server-side
storage means a full scan once on first connect, then delta sync (1–2 calls) on
later visits. The ride list renders instantly.

Stored per activity (metadata only, no PII beyond name/date): `activity_id`,
`name`, `start_date`, `sport_type`, `distance`, `elapsed_time`, `moving_time`,
`utc_offset`, `total_elevation_gain`.

### Streams — design decision pending
Raw streams (GPS, HR, cadence, power, altitude) are the PII core. Where to cache
them after the first Strava fetch:

| Option | Streams live | Privacy | Cross-device | Complexity |
|---|---|---|---|---|
| **A: Browser IndexedDB** | Browser cache by activity_id | Best — PII never on server | No | Low |
| **B: Server-side cache** | Server DB, encrypted | Worst — GPS/HR on server | Yes | High (GDPR, breach) |
| **C: Analysis results only** | Server DB (stops/segments) | Moderate — stop locations still sensitive | Partial | Medium |
| **D: No cache** | Always fetch from Strava | Best | N/A | Lowest, but burns quota |

**Recommended: Option A.** It mirrors what the current Python app does (local
SQLite cache) but moved into the browser. Clean split:

| Data | Storage | Rationale |
|---|---|---|
| Activity metadata list | Server DB (per user) | Fast delta sync; no PII |
| Strava tokens | Server DB (encrypted) | Must be server-side; Strava has no PKCE |
| User preferences, named stops | Server DB (per user) | Cross-device; no PII |
| Raw streams (GPS, HR, etc.) | Browser IndexedDB | PII; consistent with T1 |
| Analysis results (T1) | Browser IndexedDB | No account; stays local |

If cross-device stream sync later proves worth the tradeoff, Option B can be
added as opt-in without restructuring anything else.

---

## Key Tensions

1. **Setup vs. privacy.** Zero-setup hosted paths put a server in the data flow.
   The activity-list-server / streams-browser split is the best mitigation.
2. **Strava has no PKCE** (verified against current docs). Every token exchange
   and 6-hour refresh requires the `client_secret`, so a server-side proxy is
   mandatory and permanent for any hosted Strava integration — it holds the
   secret and brokers all token operations. No secret can ship to a client.
3. **Shared rate limits.** All T2 users share the app-level Strava quota
   (1000 req/day). Server-side activity list + browser-side stream caching keep
   per-visit API calls near zero after the initial sync.
4. **Strava ToS for public apps.** Formal review required; approval not
   guaranteed. FIT support (T1) is a meaningful fallback independent of Strava.

---

## Implementation Order (Dependency-Respecting)

The JS analysis port is foundational to everything browser-side. FIT parsing
needs the Streams interface from the analysis port. The Strava proxy can be
built in parallel but needs a frontend to be useful.

```
1. JS analysis port  ──  defines Streams interface
   │
   ├── 2. FIT parser (JS)
   │       └── 3. Multi-FIT stitch
   │               └── 4. T1 web UI (drag-drop, render)
   │                       └── 5. Browser IndexedDB  ← T1 milestone
   │
   └── 6. Strava OAuth proxy (parallel track)
           └── 7. Server: user DB + activity list sync
                   ├── 8. Browser: Strava stream fetch + JS analysis
                   │       └── 9. Browser IndexedDB: stream cache
                   │               └── 10. Multi-activity stitch (Strava)
                   └── 11. Per-user preferences + named stops  ← T2 milestone
```

### Phase 1 — JS analysis core (no UI yet)
1. Port `detect_stops`, `merge_nearby_stops` (`stops.py`) — pure arithmetic
2. Port `build_segments`, `coasting_frac` (`segments.py`)
3. Port `build_stretches` (`daynight.py`) — replace `astral` with `suncalc`;
   the only non-trivial piece (timezone handling)
4. Define the `Streams` JS interface accepting
   `{time, latlng, distance, heartrate, cadence, watts, altitude}` — the seam
   where FIT and Strava both plug in
5. JS tests using existing Python test fixtures as the reference oracle

### Phase 2 — FIT ingestion
6. Integrate a JS FIT parser (`fit-parser` or `@garmin/fitsdk`)
7. `fit_to_streams(fitFile) → Streams`: timestamp → elapsed seconds, semicircle
   coords → decimal degrees (`÷ 2³¹/180`), missing `distance` → haversine fallback
8. `stitch([streams...]) → Streams`: concatenate with time offset; analogous to
   existing `combine_activities` in `app.py`

### Phase 3 — T1 web app (first shippable milestone)
9. Web app shell — drag-drop, ride list, analysis view
10. Wire FIT parse → analysis → render (existing `app.js` is most of this)
11. Browser IndexedDB — save/load analysis results and raw streams

### Phase 4 — Strava proxy (can overlap Phases 2/3)
12. Serverless OAuth proxy (e.g. Cloudflare Worker) — `/callback` (code
    exchange) and `/refresh`, both using server-held `client_secret`; stateless
    re: user data
13. Browser Strava client — `fetchStreams(activityId, token) → Streams`

### Phase 5 — T2 server
14. User identity from Strava athlete ID; no separate account creation
15. Activity list sync — full scan first connect, delta sync after; metadata only
16. Browser-side analysis with Strava streams + IndexedDB cache; multi-activity
    combination for brevet reconstruction

### Phase 6 — T2 personalization
17. Per-user preferences API (threshold/merge defaults)
18. Named stops — label a (lat, lng, time) stop; stored server-side; rendered in UI

---

## Critical Files (Current Codebase)

| File | Role | Disposition |
|---|---|---|
| `src/rando_recap/streams.py` | `Streams` typed accessor | JS port targets this interface (Phase 1) |
| `src/rando_recap/stops.py` | `detect_stops`, `merge_nearby_stops` | Port to JS (Phase 1) |
| `src/rando_recap/segments.py` | `build_segments`, `coasting_frac` | Port to JS (Phase 1) |
| `src/rando_recap/daynight.py` | `build_stretches` (uses `astral`) | Port with `suncalc` (Phase 1) |
| `src/rando_recap/app.py` | `_analyze_core`, `combine_activities` | Reference for porting |
| `src/rando_recap/strava.py` | OAuth flow, token management | Reference for proxy (Phase 4) |
| `src/rando_recap/static/app.js` | 1,430-line frontend SPA | Extended in Phase 3 |
| `src/rando_recap/server.py` | FastAPI layer | Remains for T3 self-hosted |

---

## Deferred

- **Browser extension** (Sauce-for-Strava style): injects analysis into
  strava.com using the user's existing session — no API credentials, no shared
  rate limit. Elegant for Strava users, but bars: install friction, no mobile,
  and tracking Strava's internal page/API changes. Reuses the Phase 1 JS module
  when revisited.
- **Server-side stream cache** (Option B): add as opt-in if cross-device stream
  sync becomes a real need.
