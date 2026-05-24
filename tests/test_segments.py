from rando_recap.segments import build_segments, coasting_frac
from rando_recap.stops import Stop
from rando_recap.streams import Streams


def _streams(time_s, distance, **extras):
    out = {
        "time": {"data": time_s},
        "distance": {"data": distance},
    }
    for k, v in extras.items():
        out[k] = {"data": v}
    return Streams(out)


def test_no_stops_yields_one_segment():
    s = _streams(
        time_s=[0, 100, 200],
        distance=[0.0, 1000.0, 2000.0],
        altitude=[10.0, 20.0, 15.0],
    )
    segs = build_segments(s, stops=[])
    assert len(segs) == 1
    seg = segs[0]
    assert seg.label == "Start → End"
    assert seg.distance_m == 2000.0
    assert seg.duration_s == 200
    assert seg.avg_speed_mps == 10.0
    # climb = +10 (10→20), then 20→15 is negative so skipped
    assert seg.climb_m == 10.0
    assert seg.climb_m_per_km == 5.0


def test_segments_around_stops():
    # Indices: 0..3 first leg, gap, 4..6 second leg, gap, 7..9 third leg
    time_s = [0, 60, 120, 180, 800, 860, 920, 1500, 1560, 1620]
    distance = [0.0, 1000, 2000, 3000, 3000.0, 4000, 5000, 5000.0, 6000, 7000]
    s = _streams(time_s=time_s, distance=distance)
    stops = [
        Stop(3, 4, 0.0, 0.0, time_s[3], time_s[4]),
        Stop(6, 7, 0.0, 0.0, time_s[6], time_s[7]),
    ]
    segs = build_segments(s, stops)
    assert [seg.label for seg in segs] == [
        "Start → S1",
        "S1 → S2",
        "S2 → End",
    ]
    assert [seg.distance_m for seg in segs] == [3000.0, 2000.0, 2000.0]
    assert [seg.duration_s for seg in segs] == [180, 120, 120]


def test_missing_optional_streams_yield_none_means():
    s = _streams(time_s=[0, 60], distance=[0.0, 1000.0])
    seg = build_segments(s, stops=[])[0]
    assert seg.avg_hr is None
    assert seg.avg_cadence is None
    assert seg.avg_watts is None
    assert seg.climb_m == 0.0


def test_cadence_watts_exclude_zeros_hr_does_not():
    # Coasting samples log cadence/watts as 0. Those are excluded from the
    # cadence/watts means (average while active), but HR keeps all samples.
    s = _streams(
        time_s=[0, 60, 120, 180],
        distance=[0.0, 1000.0, 2000.0, 3000.0],
        heartrate=[140, 0, 150, 160],
        cadence=[90, 0, 0, 80],
        watts=[200, 0, 0, 100],
    )
    seg = build_segments(s, stops=[])[0]
    assert seg.avg_hr == (140 + 0 + 150 + 160) / 4  # zeros counted
    assert seg.avg_cadence == (90 + 80) / 2  # zeros excluded
    assert seg.avg_watts == (200 + 100) / 2  # zeros excluded


def test_all_zero_cadence_yields_none():
    # A fully-coasting leg has no active samples → no meaningful average.
    s = _streams(
        time_s=[0, 60, 120],
        distance=[0.0, 1000.0, 2000.0],
        cadence=[0, 0, 0],
    )
    seg = build_segments(s, stops=[])[0]
    assert seg.avg_cadence is None


def test_coasting_frac_counts_cadence_zeros():
    # 2 of 5 present samples coast; None is ignored in the denominator.
    cad = [80, 0, 90, None, 0]
    assert coasting_frac(cad, 0, 4) == 2 / 4
    assert coasting_frac(None, 0, 4) is None
    assert coasting_frac([None, None], 0, 1) is None


def test_segment_carries_coasting_frac():
    s = _streams(
        time_s=[0, 60, 120, 180],
        distance=[0.0, 1000.0, 2000.0, 3000.0],
        cadence=[90, 0, 0, 80],
    )
    seg = build_segments(s, stops=[])[0]
    assert seg.coasting_frac == 2 / 4


def test_zero_length_segment_skipped():
    # Stop at the very start (e.g. ride begins paused) should not produce a
    # zero-length leading segment.
    time_s = [0, 600, 660, 720]
    distance = [0.0, 0.0, 1000.0, 2000.0]
    s = _streams(time_s=time_s, distance=distance)
    stops = [Stop(0, 1, 0.0, 0.0, 0, 600)]
    segs = build_segments(s, stops)
    assert [seg.label for seg in segs] == ["S1 → End"]
