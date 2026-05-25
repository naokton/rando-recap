"""CLI entry point: ``ride analyze <activity_id>``, ``ride list``, ``ride serve``.

Authentication and fetching activities are web-based: run ``ride serve``, click
"Sign in with Strava", then use the in-app "Fetch rides" button. The browser flow
writes the same token + cache the CLI commands read.
"""

from __future__ import annotations

import sys

import click

from .app import (
    ActivityNotCachedError,
    ConfigError,
    MissingStreamsError,
    analyze_activity,
    client,
    list_summaries,
    parse_duration,
)
from .payload import render_json
from .report import render_terminal
from .strava import StravaClient, StravaScopeError


def _client() -> StravaClient:
    try:
        return client()
    except ConfigError as e:
        raise click.ClickException(str(e)) from e


@click.group()
def main() -> None:
    """Randonneuring ride analysis from Strava."""


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
        raise click.ClickException("Not authenticated. Run `ride serve` and sign in with Strava first.")
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
