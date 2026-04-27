"""CLI entry point: ``ride analyze <activity_id>`` and ``ride login``."""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import click
from dotenv import load_dotenv
from platformdirs import user_cache_dir, user_config_dir

from .cache import Cache
from .report import render_json, render_terminal
from .segments import build_segments
from .stops import detect_controls
from .strava import StravaClient, StravaRateLimitError, StravaScopeError

APP_NAME = "ride-analysis"


def _cache() -> Cache:
    return Cache(Path(user_cache_dir(APP_NAME)) / "cache.db")


def _client() -> StravaClient:
    load_dotenv()
    client_id = os.environ.get("STRAVA_CLIENT_ID")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise click.ClickException(
            "STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not set. Copy .env.example to .env and fill them in."
        )
    token_path = Path(user_config_dir(APP_NAME)) / "token.json"
    return StravaClient(client_id, client_secret, token_path, _cache())


@dataclass(frozen=True)
class Summary:
    """Compact view of a Strava activity used by the fetch and list commands."""

    date: str
    distance_km: float
    name: str

    @classmethod
    def from_activity(cls, activity: dict[str, Any]) -> Summary:
        return cls(
            date=(activity.get("start_date_local") or activity.get("start_date") or "")[:10],
            distance_km=float(activity.get("distance") or 0) / 1000,
            name=activity.get("name", ""),
        )


_DURATION_RE = re.compile(r"^(\d+)\s*(s|m|h)?$", re.IGNORECASE)


def _parse_duration(value: str) -> int:
    """Parse '5m', '300s', '90', '1h' → seconds."""
    m = _DURATION_RE.match(value.strip())
    if not m:
        raise click.BadParameter(f"unrecognized duration: {value!r}")
    n = int(m.group(1))
    unit = (m.group(2) or "m").lower()
    return n * {"s": 1, "m": 60, "h": 3600}[unit]


_SINCE_RE = re.compile(r"^(\d+)\s*([dwmy])$", re.IGNORECASE)
_SINCE_DAYS = {"d": 1, "w": 7, "m": 30, "y": 365}


def _parse_since(value: str) -> int | None:
    """Parse '1m' / '6m' / '1y' / 'all' / 'YYYY-MM-DD' → epoch seconds (or None for 'all').

    The unit letters here (d/w/m/y) are days/weeks/months/years — distinct from
    `_parse_duration` where 'm' means minutes.
    """
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


def _matches_filter(
    activity: dict[str, Any],
    allowed_types: set[str],
    min_distance_m: float,
) -> bool:
    """Local filter for randonneuring-style rides.

    Uses ``sport_type`` (newer field) and falls back to ``type`` for older
    activities that pre-date the sport_type split.
    """
    sport = activity.get("sport_type") or activity.get("type")
    if sport not in allowed_types:
        return False
    return float(activity.get("distance") or 0) >= min_distance_m


@click.group()
def main() -> None:
    """Randonneuring ride analysis from Strava."""


@main.command()
def login() -> None:
    """One-time Strava OAuth flow. Opens a browser tab."""
    client = _client()
    client.login()
    click.echo("Logged in. Token saved.")


@main.command()
@click.argument("activity_id", type=int)
@click.option(
    "--min-stop",
    default="5m",
    show_default=True,
    help="Stops at least this long are treated as controls. e.g. 5m, 300s, 1h.",
)
@click.option("--refresh", is_flag=True, help="Bypass the cache and re-fetch.")
@click.option(
    "--json",
    "json_out",
    is_flag=True,
    help="Emit structured JSON instead of the terminal report.",
)
def analyze(
    activity_id: int,
    min_stop: str,
    refresh: bool,
    json_out: bool,
) -> None:
    """Analyze one Strava activity and print per-control / per-segment stats."""
    client = _client()
    if not client.authenticated:
        raise click.ClickException("Not authenticated. Run `ride login` first.")
    min_stop_s = _parse_duration(min_stop)

    try:
        activity = client.get_activity(activity_id, refresh=refresh)
        streams = client.get_streams(activity_id, refresh=refresh)
    except StravaScopeError as e:
        raise click.ClickException(str(e)) from e

    if "time" not in streams or "latlng" not in streams:
        raise click.ClickException("Activity is missing 'time' or 'latlng' streams (no GPS?).")

    controls = detect_controls(
        time_s=streams["time"]["data"],
        latlng=streams["latlng"]["data"],
        min_stop_s=min_stop_s,
    )
    segments = build_segments(streams, controls)

    if json_out:
        sys.stdout.write(render_json(activity, controls, segments))
        sys.stdout.write("\n")
    else:
        render_terminal(activity, controls, segments)


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
    client = _client()
    if not client.authenticated:
        raise click.ClickException("Not authenticated. Run `ride login` first.")

    after = _parse_since(since)
    seen = added = skipped_cached = 0
    try:
        for activity in client.list_athlete_activities(after=after):
            seen += 1
            sid = int(activity["id"])
            summary = Summary.from_activity(activity)
            label = f"{summary.date}  {summary.distance_km:6.1f} km  {summary.name}"
            if not refresh and client.cache.has("summary", sid):
                skipped_cached += 1
                click.echo(f"  cached  {label}")
                continue
            click.echo(f"  add     {label}")
            client.cache.set("summary", sid, activity)
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
    min_distance_m = min_distance_km * 1000

    total = 0
    rows: list[tuple[int, Summary]] = []
    for sid, activity in _cache().iter_kind("summary"):
        total += 1
        if not _matches_filter(activity, allowed, min_distance_m):
            continue
        rows.append((sid, Summary.from_activity(activity)))
    rows.sort(key=lambda r: r[1].date, reverse=True)
    for sid, s in rows:
        click.echo(f"{sid:>12}  {s.date}  {s.distance_km:6.1f} km  {s.name}")
    click.echo(f"\n{len(rows)} of {total} cached match.")
