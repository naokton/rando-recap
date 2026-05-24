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
account without Strava" tier, browser extension (deferred), Pyodide.

---

## User Tiers

### T1 — No login, no Strava (FIT files)
Visit the app. Drop one or more FIT files. The server parses and analyzes them
(Python, transient — nothing stored) and returns the result. Analysis renders:
map, stop timeline, segment table, day/night coloring. No account, no API
credentials, no setup.

- **Ephemeral**: the server discards the uploaded data after responding. The
  rendered result lives in the browser tab only.
- **Multi-FIT stitching**: drop all files for a multi-day brevet → one unified
  analysis. A genuine differentiator over Strava's native UI.
- FIT is universal: Garmin, Wahoo, Polar, Suunto, RideWithGPS — Strava user or not.

### T2 — Strava-connected (logged in)
"Sign in with Strava" is the single entry point — Strava OAuth is both identity
and data source.

Adds over T1:
- Full ride history synced from Strava; no manual FIT export
- FIT upload still available alongside Strava
- Multi-activity combination for brevets split across Strava uploads
- Everything persisted server-side: streams (cached), activity list, named stops,
  preferences — available cross-device

### T3 — Self-hosted (OSS)
The existing uv/Python/FastAPI path. Same application as T2 in single-user mode
(see Self-Hosting below). Maintained as a natural consequence of being open source.

---

## Hosting Model: One Environment

T2 requires a server, so T1 is served from the same host. **One server serves
everything**; auth state determines the experience.

```
One server (FastAPI), ideally behind a CDN:
  ├── serves the static frontend (HTML/JS/CSS)
  └── API routes (auth, FIT upload, stream fetch, analysis, prefs)

Browser (single-page app):
  ├── not logged in → drag-drop FIT → POST to server → render result   (T1)
  └── logged in     → Strava sync, ride list, named stops, history     (T2)
```

- **CDN in front** caches static assets at the edge; fast even when the origin
  is slow. Only API calls (T1 upload, T2 data) pass through to the origin.
- This extends the *existing* codebase shape: `server.py` already serves
  `static/` via `StaticFiles` and exposes API routes.
- One origin → no CORS between frontend and API.

---

## Technical Stack Decisions

### Analysis: Python server-side (JS port deferred)
Analysis stays in Python on the server — the existing `stops.py`, `segments.py`,
`daynight.py`, and `app.py` run unchanged. This means one authoritative
implementation, no drift, and no port needed now. The JS port is an **optional
future step** (Phase 5), worth revisiting at public launch for server-cost
reduction and offline capability. Until then, Python carries all tiers.

**Pyodide was considered and rejected**: ~8–10MB WASM runtime, 1–3s cold-start,
required Web Worker, and a JS↔Python bridge — real points of failure for an easy
eventual port.

### Frontend: TypeScript + `deno transpile` (no framework)
Migrate the existing vanilla JS to TypeScript. Use `deno transpile` to strip
types and emit plain JS into `static/`; FastAPI serves it as today.

- **Why `deno transpile` over Vite**: no bundling needed yet — Leaflet loads from
  CDN as today, and the frontend's role is rendering only (no analysis, no FIT
  parsing). `deno transpile` is zero-config, no node_modules, and Deno's built-in
  fmt/lint/test could consolidate or replace the current oxlint/oxfmt setup.
- **No framework for now**: the existing rendering code (Leaflet map, timeline,
  tables) ports cleanly to typed modules. Reach for a small component framework
  (Lit/Svelte/Preact) only if component complexity demands it during T2 UI work.
- **Revisit bundling** (esbuild-via-Deno or Vite) if the JS port (Phase 5) adds
  significant npm dependencies (FIT parser, suncalc). Not needed until then.

---

## Server-Side Storage (T2)

The server is the custodian of all user data for logged-in users. Since PII
reaches the server regardless (Strava tokens, activity metadata), simplicity
wins: **store everything server-side, encrypted at rest**.

| Data | Stored? | Protection |
|---|---|---|
| Strava access + refresh tokens | Yes | Encrypt at rest; key in env var, not DB |
| `client_secret` (app-level) | Env var only | Never in source or DB |
| Activity metadata (name, date, distance, sport_type) | Yes | Encrypt at rest |
| Raw streams (GPS, HR, cadence, power, altitude) | Yes — cached | Encrypt at rest |
| Named stops (lat/lng + label) | Yes | Encrypt at rest — contains stop locations |
| User preferences | Yes | Standard |
| T1 uploads (anonymous) | **No — transient only** | Discarded after response |

Caching streams server-side mirrors what the current self-hosted app does (local
SQLite cache) and keeps Strava API calls low on repeat visits. The tradeoff:
**the breach blast radius now includes raw GPS and HR data**. Mitigated by
encryption at rest; revisit client-side stream caching (browser IndexedDB) at
public launch as an opt-in privacy upgrade.

---

## T2 Security

### Data flow
```
Browser → GET /api/activities          (server returns cached list; no Strava call)
Browser → GET /api/analysis/{id}       (server fetches streams from Strava if not
                                        cached, runs Python analysis, caches streams,
                                        returns analysis JSON)
Browser → renders analysis result
```

### Security surface
- **Sessions**: HttpOnly + Secure + SameSite=Strict cookie holding a session ID.
  Inaccessible to JS; XSS cannot steal it. Avoid JWT-in-localStorage.
- **OAuth callback**: validate the `state` parameter (CSRF); auth code is
  one-time/short-lived; never log it.
- **Token storage**: Strava tokens encrypted at rest in DB. Key lives in an
  environment variable, not in source or DB. Breach of the DB alone is
  insufficient to use the tokens.
- **TLS everywhere**, HSTS, no mixed content.
- **Encryption at rest**: apply to tokens, streams, named stops, activity
  metadata from day one — cheap to do up front, expensive to retrofit.

### Activity list sync
`/api/v3/athlete/activities` is paginated (~200/page), has no sport-type filter;
each page costs one API call. Store server-side: full scan on first connect,
delta sync (1–2 calls) on subsequent visits. Browsing the ride list needs no
Strava call.

---

## Self-Hosting (T3)

T3 is the **same application as T2 in single-user mode**. Differences are
bounded to configuration:

| | T2 (hosted) | T3 (self-host) |
|---|---|---|
| Users | Multi-user | Single user |
| Strava credentials | Operator's `client_id`/`client_secret` | Own `.env` (as today) |
| Token storage | Encrypted in DB | Local token file (as today) |
| Sessions | HttpOnly cookie | Not needed |

The web "Sign in with Strava" button replaces the current `uv run app login` CLI
step — same OAuth flow, better UX.

**T3 still requires its own Strava app registration**: Strava has no PKCE, so
`client_secret` cannot be distributed safely. Self-hosters register their own
app. This is the ceiling of what Strava's API allows for self-hosted use.

Future option: a single codebase with a `SINGLE_USER=true` mode flag that
disables sessions, encryption, and multi-tenancy. Defer until T2 and T3 are
both stable.

---

## Key Tensions

1. **One Python implementation, no drift**: analysis stays Python server-side
   across T1, T2, and T3. JS port is optional and deferred.
2. **Strava has no PKCE** (verified). Every token exchange and 6-hour refresh
   requires `client_secret`, so the server must hold it and broker all token
   operations. Self-hosters must register their own app.
3. **Streams stored server-side** — larger breach radius than a transient-only
   design. Mitigated by encryption at rest. Revisit browser-side stream caching
   at public launch as a privacy upgrade.
4. **Shared rate limits (T2)**: all users share the app quota (1000 req/day).
   Server-side stream cache keeps repeat-visit API calls near zero.
5. **Strava ToS for public apps**: formal review required; approval not
   guaranteed. FIT support (T1) is a meaningful fallback independent of Strava.

---

## Implementation Order

```
Phase 1: T3 web login
  └── Phase 2: FIT support (T3)
        └── Phase 3: T2 multi-user
              └── Phase 4: T1 no-login UI
                    └── Phase 5: JS port (OPTIONAL)
```

### Phase 1 — T3 web login
Replace `uv run app login` with a web-based OAuth flow. FastAPI routes:
`/auth/strava` (redirect to Strava), `/auth/callback` (exchange code, validate
`state`, write local token file). Frontend: "Sign in with Strava" button. Token
stored as today (local JSON file). All existing analysis and serving unchanged.

### Phase 2 — FIT support (server-side, T3)
Add `fitdecode` (pure Python) as a dependency. Implement:
- `fit_to_streams(path) → Streams` in Python: FIT record messages → Streams
  shape (timestamp → elapsed seconds, semicircle coords → decimal degrees,
  haversine fallback if `distance` field absent)
- Multi-FIT stitch via existing `combine_activities` logic
- `POST /api/analyze-fit` endpoint: accept one or more FIT uploads, parse,
  stitch if multiple, run analysis, return JSON, discard uploads

Frontend: drag-drop target, file input, POST to `/api/analyze-fit`, render
result via existing analysis renderer.

### Phase 3 — T2 multi-user (hosted)
- User DB (SQLite with `user_id`): users, sessions, encrypted tokens, activity
  metadata, streams cache, named stops, preferences
- Session management: HttpOnly cookie, session ID → user record
- Strava token encryption at rest (AES-256, key from env)
- Activity list sync (full on first login, delta on subsequent)
- `GET /api/analysis/{id}`: fetch streams from Strava (or cache), run Python
  analysis, cache streams, return JSON
- Named stops + preferences API
- Multi-activity combination for brevet reconstruction

### Phase 4 — T1 no-login UI
Anonymous users can reach the app and use FIT upload without signing in. The
server processes FIT transiently (no storage). Reuses the Phase 2
`/api/analyze-fit` endpoint as-is. The main work is frontend: show the FIT
upload UI to unauthenticated users, gate Strava features behind login prompt.

### Phase 5 — JS analysis port (OPTIONAL, deferred)
Port `stops.py`, `segments.py`, `daynight.py` to JS/TS (`suncalc` replaces
`astral`). Move analysis client-side. Benefits: reduces server compute, enables
offline/static T1, provides provable-privacy option. Revisit at public launch.
If built: add golden-test fixtures (Python test cases reused as reference) and
introduce bundling (esbuild-via-Deno or Vite) for npm deps (FIT parser, suncalc).

---

## Critical Files (Current Codebase)

| File | Role | Disposition |
|---|---|---|
| `src/rando_recap/streams.py` | `Streams` typed accessor | Reference for Phase 2 FIT conversion |
| `src/rando_recap/stops.py` | `detect_stops`, `merge_nearby_stops` | Unchanged through Phase 4; Phase 5 port |
| `src/rando_recap/segments.py` | `build_segments`, `coasting_frac` | Unchanged through Phase 4; Phase 5 port |
| `src/rando_recap/daynight.py` | `build_stretches` (uses `astral`) | Unchanged through Phase 4; Phase 5 port |
| `src/rando_recap/app.py` | `_analyze_core`, `combine_activities` | Core pipeline; extended for FIT in Phase 2 |
| `src/rando_recap/strava.py` | OAuth flow, token management | Extended for web-based flow in Phase 1 |
| `src/rando_recap/static/app.js` | 1,430-line frontend SPA | Migrated to TS; modularized across phases |
| `src/rando_recap/server.py` | FastAPI: serves static + API | Base for all phases |
| `src/rando_recap/cache.py` | SQLite caching layer | Extended for multi-user in Phase 3 |

---

## Deferred

- **JS analysis port** (Phase 5): optional optimization for server-cost
  reduction and offline capability; revisit at public launch.
- **Browser extension** (Sauce-for-Strava style): injects analysis into
  strava.com using the user's existing session. Elegant but bars: install
  friction, no mobile, tracking Strava's internal changes. Would reuse Phase 5
  JS module if built.
- **Client-side stream cache** (browser IndexedDB): privacy upgrade option —
  streams stay on-device rather than server. Deferred until public launch;
  add as opt-in if user demand warrants it.
- **Single-codebase T2/T3 mode flag**: `SINGLE_USER=true` to simplify self-host
  setup. Deferred until both T2 and T3 are stable.
- **Bundling** (esbuild-via-Deno or Vite): not needed until Phase 5 adds
  significant npm dependencies. `deno transpile` is sufficient until then.
