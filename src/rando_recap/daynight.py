"""Day / civil-twilight / night classification of a ride's GPS stream.

For each calendar day the ride spans (in the activity's local timezone) we
pick the rider's mid-day position as a representative observer, ask astral
for that day's dawn/sunrise/sunset/dusk (civil twilight by default), and
classify each stream point as ``day``, ``twilight``, or ``night``.
Consecutive same-state points collapse into stretches; adjacent stretches
share a boundary index so polylines drawn from each stretch connect with
no visible gap.

The local-tz offset is treated as fixed across the whole ride. DST
transitions mid-ride are exceedingly rare for randonneuring and not
modeled here.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Literal

from astral import Observer
from astral.sun import sun

State = Literal["day", "twilight", "night"]

# A recording pause (stop) shows up as an inter-sample time delta far larger
# than the device's normal cadence. Deltas above max(floor, factor * median)
# are treated as gaps and excluded from ride duration, so the figures don't
# depend on the stop-detection threshold.
_GAP_CADENCE_FACTOR = 5
_GAP_FLOOR_S = 5


@dataclass(frozen=True)
class Stretch:
    state: State
    index_start: int
    index_end: int


def ride_seconds(time_s: list[int], stretches: list[Stretch]) -> list[int]:
    """Riding seconds per stretch, excluding recording-gap (pause) time.

    Returns a list parallel to ``stretches``. Adjacent stretches share a
    boundary index, but each interval is counted by its end index so no time
    is double-counted across the seam.
    """
    n = len(time_s)
    if n < 2:
        return [0 for _ in stretches]
    deltas = sorted(time_s[i] - time_s[i - 1] for i in range(1, n))
    median = deltas[len(deltas) // 2]
    gap_threshold = max(_GAP_FLOOR_S, _GAP_CADENCE_FACTOR * median)
    out: list[int] = []
    for s in stretches:
        total = 0
        for i in range(s.index_start + 1, s.index_end + 1):
            d = time_s[i] - time_s[i - 1]
            if d <= gap_threshold:
                total += d
        out.append(total)
    return out


Classifier = Callable[[datetime], State]


def build_stretches(
    streams: dict[str, dict],
    activity_start_iso: str,
    utc_offset_s: int,
) -> list[Stretch]:
    """Bucket the ride's stream into day/twilight/night stretches."""
    time_s = streams.get("time", {}).get("data") or []
    latlng = streams.get("latlng", {}).get("data") or []
    n = min(len(time_s), len(latlng))
    if n == 0:
        return []

    start_utc = datetime.fromisoformat(activity_start_iso)
    if start_utc.tzinfo is None:
        start_utc = start_utc.replace(tzinfo=UTC)
    local_tz = timezone(timedelta(seconds=utc_offset_s))

    local_dts = [(start_utc + timedelta(seconds=time_s[i])).astimezone(local_tz) for i in range(n)]

    indices_by_date: dict[date, list[int]] = {}
    for i, ldt in enumerate(local_dts):
        indices_by_date.setdefault(ldt.date(), []).append(i)

    classifier_by_date: dict[date, Classifier] = {}
    for d, indices in indices_by_date.items():
        noon = datetime.combine(d, datetime.min.time(), tzinfo=local_tz).replace(hour=12)
        rep_idx = min(indices, key=lambda i: abs((local_dts[i] - noon).total_seconds()))
        lat, lng = latlng[rep_idx]
        classifier_by_date[d] = _make_classifier(Observer(latitude=lat, longitude=lng), d, local_tz)

    stretches: list[Stretch] = []
    cur_state: State | None = None
    cur_lo = 0
    for i, ldt in enumerate(local_dts):
        st = classifier_by_date[ldt.date()](ldt)
        if cur_state is None:
            cur_state, cur_lo = st, i
        elif st != cur_state:
            stretches.append(Stretch(cur_state, cur_lo, i))
            cur_state, cur_lo = st, i
    if cur_state is not None:
        stretches.append(Stretch(cur_state, cur_lo, n - 1))
    return stretches


def _make_classifier(observer: Observer, d: date, tz: timezone) -> Classifier:
    try:
        s = sun(observer, date=d, tzinfo=tz)
    except ValueError:
        # Polar day / polar night — astral can't locate the events. Randonneuring
        # rides effectively never hit this; default to "day" so the halo stays
        # quiet rather than misleading.
        return lambda _dt: "day"
    dawn, sunrise, sunset, dusk = s["dawn"], s["sunrise"], s["sunset"], s["dusk"]

    def classify(dt: datetime) -> State:
        if dt < dawn or dt > dusk:
            return "night"
        if dt < sunrise or dt > sunset:
            return "twilight"
        return "day"

    return classify
