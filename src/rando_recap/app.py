"""Shared bootstrap helpers for the CLI and HTTP server."""

from __future__ import annotations

import functools
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from dotenv import load_dotenv
from platformdirs import user_cache_dir, user_config_dir

from .cache import Cache
from .daynight import State, Stretch, build_stretches, seconds_by_state
from .segments import Segment, build_segments, coasting_frac
from .stops import Stop, detect_stops, merge_nearby_stops
from .strava import StravaClient
from .streams import MissingStreamsError, Streams

if TYPE_CHECKING:
    from collections.abc import Iterator

APP_NAME = "rando-recap"

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
            "STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not set. Copy .env.example to .env and fill them in."
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


_SINCE_RE = re.compile(r"^(\d+)\s*([dwmy])$", re.IGNORECASE)
_SINCE_DAYS = {"d": 1, "w": 7, "m": 30, "y": 365}


def parse_since(value: str) -> int | None:
    """Parse '1m' / '6m' / '1y' / 'all' / 'YYYY-MM-DD' → epoch seconds (None for 'all').

    Raises ValueError on unrecognized input.
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
        raise ValueError(
            f"unrecognized since value: {value!r}. Use Nd/Nw/Nm/Ny (e.g. 1m, 6m, 1y), 'all', or YYYY-MM-DD."
        ) from e


@dataclass(frozen=True)
class Summary:
    datetime: str
    distance_km: float
    name: str

    @classmethod
    def from_activity(cls, activity: dict[str, Any]) -> Summary:
        return cls(
            datetime=activity.get("start_date_local") or activity.get("start_date") or "",
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


def list_summaries(allowed_types: set[str], min_distance_m: float) -> tuple[int, list[tuple[int, Summary]]]:
    """Return (total_cached, [(id, Summary)] sorted newest-first) for matching rides."""
    rows: list[tuple[int, Summary]] = []
    total = 0
    for sid, activity in cache().iter_kind("summary"):
        total += 1
        if not matches_filter(activity, allowed_types, min_distance_m):
            continue
        rows.append((sid, Summary.from_activity(activity)))
    rows.sort(key=lambda r: r[1].datetime, reverse=True)
    return total, rows


@dataclass(frozen=True)
class FetchProgress:
    """One activity processed by :func:`fetch_summaries`.

    ``action`` is ``"add"`` when the summary was newly cached or ``"updated"``
    when it was already present and overwritten with the fresh listing data.
    """

    action: str
    id: int
    datetime: str
    distance_km: float
    name: str


def fetch_summaries(
    sclient: StravaClient,
    after: int | None,
) -> Iterator[FetchProgress]:
    """Cache every activity summary newer than ``after`` (epoch seconds, None = all).

    Yields a :class:`FetchProgress` per activity as it goes so callers can stream
    progress. Filtering by distance/sport_type happens at list time, not here.
    Auth is the caller's job. Raises StravaScopeError / StravaRateLimitError.

    The listing endpoint already returns each activity's full summary, so caching
    it is free (no extra API call). We therefore always overwrite — keeping the
    cache faithful to Strava-side edits (renames, type/distance changes) — and use
    ``action`` only to label new vs refreshed rows for the progress log.
    """
    for activity in sclient.list_athlete_activities(after=after):
        sid = int(activity["id"])
        summary = Summary.from_activity(activity)
        action = "updated" if sclient.cache.has("summary", sid) else "add"
        sclient.cache.set("summary", sid, activity)
        yield FetchProgress(action, sid, summary.datetime, summary.distance_km, summary.name)


@dataclass(frozen=True)
class AnalysisResult:
    activity: dict[str, Any]
    streams: Streams
    stops: list[Stop]
    segments: list[Segment]
    daynight: list[Stretch]
    daynight_seconds: dict[State, int]
    coasting_frac: float | None


class ActivityNotCachedError(LookupError):
    """Activity id not present in the local summary cache."""


def _analyze_core(
    activity: dict[str, Any],
    streams: Streams,
    *,
    min_stop_s: int,
    merge_within_m: float,
) -> AnalysisResult:
    streams.require_gps()
    stops = detect_stops(
        time_s=streams.time,
        latlng=streams.latlng,
        min_stop_s=min_stop_s,
    )
    stops = merge_nearby_stops(
        stops,
        distance_m=streams.distance,
        merge_within_m=merge_within_m,
    )
    daynight = build_stretches(
        streams,
        activity_start_iso=activity.get("start_date") or activity.get("start_date_local") or "",
        utc_offset_s=int(activity.get("utc_offset") or 0),
    )
    segments = build_segments(streams, stops, daynight)
    daynight_seconds = seconds_by_state(streams.time, daynight)
    cadence = streams.cadence
    ride_coasting = coasting_frac(cadence, 0, len(cadence) - 1) if cadence else None
    return AnalysisResult(activity, streams, stops, segments, daynight, daynight_seconds, ride_coasting)


def analyze_activity(
    sclient: StravaClient,
    activity_id: int,
    *,
    min_stop_s: int,
    merge_within_m: float,
    refresh: bool,
) -> AnalysisResult:
    """Auth is the caller's job. Raises ActivityNotCachedError, MissingStreamsError, or StravaScopeError."""
    activity = sclient.cache.get("summary", activity_id)
    if activity is None:
        raise ActivityNotCachedError(f"Activity {activity_id} not in cache. Run `ride fetch` first.")
    streams = Streams(sclient.get_streams(activity_id, refresh=refresh))
    return _analyze_core(activity, streams, min_stop_s=min_stop_s, merge_within_m=merge_within_m)


# --- combined activities -----------------------------------------------------
# Multi-day brevets often appear in Strava as separate per-day uploads. We
# stitch them into one synthetic activity so the analysis pipeline sees a
# single ride. Inter-activity gaps (e.g. overnight sleep) are preserved as
# real time-stream gaps, which detect_stops picks up as stops.

COMBINED_ID_PREFIX = "combined:"

_PASSTHROUGH_STREAM_KEYS = ("latlng", "altitude", "heartrate", "cadence", "watts")


def combine_activities(
    parts: list[tuple[dict[str, Any], dict[str, Any]]],
) -> tuple[dict[str, Any], Streams]:
    """Stitch (activity, streams) pairs into one synthetic pair, sorted by start time.

    `time` is offset by each part's start relative to the first part's start;
    `distance` is offset by the previous part's cumulative end; other streams
    are concatenated as-is.
    """
    if not parts:
        raise ValueError("combine_activities: no parts given")
    parts = sorted(parts, key=lambda p: p[0].get("start_date") or "")
    first_act = parts[0][0]
    first_start = datetime.fromisoformat(first_act["start_date"])

    combined: dict[str, dict[str, Any]] = {}
    distance_offset = 0.0

    def _append(key: str, src: dict[str, Any], values: list[Any]) -> None:
        bucket = combined.get(key)
        if bucket is None:
            bucket = {
                "type": src.get("type", key),
                "series_type": src.get("series_type"),
                "resolution": src.get("resolution"),
                "data": [],
            }
            combined[key] = bucket
        bucket["data"].extend(values)
        bucket["original_size"] = len(bucket["data"])

    for activity, streams in parts:
        if "time" not in streams or "latlng" not in streams:
            raise MissingStreamsError(
                f"Activity {activity.get('id')} is missing 'time' or 'latlng' streams (no GPS?).",
            )
        time_offset_s = int((datetime.fromisoformat(activity["start_date"]) - first_start).total_seconds())
        _append("time", streams["time"], (t + time_offset_s for t in streams["time"]["data"]))
        if "distance" in streams:
            data = streams["distance"]["data"]
            _append("distance", streams["distance"], (d + distance_offset for d in data))
            if data:
                distance_offset += data[-1]
        for key in _PASSTHROUGH_STREAM_KEYS:
            if key in streams:
                _append(key, streams[key], streams[key]["data"])

    last_act = parts[-1][0]
    last_start = first_start if len(parts) == 1 else datetime.fromisoformat(last_act["start_date"])
    elapsed_combined = int(
        (last_start - first_start).total_seconds() + int(last_act.get("elapsed_time") or 0)
    )
    ids = [str(a.get("id")) for a, _ in parts]
    name = first_act.get("name", "(combined)")
    if len(parts) > 1:
        name = f"{name} + {len(parts) - 1} more"
    activity = {
        "id": COMBINED_ID_PREFIX + ",".join(ids),
        "name": name,
        "start_date": first_act.get("start_date"),
        "start_date_local": first_act.get("start_date_local"),
        "utc_offset": first_act.get("utc_offset", 0),
        "sport_type": first_act.get("sport_type") or first_act.get("type"),
        "type": first_act.get("type"),
        "distance": sum(float(a.get("distance") or 0) for a, _ in parts),
        "elapsed_time": elapsed_combined,
        "moving_time": sum(int(a.get("moving_time") or 0) for a, _ in parts),
        "total_elevation_gain": sum(float(a.get("total_elevation_gain") or 0) for a, _ in parts),
    }
    return activity, Streams(combined)


def analyze_combined(
    sclient: StravaClient,
    activity_ids: list[int],
    *,
    min_stop_s: int,
    merge_within_m: float,
    refresh: bool,
) -> AnalysisResult:
    if not activity_ids:
        raise ValueError("analyze_combined: at least one activity id required")
    parts: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for aid in activity_ids:
        act = sclient.cache.get("summary", aid)
        if act is None:
            raise ActivityNotCachedError(f"Activity {aid} not in cache. Run `ride fetch` first.")
        streams = sclient.get_streams(aid, refresh=refresh)
        parts.append((act, streams))
    activity, streams = combine_activities(parts)
    return _analyze_core(activity, streams, min_stop_s=min_stop_s, merge_within_m=merge_within_m)
