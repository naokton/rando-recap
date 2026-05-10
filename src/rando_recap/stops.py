"""Stop/control detection from Strava streams.

Garmin (and most head units) pause recording during stops, so the ``time``
stream has gaps where the device was paused. A stop is therefore a gap
``time[i] - time[i-1] > min_stop_seconds``; no velocity analysis needed.
"""

from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass
class Control:
    """A detected stop, treated as a control."""

    index_before: int
    """Last sample index before the pause."""
    index_after: int
    """First sample index after the pause (= index_before + 1)."""
    lat: float
    lng: float
    time_before_s: int
    """Elapsed seconds (from ride start) at the last pre-pause sample."""
    time_after_s: int
    """Elapsed seconds at the first post-pause sample."""

    @property
    def rest_s(self) -> int:
        return self.time_after_s - self.time_before_s


def detect_controls(
    time_s: list[int],
    latlng: list[list[float]],
    min_stop_s: int,
) -> list[Control]:
    if len(time_s) != len(latlng):
        raise ValueError(f"time/latlng length mismatch: {len(time_s)} vs {len(latlng)}")
    controls: list[Control] = []
    for i in range(1, len(time_s)):
        gap = time_s[i] - time_s[i - 1]
        if gap >= min_stop_s:
            lat, lng = latlng[i - 1]
            controls.append(
                Control(
                    index_before=i - 1,
                    index_after=i,
                    lat=lat,
                    lng=lng,
                    time_before_s=time_s[i - 1],
                    time_after_s=time_s[i],
                )
            )
    return controls


def merge_nearby_controls(
    controls: list[Control],
    distance_m: list[float],
    merge_within_m: float,
) -> list[Control]:
    """Coalesce adjacent controls within `merge_within_m` of path distance.

    Path distance (not straight-line) so an out-and-back to the same store
    stays as two controls — only stops linked by a short in-area walk merge.
    """
    if not controls or merge_within_m <= 0:
        return list(controls)
    merged: list[Control] = [controls[0]]
    for c in controls[1:]:
        prev = merged[-1]
        gap_m = distance_m[c.index_before] - distance_m[prev.index_after]
        if gap_m <= merge_within_m:
            merged[-1] = replace(prev, index_after=c.index_after, time_after_s=c.time_after_s)
        else:
            merged.append(c)
    return merged
