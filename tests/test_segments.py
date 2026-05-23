from rando_recap.segments import build_segments
from rando_recap.stops import Stop


def _streams(time_s, distance, **extras):
    out = {
        "time": {"data": time_s},
        "distance": {"data": distance},
    }
    for k, v in extras.items():
        out[k] = {"data": v}
    return out


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


def test_zero_length_segment_skipped():
    # Stop at the very start (e.g. ride begins paused) should not produce a
    # zero-length leading segment.
    time_s = [0, 600, 660, 720]
    distance = [0.0, 0.0, 1000.0, 2000.0]
    s = _streams(time_s=time_s, distance=distance)
    stops = [Stop(0, 1, 0.0, 0.0, 0, 600)]
    segs = build_segments(s, stops)
    assert [seg.label for seg in segs] == ["S1 → End"]
