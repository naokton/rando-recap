"""Shared bootstrap helpers for the CLI and HTTP server."""

from __future__ import annotations

import functools
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from platformdirs import user_cache_dir, user_config_dir

from .cache import Cache
from .segments import Segment, build_segments
from .stops import Control, detect_controls
from .strava import StravaClient

APP_NAME = "ride-analysis"

load_dotenv()


class ConfigError(RuntimeError):
    """Raised when required configuration (e.g. Strava credentials) is missing."""


@functools.cache
def cache() -> Cache:
    return Cache(Path(user_cache_dir(APP_NAME)) / "cache.db")


@functools.cache
def client() -> StravaClient:
    client_id = os.environ.get("STRAVA_CLIENT_ID")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise ConfigError(
            "STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not set. "
            "Copy .env.example to .env and fill them in."
        )
    token_path = Path(user_config_dir(APP_NAME)) / "token.json"
    return StravaClient(client_id, client_secret, token_path, cache())


_DURATION_RE = re.compile(r"^(\d+)\s*(s|m|h)?$", re.IGNORECASE)


def parse_duration(value: str) -> int:
    """Parse '5m', '300s', '90', '1h' → seconds. Raises ValueError on bad input."""
    m = _DURATION_RE.match(value.strip())
    if not m:
        raise ValueError(f"unrecognized duration: {value!r}")
    n = int(m.group(1))
    unit = (m.group(2) or "m").lower()
    return n * {"s": 1, "m": 60, "h": 3600}[unit]


@dataclass(frozen=True)
class Summary:
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


def matches_filter(
    activity: dict[str, Any],
    allowed_types: set[str],
    min_distance_m: float,
) -> bool:
    """Local randonneuring-style filter; falls back to ``type`` for older activities."""
    sport = activity.get("sport_type") or activity.get("type")
    if sport not in allowed_types:
        return False
    return float(activity.get("distance") or 0) >= min_distance_m


def list_summaries(
    allowed_types: set[str], min_distance_m: float
) -> tuple[int, list[tuple[int, Summary]]]:
    """Return (total_cached, [(id, Summary)] sorted newest-first) for matching rides."""
    rows: list[tuple[int, Summary]] = []
    total = 0
    for sid, activity in cache().iter_kind("summary"):
        total += 1
        if not matches_filter(activity, allowed_types, min_distance_m):
            continue
        rows.append((sid, Summary.from_activity(activity)))
    rows.sort(key=lambda r: r[1].date, reverse=True)
    return total, rows


@dataclass(frozen=True)
class AnalysisResult:
    activity: dict[str, Any]
    streams: dict[str, Any]
    controls: list[Control]
    segments: list[Segment]


class ActivityNotCachedError(LookupError):
    """Activity id not present in the local summary cache."""


class MissingStreamsError(ValueError):
    """Activity is missing the ``time`` or ``latlng`` streams (no GPS)."""


def analyze_activity(
    sclient: StravaClient,
    activity_id: int,
    min_stop_s: int,
    *,
    refresh: bool,
) -> AnalysisResult:
    """Auth is the caller's job. Raises ActivityNotCachedError, MissingStreamsError, or StravaScopeError."""
    activity = sclient.cache.get("summary", activity_id)
    if activity is None:
        raise ActivityNotCachedError(
            f"Activity {activity_id} not in cache. Run `ride fetch` first."
        )
    streams = sclient.get_streams(activity_id, refresh=refresh)
    if "time" not in streams or "latlng" not in streams:
        raise MissingStreamsError(
            "Activity is missing 'time' or 'latlng' streams (no GPS?)."
        )
    controls = detect_controls(
        time_s=streams["time"]["data"],
        latlng=streams["latlng"]["data"],
        min_stop_s=min_stop_s,
    )
    segments = build_segments(streams, controls)
    return AnalysisResult(activity, streams, controls, segments)
