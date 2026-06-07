# Rando Recap

Ride recap for randonneurs: finds where and how long you stopped, splits the
route into segments between stops, and reports day/twilight/night riding time
and per-segment statistics. Stops are auto-detected from gaps in the recording.
Ride data comes from Strava activity streams.

Runs as a local web app: a FastAPI server with a Leaflet-based single-page UI
that renders a map, timeline, and tables of stops and segments, with
linked hover across all of them.

![Screenshot](imgs/image.jpg)

## Setup

1. Create a Strava API application: <https://www.strava.com/settings/api>
   Set "Authorization Callback Domain" to `localhost`.
2. Copy `.env.example` to `.env` and fill in `STRAVA_CLIENT_ID` and
   `STRAVA_CLIENT_SECRET`.
3. Install deps and start the server:

   ```bash
   uv sync
   uv run app serve
   ```

   Open <http://localhost:8000> and click **Sign in with Strava**; approve
   access. Use the `localhost` host (not `127.0.0.1`) so the OAuth callback
   matches the "Authorization Callback Domain" you registered above. The token
   is stored under your OS config dir
   (`~/Library/Application Support/rando-recap/token.json` on macOS) and
   refreshed automatically — sign-in is a one-time step that survives restarts.

## Web app

```bash
uv run app serve                       # http://localhost:8000
uv run app serve --host 0.0.0.0 --port 8080
uv run app serve --reload              # dev: auto-reload on code change
```

The landing page lists your cached rides, filtered by sport type and a minimum
distance. **Fetch rides** pulls activity summaries (see below), and **Stitch
rides** opens two or more selected rides as one combined analysis (see below).
Click any ride to open its analysis view: a map, a timeline, and tables of
stops and segments.

The analysis view classifies every point as day, twilight, or night (from
sunrise / sunset for the ride's location and date) and breaks down the time
each segment spends in each. The route polyline is colored by that
classification, alongside
stop markers and a segment timeline. Hovering any peer (table row, timeline bar, map element)
highlights the others. The ⟳ button by the title re-fetches that ride's
streams from Strava (one API call) — use it if you trimmed or fixed the GPS
track after it was cached.

Multi-day brevets often upload to Strava as separate per-day activities. Click
**Stitch rides**, select two or more, and **Open** to analyze them as one
synthetic ride — your activities stay separate; this only composes a view. The
parts are stitched in start-time order; the gaps between
them (overnight sleep, etc.) survive as real gaps in the time stream, so they
show up as stops just like any other.

The server is single-user with no auth; bind to `127.0.0.1` unless you know
what you're doing. On first run the list is empty — click **Fetch rides** to
populate the local cache.

### Fetch rides

The **Fetch rides** button walks your Strava history and stashes each
activity's summary metadata locally. Only the listing endpoint is hit (~1 call
per 200 activities, no per-ride detail call) — the summary already carries
every field the analysis needs; streams are fetched on demand when you open a
ride.

Pick a window (last week through all-time) and the fetch streams its progress
live. Summaries are always written, so a re-fetch picks up Strava-side edits
(renames, type/distance changes) — the progress log labels each ride **add**
(new) or **updated** (already cached). The listing endpoint returns the full
summary either way, so this costs no extra API calls. It respects Strava's rate
limits (sleeps near the 100-req / 15-minute cap, retries once on 429, aborts on
daily-limit exhaustion).

Filtering by sport type and minimum distance happens at list time, not at fetch
time, so you can change the threshold without re-fetching.

## CLI

```bash
uv run app analyze <activity_id>
uv run app analyze <activity_id> --min-stop 10m       # raise stop threshold
uv run app analyze <activity_id> --merge-within 200   # merge near stops (m); 0 disables
uv run app analyze <activity_id> --json               # structured output
uv run app analyze <activity_id> --refresh            # bypass local cache
```

`<activity_id>` is the integer at the end of a Strava activity URL.

The terminal report shows:

- **Stops** — clock time arriving / departing / dwell, with lat,lng.
- **Segments** — distance, time, avg km/h, avg HR, avg cadence, avg power,
  coasting %, climb (m), climb m/km. Within a segment elapsed time = moving
  time, since paused intervals only appear at stops.

### List cached rides

To see which rides are in the cache (and grab an id for `analyze`):

```bash
uv run app list                                   # ≥190 km, Ride/GravelRide
uv run app list --min-distance 200 --types Ride
```

## Caching

API responses are cached at `~/Library/Caches/rando-recap/cache.db`
(macOS) so re-runs and threshold tweaks don't re-hit Strava. Pass
`--refresh` on the CLI, or use the ⟳ button in the web app, to force a fetch.

## Development

Python (ruff + pyrefly + pytest) and JS (oxlint + oxfmt over the static
frontend) share one Makefile:

```bash
make format      # ruff + oxfmt
make lint        # ruff + oxlint
make typecheck   # pyrefly
uv run pytest
```

Requires Python ≥ 3.14. Frontend tooling installs via `npm install`
(devDependencies only — there's no JS build step; `static/` is served
as-is, and third-party assets like Leaflet are vendored under
`static/vendor/`).

## License

Source code is licensed under the MIT License (see [LICENSE](LICENSE)).

Third-party code vendored under `src/rando_recap/static/vendor/` is distributed
under its own license; the original license text is retained in a `LICENSE` file
within each subdirectory.

The MIT license does **not** apply to third-party trademarks or brand assets.
The Strava name, logos, and the "Powered by Strava" / "Connect with Strava"
marks (e.g. files under `src/rando_recap/static/vendor/strava/`) are trademarks
of Strava, Inc. They are included only for the attribution required by the
[Strava API Agreement](https://www.strava.com/legal/api) and are governed by
the Strava Brand Guidelines, not by this project's license.
