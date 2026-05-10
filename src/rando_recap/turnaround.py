"""Turnaround detection for out-and-back rides.

Picks the GPS sample farthest from the start, snapping to a nearby control
when one is within :data:`SNAP_TO_CONTROL_M` so the split aligns with the
control list. Returns ``None`` for routes that don't look out-and-back
(end is far from start) — splitting those produces lopsided halves.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import asin, cos, radians, sin, sqrt
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .stops import Control

# End must return to within this fraction of the farthest distance for the
# route to count as out-and-back. 0.25 admits typical brevets (start == end,
# ratio ≈ 0) and rejects point-to-point rides.
OUT_AND_BACK_END_RATIO = 0.25

SNAP_TO_CONTROL_M = 1000.0

_EARTH_RADIUS_M = 6_371_000.0


@dataclass(frozen=True)
class Turnaround:
    index_before: int
    index_after: int
    """Equals ``index_before`` when not snapped to a control (single GPS point)."""
    control_idx: int | None


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    d_lat = radians(lat2 - lat1)
    d_lng = radians(lng2 - lng1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lng / 2) ** 2
    return 2 * _EARTH_RADIUS_M * asin(sqrt(a))


def detect_turnaround(
    latlng: list[list[float]],
    controls: list[Control],
) -> Turnaround | None:
    if not latlng or len(latlng) < 2:
        return None
    lat0, lng0 = latlng[0]

    farthest_idx = 0
    farthest_dist = 0.0
    for i in range(1, len(latlng)):
        lat, lng = latlng[i]
        d = _haversine_m(lat0, lng0, lat, lng)
        if d > farthest_dist:
            farthest_dist = d
            farthest_idx = i

    lat_end, lng_end = latlng[-1]
    end_dist = _haversine_m(lat0, lng0, lat_end, lng_end)
    if end_dist >= OUT_AND_BACK_END_RATIO * farthest_dist:
        return None

    lat_f, lng_f = latlng[farthest_idx]
    snap_idx: int | None = None
    snap_dist = SNAP_TO_CONTROL_M
    for k, c in enumerate(controls):
        d = _haversine_m(lat_f, lng_f, c.lat, c.lng)
        if d < snap_dist:
            snap_dist = d
            snap_idx = k

    if snap_idx is not None:
        c = controls[snap_idx]
        return Turnaround(index_before=c.index_before, index_after=c.index_after, control_idx=snap_idx)
    return Turnaround(index_before=farthest_idx, index_after=farthest_idx, control_idx=None)
