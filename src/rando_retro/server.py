"""FastAPI HTTP server. Single-user — no auth."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .app import (
    ActivityNotCachedError,
    ConfigError,
    MissingStreamsError,
    analyze_activity,
    client,
    list_summaries,
    parse_duration,
)
from .report import build_payload
from .strava import StravaScopeError

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="rando-retro", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/rides")
def list_rides(
    min_distance_km: float = Query(190.0, ge=0),
    types: str = Query("Ride,GravelRide"),
) -> dict[str, Any]:
    allowed = {s.strip() for s in types.split(",") if s.strip()}
    if not allowed:
        raise HTTPException(status_code=400, detail="`types` must list at least one sport_type")
    total, rows = list_summaries(allowed, min_distance_km * 1000)
    return {
        "total_cached": total,
        "rides": [
            {"id": sid, "date": s.date, "distance_km": s.distance_km, "name": s.name} for sid, s in rows
        ],
    }


@app.get("/api/rides/{activity_id}/analysis")
def analyze_ride(
    activity_id: int,
    min_stop: str = Query("5m"),
    refresh: bool = Query(False),
) -> dict[str, Any]:
    try:
        min_stop_s = parse_duration(min_stop)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        c = client()
    except ConfigError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    if not c.authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated. Run `ride login` first.")

    try:
        result = analyze_activity(c, activity_id, min_stop_s, refresh=refresh)
    except ActivityNotCachedError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except MissingStreamsError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except StravaScopeError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    payload = build_payload(result.activity, result.controls, result.segments)
    latlng = result.streams["latlng"]["data"]
    for seg in payload["segments"]:
        seg["polyline"] = latlng[seg["index_start"] : seg["index_end"] + 1]
    return payload
