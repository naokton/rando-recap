# Rando Retro (Randonneuring Retrospective)

Per-control and per-segment analysis of randonneuring rides, from Strava
activity streams. Controls are auto-detected from gaps in the recording (your
Garmin pauses at stops, leaving gaps in the time stream).

## Setup

1. Create a Strava API application: <https://www.strava.com/settings/api>
   Set "Authorization Callback Domain" to `localhost`.
2. Copy `.env.example` to `.env` and fill in `STRAVA_CLIENT_ID` and
   `STRAVA_CLIENT_SECRET`.
3. Install deps and authenticate:

   ```bash
   uv sync
   uv run ride login
   ```

   A browser tab opens; approve access. The token is stored under your OS
   config dir (`~/Library/Application Support/rando-retro/token.json` on
   macOS) and refreshed automatically.

## Usage

```bash
uv run ride analyze <activity_id>
uv run ride analyze <activity_id> --min-stop 10m   # raise control threshold
uv run ride analyze <activity_id> --json           # structured output
uv run ride analyze <activity_id> --refresh        # bypass local cache
```

`<activity_id>` is the integer at the end of a Strava activity URL.

### Bulk-cache rides

`ride fetch` walks your Strava history, filters down to randonneuring rides
(by `sport_type` and minimum distance), and stashes each match's summary
metadata locally. Only the listing endpoint is hit (~1 call per 200
activities, no per-ride detail call) — the summary already carries every
field `analyze` needs. Streams are still fetched on demand by `analyze`.

```bash
uv run ride fetch                          # last month, ≥190 km, Ride/GravelRide
uv run ride fetch --since all              # first-time full sync
uv run ride fetch --since 6m --min-distance 200
```

`--since` accepts `Nd` / `Nw` / `Nm` / `Ny` (days/weeks/months/years), `all`,
or a `YYYY-MM-DD` date. The command is idempotent — already-cached rides are
skipped — and respects Strava's rate limits (sleeps near the 100-req /
15-minute cap, retries once on 429, aborts on daily-limit exhaustion).

To see which rides are in the cache (and grab an id for `analyze`):

```bash
uv run ride list
```

The terminal report shows:

- **Controls** — clock time arriving / departing / dwell, with lat,lng.
- **Segments** — distance, time, avg km/h, avg HR, avg cadence, avg power,
  climb (m), climb m/km. Within a segment elapsed time = moving time, since
  paused intervals only appear at controls.

## Caching

API responses are cached at `~/Library/Caches/rando-retro/cache.db`
(macOS) so re-runs and threshold tweaks don't re-hit Strava. Pass
`--refresh` to force a fetch.

## Roadmap

Planned for later iterations (not built yet):

- Stop-time *suggestions* — surface all candidate stops with sliders, let
  the user accept/reject which count as controls.
- Map-based manual control selection.
- Smoothed climb metric (drop GPS noise via altitude hysteresis).
- Multi-ride comparison (year-over-year, pace decay across distances).

## Development

```bash
uv run pytest
```
