"""CLI entry point: ``ride analyze <activity_id>`` and ``ride login``."""

from __future__ import annotations

import re
import sys
from datetime import datetime, timedelta

import click

from .app import (
    ActivityNotCachedError,
    ConfigError,
    MissingStreamsError,
    Summary,
    analyze_activity,
    client,
    list_summaries,
    parse_duration,
)
from .payload import render_json
from .report import render_terminal
from .strava import StravaClient, StravaRateLimitError, StravaScopeError


def _client() -> StravaClient:
    try:
        return client()
    except ConfigError as e:
        raise click.ClickException(str(e)) from e


_SINCE_RE = re.compile(r"^(\d+)\s*([dwmy])$", re.IGNORECASE)
_SINCE_DAYS = {"d": 1, "w": 7, "m": 30, "y": 365}


def _parse_since(value: str) -> int | None:
    """Parse '1m' / '6m' / '1y' / 'all' / 'YYYY-MM-DD' → epoch seconds (or None for 'all')."""
    raw = value.strip()
    if raw.lower() == "all":
        return None
    m = _SINCE_RE.match(raw)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        delta = timedelta(days=n * _SINCE_DAYS[unit])
        return int((datetime.now() - delta).timestamp())
    try:
        return int(datetime.strptime(raw, "%Y-%m-%d").timestamp())
    except ValueError as e:
        raise click.BadParameter(
            f"unrecognized --since value: {value!r}. Use Nd/Nw/Nm/Ny (e.g. 1m, 6m, 1y), 'all', or YYYY-MM-DD."
        ) from e


@click.group()
def main() -> None:
    """Randonneuring ride analysis from Strava."""


@main.command()
def login() -> None:
    """One-time Strava OAuth flow. Opens a browser tab."""
    sclient = _client()
    sclient.login()
    click.echo("Logged in. Token saved.")


@main.command()
@click.argument("activity_id", type=int)
@click.option(
    "--min-stop",
    default="5m",
    show_default=True,
    help="Stops at least this long are detected. e.g. 5m, 300s, 1h.",
)
@click.option(
    "--merge-within",
    "merge_within_m",
    type=float,
    default=100.0,
    show_default=True,
    help="Adjacent stops within this path distance (meters) are merged. 0 disables.",
)
@click.option("--refresh", is_flag=True, help="Re-fetch streams even if cached.")
@click.option(
    "--json",
    "json_out",
    is_flag=True,
    help="Emit structured JSON instead of the terminal report.",
)
def analyze(
    activity_id: int,
    min_stop: str,
    merge_within_m: float,
    refresh: bool,
    json_out: bool,
) -> None:
    """Analyze one cached activity and print per-stop / per-segment stats."""
    sclient = _client()
    if not sclient.authenticated:
        raise click.ClickException("Not authenticated. Run `ride login` first.")
    try:
        min_stop_s = parse_duration(min_stop)
    except ValueError as e:
        raise click.BadParameter(str(e)) from e

    try:
        result = analyze_activity(
            sclient,
            activity_id,
            min_stop_s=min_stop_s,
            merge_within_m=merge_within_m,
            refresh=refresh,
        )
    except (ActivityNotCachedError, MissingStreamsError, StravaScopeError) as e:
        raise click.ClickException(str(e)) from e

    if json_out:
        sys.stdout.write(render_json(result))
        sys.stdout.write("\n")
    else:
        render_terminal(result.activity, result.stops, result.segments, result.coasting_frac)


@main.command()
@click.option(
    "--since",
    default="1m",
    show_default=True,
    help="Window: Nd/Nw/Nm/Ny (e.g. 1m, 6m, 1y), 'all', or YYYY-MM-DD.",
)
@click.option("--refresh", is_flag=True, help="Overwrite cached summaries even if already present.")
def fetch(since: str, refresh: bool) -> None:
    """Cache every activity summary in --since window. Filtering happens at list time."""
    sclient = _client()
    if not sclient.authenticated:
        raise click.ClickException("Not authenticated. Run `ride login` first.")

    after = _parse_since(since)
    seen = added = skipped_cached = 0
    try:
        for activity in sclient.list_athlete_activities(after=after):
            seen += 1
            sid = int(activity["id"])
            summary = Summary.from_activity(activity)
            label = f"{summary.datetime[:10]}  {summary.distance_km:6.1f} km  {summary.name}"
            if not refresh and sclient.cache.has("summary", sid):
                skipped_cached += 1
                click.echo(f"  cached  {label}")
                continue
            click.echo(f"  add     {label}")
            sclient.cache.set("summary", sid, activity)
            added += 1
    except (StravaScopeError, StravaRateLimitError) as e:
        raise click.ClickException(str(e)) from e

    click.echo(f"\nDone. seen={seen}  added={added}  skipped(cached)={skipped_cached}")


@main.command(name="list")
@click.option(
    "--min-distance",
    "min_distance_km",
    type=float,
    default=190.0,
    show_default=True,
    help="Minimum ride distance in km. Use 0 to disable.",
)
@click.option(
    "--types",
    "sport_types",
    default="Ride,GravelRide",
    show_default=True,
    help="Comma-separated Strava sport_type values to include.",
)
def list_rides(min_distance_km: float, sport_types: str) -> None:
    """List cached rides, filtered locally by distance and sport_type."""
    allowed = {s.strip() for s in sport_types.split(",") if s.strip()}
    if not allowed:
        raise click.BadParameter("--types must list at least one sport_type")
    total, rows = list_summaries(allowed, min_distance_km * 1000)
    for sid, s in rows:
        click.echo(f"{sid:>12}  {s.datetime[:10]}  {s.distance_km:6.1f} km  {s.name}")
    click.echo(f"\n{len(rows)} of {total} cached match.")


@main.command()
@click.option("--host", default="127.0.0.1", show_default=True, help="Bind address.")
@click.option("--port", default=8000, show_default=True, help="Listen port.")
@click.option("--reload", is_flag=True, help="Auto-reload on code change (dev).")
def serve(host: str, port: int, reload: bool) -> None:
    """Run the local web UI + JSON API."""
    import uvicorn

    uvicorn.run("rando_recap.server:app", host=host, port=port, reload=reload)
