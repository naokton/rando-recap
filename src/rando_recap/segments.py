"""Per-segment statistics between detected controls.

A "segment" is a contiguous portion of the ride between two controls (or
between the start/end and the nearest control). Within a segment there are
no recording gaps, so elapsed time = moving time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .stops import Control


@dataclass
class Segment:
    label: str
    """e.g. "Start → C1", "C1 → C2", "C3 → End"."""
    index_start: int
    index_end: int
    distance_m: float
    duration_s: int
    avg_speed_mps: float | None
    avg_hr: float | None
    avg_cadence: float | None
    avg_watts: float | None
    climb_m: float
    climb_m_per_km: float | None


def _slice_mean(values: list | None, lo: int, hi: int) -> float | None:
    """Mean of values[lo:hi+1], skipping None/missing. Returns None if empty."""
    if values is None:
        return None
    nums = [v for v in values[lo : hi + 1] if v is not None]
    if not nums:
        return None
    return sum(nums) / len(nums)


def _climb_sum(altitude: list[float] | None, lo: int, hi: int) -> float:
    """Raw sum of positive altitude deltas across the slice."""
    if altitude is None or hi <= lo:
        return 0.0
    total = 0.0
    prev = altitude[lo]
    for v in altitude[lo + 1 : hi + 1]:
        if v is None or prev is None:
            prev = v
            continue
        delta = v - prev
        if delta > 0:
            total += delta
        prev = v
    return total


def build_segments(
    streams: dict[str, dict],
    controls: list[Control],
) -> list[Segment]:
    """Build ordered segments from streams keyed by type (Strava ``key_by_type=true``)."""
    time_s: list[int] = streams["time"]["data"]
    distance: list[float] = streams["distance"]["data"]
    altitude = streams.get("altitude", {}).get("data")
    hr = streams.get("heartrate", {}).get("data")
    cad = streams.get("cadence", {}).get("data")
    watts = streams.get("watts", {}).get("data")

    n = len(time_s)
    if n == 0:
        return []
    last = n - 1

    # Split points: (label_from, index_start, index_end)
    boundaries: list[tuple[str, int, int]] = []
    prev_label = "Start"
    prev_idx = 0
    for i, c in enumerate(controls, start=1):
        boundaries.append((f"{prev_label} → C{i}", prev_idx, c.index_before))
        prev_label = f"C{i}"
        prev_idx = c.index_after
    boundaries.append((f"{prev_label} → End", prev_idx, last))

    segments: list[Segment] = []
    for label, lo, hi in boundaries:
        if hi <= lo:
            continue  # zero-length segment (e.g. ride starts with a stop)
        dist_m = distance[hi] - distance[lo]
        dur_s = time_s[hi] - time_s[lo]
        avg_speed = dist_m / dur_s if dur_s > 0 else None
        climb = _climb_sum(altitude, lo, hi)
        climb_per_km = climb / (dist_m / 1000.0) if dist_m > 0 else None
        segments.append(
            Segment(
                label=label,
                index_start=lo,
                index_end=hi,
                distance_m=dist_m,
                duration_s=dur_s,
                avg_speed_mps=avg_speed,
                avg_hr=_slice_mean(hr, lo, hi),
                avg_cadence=_slice_mean(cad, lo, hi),
                avg_watts=_slice_mean(watts, lo, hi),
                climb_m=climb,
                climb_m_per_km=climb_per_km,
            )
        )
    return segments
