"""Domain → JSON DTO mapping for the HTTP API and ``--json`` CLI output.

Kept separate from ``report.py`` (the rich terminal renderer) so the web
server doesn't transitively depend on the terminal-presentation stack.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .app import AnalysisResult


def build_payload(result: AnalysisResult, *, include_latlng: bool = True) -> dict[str, Any]:
    activity = result.activity
    daynight_s = result.daynight_seconds
    payload: dict[str, Any] = {
        "activity": {
            "id": activity.get("id"),
            "name": activity.get("name"),
            "start_date": activity.get("start_date"),
            "start_date_local": activity.get("start_date_local"),
            "utc_offset_s": int(activity.get("utc_offset") or 0),
            "distance_m": activity.get("distance"),
            "elapsed_time_s": activity.get("elapsed_time"),
            "moving_time_s": activity.get("moving_time"),
            "moving_day_time_s": daynight_s["day"],
            "moving_twilight_time_s": daynight_s["twilight"],
            "moving_night_time_s": daynight_s["night"],
            "coasting_frac": result.coasting_frac,
            "total_elevation_gain_m": activity.get("total_elevation_gain"),
        },
        "stops": [{**asdict(c), "rest_s": c.rest_s} for c in result.stops],
        "segments": [asdict(s) for s in result.segments],
        "daynight": [asdict(s) for s in result.daynight],
    }
    if include_latlng:
        payload["latlng"] = result.streams["latlng"]["data"]
    return payload


def render_json(result: AnalysisResult) -> str:
    return json.dumps(build_payload(result, include_latlng=False), indent=2)
