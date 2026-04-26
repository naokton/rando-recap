"""CLI entry point: ``ride analyze <activity_id>`` and ``ride login``."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import click
from dotenv import load_dotenv
from platformdirs import user_cache_dir, user_config_dir

from .cache import Cache
from .report import render_json, render_terminal
from .segments import build_segments
from .stops import detect_controls
from .strava import StravaClient, StravaScopeError

APP_NAME = "ride-analysis"


def _client() -> StravaClient:
    load_dotenv()
    client_id = os.environ.get("STRAVA_CLIENT_ID")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise click.ClickException(
            "STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not set. Copy .env.example to .env and fill them in."
        )
    cache = Cache(Path(user_cache_dir(APP_NAME)) / "cache.db")
    token_path = Path(user_config_dir(APP_NAME)) / "token.json"
    return StravaClient(client_id, client_secret, token_path, cache)


_DURATION_RE = re.compile(r"^(\d+)\s*(s|m|h)?$", re.IGNORECASE)


def _parse_duration(value: str) -> int:
    """Parse '5m', '300s', '90', '1h' → seconds."""
    m = _DURATION_RE.match(value.strip())
    if not m:
        raise click.BadParameter(f"unrecognized duration: {value!r}")
    n = int(m.group(1))
    unit = (m.group(2) or "m").lower()
    return n * {"s": 1, "m": 60, "h": 3600}[unit]


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
