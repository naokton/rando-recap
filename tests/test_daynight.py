from datetime import datetime, timedelta, timezone
from itertools import pairwise

from astral import Observer
from astral.sun import sun

from rando_recap.daynight import build_stretches, lighting_bands
from rando_recap.streams import Streams


def _streams(time_s, latlng):
    return Streams({"time": {"data": time_s}, "latlng": {"data": latlng}})


def _sf_sun_times_local(d, tzinfo):
    # San Francisco; civil-twilight default.
    return sun(Observer(latitude=37.7749, longitude=-122.4194), date=d, tzinfo=tzinfo)


def test_empty_streams_yields_no_stretches():
    assert build_stretches(_streams([], []), "2024-08-10T00:00:00Z", -7 * 3600) == []


def test_missing_streams_yields_no_stretches():
    assert build_stretches(Streams({}), "2024-08-10T00:00:00Z", -7 * 3600) == []


def test_classification_matches_astral_for_one_day():
    # Sample SF on 2024-08-10 across the full day in 30-minute steps.
    # PDT = UTC-7. 00:00 local = 07:00Z.
    utc_offset_s = -7 * 3600
    start_iso = "2024-08-10T07:00:00Z"
    n = 48  # 24h
    time_s = [i * 1800 for i in range(n)]
    latlng = [[37.7749, -122.4194]] * n

    stretches = build_stretches(_streams(time_s, latlng), start_iso, utc_offset_s)

    # Reconstruct expected per-index state from astral directly.
    tz = timezone(timedelta(seconds=utc_offset_s))
    start_utc = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
    expected = []
    for i in range(n):
        ldt = (start_utc + timedelta(seconds=time_s[i])).astimezone(tz)
        st = _sf_sun_times_local(ldt.date(), tz)
        if ldt < st["dawn"] or ldt > st["dusk"]:
            expected.append("night")
        elif ldt < st["sunrise"] or ldt > st["sunset"]:
            expected.append("twilight")
        else:
            expected.append("day")

    # Recover per-index states from stretches and compare. Adjacent stretches
    # share boundary indices; iterate in order so the later stretch wins at
    # the seam, matching how `expected` is built.
    got = [""] * n
    for s in stretches:
        for j in range(s.index_start, s.index_end + 1):
            got[j] = s.state

    assert got == expected


def test_stretches_are_ordered_and_share_boundary_indices():
    # Pre-dawn → mid-day → post-dusk in SF on 2024-08-10.
    utc_offset_s = -7 * 3600
    # 03:00, 12:00, 22:00 local.
    time_s = [0, 9 * 3600, 19 * 3600]
    latlng = [[37.7749, -122.4194]] * 3
    stretches = build_stretches(_streams(time_s, latlng), "2024-08-10T10:00:00Z", utc_offset_s)
    states = [s.state for s in stretches]
    assert states[0] == "night"
    assert "day" in states
    assert states[-1] == "night"
    for a, b in pairwise(stretches):
        assert a.index_end == b.index_start


def test_lighting_bands_cover_the_whole_span_contiguously():
    # Two SF samples nine hours apart (06:00 → 15:00 local) with nothing in
    # between: the per-sample stretches miss the morning twilight, but the
    # time-based bands must still tile [0, end] with no gaps or overlaps.
    utc_offset_s = -7 * 3600
    time_s = [0, 9 * 3600]
    latlng = [[37.7749, -122.4194]] * 2
    bands = lighting_bands(_streams(time_s, latlng), "2024-08-10T13:00:00Z", utc_offset_s)

    assert bands[0].start_s == 0
    assert bands[-1].end_s == time_s[-1]
    for a, b in pairwise(bands):
        assert a.end_s == b.start_s  # contiguous
        assert a.state != b.state  # merged: no two adjacent same-state bands


def test_lighting_shows_twilight_hidden_inside_a_rest():
    # Ride a daytime hour, then a 12-hour rest (one sample before, one after),
    # resuming pre-dawn. The evening twilight (sunset → dusk) falls entirely in
    # the rest with no sample to classify, so build_stretches misses it; the
    # time-based bands must still surface it.
    utc_offset_s = -7 * 3600
    # 16:00 local (day), then resume 04:00 next day (night, pre-dawn).
    time_s = [0, 3600, 3600 + 12 * 3600]
    latlng = [[37.7749, -122.4194]] * 3
    start_iso = "2024-08-10T23:00:00Z"  # 16:00 PDT

    sampled = {s.state for s in build_stretches(_streams(time_s, latlng), start_iso, utc_offset_s)}
    assert "twilight" not in sampled  # the gap swallowed the only twilight

    states = {b.state for b in lighting_bands(_streams(time_s, latlng), start_iso, utc_offset_s)}
    assert "twilight" in states
    assert "night" in states


def test_multi_day_uses_per_day_sun_times():
    # 36 hours spanning two SF dates.
    utc_offset_s = -7 * 3600
    n = 73  # 0.5h steps over 36h
    time_s = [i * 1800 for i in range(n)]
    latlng = [[37.7749, -122.4194]] * n
    # Start 06:00 local on 2024-08-10 → spans through 18:00 local on 2024-08-11.
    stretches = build_stretches(_streams(time_s, latlng), "2024-08-10T13:00:00Z", utc_offset_s)
    # Expect at least: twilight/day → ... → night → ... → day → ... — i.e.
    # both days' sun times are applied.
    states = [s.state for s in stretches]
    assert states.count("night") >= 1
    assert states.count("day") >= 2  # one in each day
