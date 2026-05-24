"""Per-segment statistics between detected stops.

A "segment" is a contiguous portion of the ride between two stops (or
between the start/end and the nearest stop). Within a segment there are
no recording gaps, so elapsed time = moving time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .stops import Stop


@dataclass
class Segment:
    label: str
    """e.g. "Start → S1", "S1 → S2", "S3 → End"."""
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
    coasting_frac: float | None
    """Fraction of recorded samples with cadence == 0 (freewheeling)."""


def _slice_mean(values: list | None, lo: int, hi: int, *, skip_zero: bool = False) -> float | None:
    """Mean of values[lo:hi+1], skipping None/missing. Returns None if empty.

    With ``skip_zero`` (cadence, watts), zero samples are excluded too: a 0
    means coasting / not pedaling, so counting it answers "average including
    coasting" — far lower than the "average while active" a rider expects.
    HR has no zeros, so it keeps the plain mean.
    """
    if values is None:
        return None
    nums = [v for v in values[lo : hi + 1] if v is not None and not (skip_zero and v == 0)]
    if not nums:
        return None
    return sum(nums) / len(nums)


def coasting_frac(cadence: list | None, lo: int, hi: int) -> float | None:
    """Fraction of cadence[lo:hi+1] that is zero (freewheeling). None if no data.

    Cadence == 0 is the faithful coasting signal: the cranks aren't turning.
    Paused time logs no samples (head units auto-pause), so the denominator is
    already riding time, not elapsed.
    """
    if cadence is None:
        return None
    present = [v for v in cadence[lo : hi + 1] if v is not None]
    if not present:
        return None
    return sum(1 for v in present if v == 0) / len(present)


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
    stops: list[Stop],
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
    for i, c in enumerate(stops, start=1):
        boundaries.append((f"{prev_label} → S{i}", prev_idx, c.index_before))
        prev_label = f"S{i}"
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
                avg_cadence=_slice_mean(cad, lo, hi, skip_zero=True),
                avg_watts=_slice_mean(watts, lo, hi, skip_zero=True),
                climb_m=climb,
                climb_m_per_km=climb_per_km,
                coasting_frac=coasting_frac(cad, lo, hi),
            )
        )
    return segments
