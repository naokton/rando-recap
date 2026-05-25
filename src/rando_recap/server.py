"""FastAPI HTTP server. Single-user — no auth."""

from __future__ import annotations

import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .app import (
    COMBINED_ID_PREFIX,
    ActivityNotCachedError,
    ConfigError,
    MissingStreamsError,
    analyze_activity,
    analyze_combined,
    client,
    list_summaries,
    parse_duration,
)
from .payload import build_payload
from .strava import StravaClient, StravaScopeError

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="rando-recap", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# The pending OAuth CSRF token, minted by /auth/strava and verified by the
# callback. A single value suffices for single-user local T3: only one login is
# ever in flight, and minting a new one supersedes any abandoned handshake. A
# server restart mid-login just means clicking "Sign in" again; persisted
# tokens (token.json) keep already-authenticated users signed in across restarts.
_pending_state: str | None = None


def _require_client() -> StravaClient:
    try:
        return client()
    except ConfigError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/api/auth/status")
def auth_status() -> dict[str, bool]:
    """Report whether Strava credentials are configured and a token is held."""
    try:
        c = client()
    except ConfigError:
        return {"configured": False, "authenticated": False}
    return {"configured": True, "authenticated": c.authenticated}


@app.get("/auth/strava", include_in_schema=False)
def auth_strava(request: Request) -> RedirectResponse:
    """Begin the OAuth flow: mint a state token and redirect to Strava."""
    global _pending_state
    c = _require_client()
    _pending_state = secrets.token_urlsafe(16)
    redirect_uri = str(request.url_for("auth_callback"))
    return RedirectResponse(c.authorize_url(redirect_uri, _pending_state), status_code=302)


@app.get("/auth/callback", include_in_schema=False)
def auth_callback(
    code: str = Query(...),
    state: str = Query(...),
) -> RedirectResponse:
    """Strava redirects here: validate state, exchange the code, save the token."""
    global _pending_state
    if _pending_state is None or state != _pending_state:
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state.")
    _pending_state = None
    c = _require_client()
    c.exchange_code(code)
    return RedirectResponse("/", status_code=302)


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
            {"id": sid, "datetime": s.datetime, "distance_km": s.distance_km, "name": s.name}
            for sid, s in rows
        ],
    }


def _parse_activity_id(activity_id: str) -> int | list[int]:
    """Single int id, or list of ints for ``combined:N,N,N`` form."""
    if activity_id.startswith(COMBINED_ID_PREFIX):
        raw = activity_id[len(COMBINED_ID_PREFIX) :]
        try:
            ids = [int(x) for x in raw.split(",") if x]
        except ValueError as e:
            raise HTTPException(
                status_code=400, detail=f"Invalid combined activity id: {activity_id!r}"
            ) from e
        if not ids:
            raise HTTPException(status_code=400, detail=f"Combined id has no activities: {activity_id!r}")
        return ids
    try:
        return int(activity_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid activity id: {activity_id!r}") from e


@app.get("/api/rides/{activity_id}/analysis")
def analyze_ride(
    activity_id: str,
    min_stop: str = Query("5m"),
    merge_within_m: float = Query(100.0, ge=0),
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
        raise HTTPException(status_code=401, detail="Not authenticated. Sign in with Strava first.")

    parsed = _parse_activity_id(activity_id)
    try:
        if isinstance(parsed, list):
            result = analyze_combined(
                c,
                parsed,
                min_stop_s=min_stop_s,
                merge_within_m=merge_within_m,
                refresh=refresh,
            )
        else:
            result = analyze_activity(
                c,
                parsed,
                min_stop_s=min_stop_s,
                merge_within_m=merge_within_m,
                refresh=refresh,
            )
    except ActivityNotCachedError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except MissingStreamsError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except StravaScopeError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return build_payload(result)
