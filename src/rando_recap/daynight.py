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

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from itertools import pairwise
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from .streams import Streams

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


@dataclass(frozen=True)
class LightingBand:
    """A day/twilight/night span in elapsed seconds from the ride's start."""

    state: State
    start_s: int
    end_s: int


def gap_threshold(time_s: list[int]) -> int:
    """Delta above which an inter-sample gap is a recording pause, not riding."""
    deltas = sorted(time_s[i] - time_s[i - 1] for i in range(1, len(time_s)))
    median = deltas[len(deltas) // 2]
    return max(_GAP_FLOOR_S, _GAP_CADENCE_FACTOR * median)


def seconds_by_state_range(
    time_s: list[int],
    stretches: list[Stretch],
    lo: int,
    hi: int,
    threshold: int,
) -> dict[State, int]:
    """Riding seconds per state within sample indices ``[lo, hi]``, gap-excluded.

    Adjacent stretches share a boundary index; each interval is counted by
    its end index so no time is double-counted across the seam. Stretches are
    clipped to ``[lo, hi]`` so a segment of the ride can be measured in
    isolation with the same logic as the whole.
    """
    out: dict[State, int] = {"day": 0, "twilight": 0, "night": 0}
    for s in stretches:
        start = max(s.index_start, lo)
        end = min(s.index_end, hi)
        for i in range(start + 1, end + 1):
            d = time_s[i] - time_s[i - 1]
            if d <= threshold:
                out[s.state] += d
    return out


def seconds_by_state(time_s: list[int], stretches: list[Stretch]) -> dict[State, int]:
    """Riding seconds per state over the whole ride, excluding recording gaps."""
    if len(time_s) < 2:
        return {"day": 0, "twilight": 0, "night": 0}
    return seconds_by_state_range(time_s, stretches, 0, len(time_s) - 1, gap_threshold(time_s))


Classifier = Callable[[datetime], State]


def _localize(
    streams: Streams,
    activity_start_iso: str,
    utc_offset_s: int,
) -> tuple[list[int], list[list[float]], list[datetime], timezone]:
    """Stream time/latlng plus each sample's local datetime and the local tz.

    ``local_dts`` is empty when the activity carries no GPS samples. The tz
    offset is treated as fixed across the ride (see the module docstring).
    """
    time_s = streams.series("time") or []
    latlng = streams.series("latlng") or []
    n = min(len(time_s), len(latlng))
    local_tz = timezone(timedelta(seconds=utc_offset_s))
    if n == 0:
        return time_s, latlng, [], local_tz
    start_utc = datetime.fromisoformat(activity_start_iso)
    if start_utc.tzinfo is None:
        start_utc = start_utc.replace(tzinfo=UTC)
    local_dts = [(start_utc + timedelta(seconds=time_s[i])).astimezone(local_tz) for i in range(n)]
    return time_s, latlng, local_dts, local_tz


def _noon_observer(
    local_dts: list[datetime],
    latlng: list[list[float]],
    d: date,
    tz: timezone,
    candidates: Iterable[int],
) -> Observer:
    """Observer at the ``candidates`` sample nearest ``d``'s local noon.

    Passing same-date indices ties the observer to that day's own track; passing
    all sample indices lets a date spent entirely at rest borrow the position of
    the bracketing stop — a fair stand-in for where the rider was resting.
    """
    noon = datetime.combine(d, datetime.min.time(), tzinfo=tz).replace(hour=12)
    rep = min(candidates, key=lambda i: abs((local_dts[i] - noon).total_seconds()))
    lat, lng = latlng[rep]
    return Observer(latitude=lat, longitude=lng)


def build_stretches(
    streams: Streams,
    activity_start_iso: str,
    utc_offset_s: int,
) -> list[Stretch]:
    """Bucket the ride's stream into day/twilight/night stretches."""
    _, latlng, local_dts, local_tz = _localize(streams, activity_start_iso, utc_offset_s)
    if not local_dts:
        return []
    n = len(local_dts)

    indices_by_date: dict[date, list[int]] = {}
    for i, ldt in enumerate(local_dts):
        indices_by_date.setdefault(ldt.date(), []).append(i)

    classifier_by_date: dict[date, Classifier] = {}
    for d, indices in indices_by_date.items():
        obs = _noon_observer(local_dts, latlng, d, local_tz, indices)
        classifier_by_date[d] = _make_classifier(obs, d, local_tz)

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


def lighting_bands(
    streams: Streams,
    activity_start_iso: str,
    utc_offset_s: int,
) -> list[LightingBand]:
    """Continuous day/twilight/night bands across the ride's wall-clock span.

    :func:`build_stretches` classifies each *sample*, so it goes blind during
    recording gaps: twilight or night that falls entirely inside a rest, or a
    rest that straddles a sunrise/sunset, leaves no sample to classify and so no
    band. This instead evaluates the real sun events for every local date the
    ride spans, yielding bands in elapsed seconds (matching the chart's time
    axis) that stay correct across rests. Day bands are emitted too; callers may
    drop them.
    """
    time_s, latlng, local_dts, local_tz = _localize(streams, activity_start_iso, utc_offset_s)
    if not local_dts:
        return []
    n = len(local_dts)
    base_s = time_s[0]
    start_local, end_local = local_dts[0], local_dts[-1]
    if end_local <= start_local:
        return []

    # Every date the ride spans gets an observer from the sample nearest its
    # local noon (searching all samples, so a date spent wholly at rest still
    # resolves — see _noon_observer).
    classifier_by_date: dict[date, Classifier] = {}
    boundaries: list[datetime] = []
    d = start_local.date()
    while d <= end_local.date():
        obs = _noon_observer(local_dts, latlng, d, local_tz, range(n))
        classifier_by_date[d] = _make_classifier(obs, d, local_tz)
        try:
            s = sun(obs, date=d, tzinfo=local_tz)
        except ValueError:
            pass  # polar day/night — no events; the date stays a single state
        else:
            boundaries.extend((s["dawn"], s["sunrise"], s["sunset"], s["dusk"]))
        d += timedelta(days=1)

    # Cut the ride span at every sun event within it, then label each
    # sub-interval by the state at its midpoint. Adjacent same-state runs merge.
    edges = [start_local, *sorted(b for b in boundaries if start_local < b < end_local), end_local]
    bands: list[LightingBand] = []
    for a, b in pairwise(edges):
        if b <= a:
            continue
        mid = a + (b - a) / 2
        st = classifier_by_date[mid.date()](mid)
        start_s = base_s + int((a - start_local).total_seconds())
        end_s = base_s + int((b - start_local).total_seconds())
        if bands and bands[-1].state == st:
            bands[-1] = LightingBand(st, bands[-1].start_s, end_s)
        else:
            bands.append(LightingBand(st, start_s, end_s))
    return bands


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
