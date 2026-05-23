import pytest

from rando_recap.stops import Stop, detect_stops, merge_nearby_stops


@pytest.mark.parametrize("min_stop_s", [0, 1])
def test_rejects_threshold_at_or_below_floor(min_stop_s):
    # A threshold <= the ~1s sample interval flags every consecutive pair as a
    # stop — one "stop" per GPS point — which froze the UI. Reject instead.
    time_s = list(range(0, 100))
    latlng = [[0.0, 0.0]] * len(time_s)
    with pytest.raises(ValueError, match="greater than"):
        detect_stops(time_s, latlng, min_stop_s=min_stop_s)


def test_detects_stop_above_threshold():
    # Sample interval 1s, then a 600s gap (paused), then more 1s samples.
    time_s = [0, 1, 2, 3, 603, 604, 605]
    latlng = [[float(i), float(i)] for i in range(len(time_s))]
    stops = detect_stops(time_s, latlng, min_stop_s=300)
    assert len(stops) == 1
    c = stops[0]
    assert c.index_before == 3
    assert c.index_after == 4
    assert c.rest_s == 600
    assert (c.lat, c.lng) == (3.0, 3.0)


def test_ignores_normal_sample_intervals():
    time_s = list(range(0, 100))
    latlng = [[0.0, 0.0]] * len(time_s)
    assert detect_stops(time_s, latlng, min_stop_s=60) == []


def test_threshold_inclusive():
    time_s = [0, 60]  # exactly threshold
    latlng = [[0.0, 0.0], [0.0, 0.0]]
    assert len(detect_stops(time_s, latlng, min_stop_s=60)) == 1


def test_multiple_stops():
    time_s = [0, 1, 401, 402, 1002]
    latlng = [[float(i), float(i)] for i in range(len(time_s))]
    stops = detect_stops(time_s, latlng, min_stop_s=300)
    assert [c.rest_s for c in stops] == [400, 600]
    assert [c.index_before for c in stops] == [1, 3]


def _stop(ib: int, ia: int, tb: int, ta: int) -> Stop:
    return Stop(index_before=ib, index_after=ia, lat=0.0, lng=0.0, time_before_s=tb, time_after_s=ta)


def test_merge_combines_two_close_stops():
    # A: paused 300s ending at idx 1. Walk 30m (idx 1 -> 2). B: paused 300s ending at idx 2.
    stops = [_stop(1, 2, 100, 400), _stop(2, 3, 410, 710)]
    distance_m = [0.0, 1000.0, 1030.0, 1030.0]
    merged = merge_nearby_stops(stops, distance_m, merge_within_m=100.0)
    assert len(merged) == 1
    m = merged[0]
    assert (m.index_before, m.index_after) == (1, 3)
    assert (m.time_before_s, m.time_after_s) == (100, 710)
    assert m.rest_s == 610


def test_merge_keeps_out_and_back_separate():
    # Same store visited twice, with a long ride between. Path distance is large
    # even though the lat/lng of the two stops is identical.
    stops = [_stop(1, 2, 100, 400), _stop(10, 11, 5000, 5300)]
    distance_m = [
        0.0,
        1000.0,
        1000.0,
        11000.0,
        12000.0,
        13000.0,
        14000.0,
        15000.0,
        16000.0,
        17000.0,
        21000.0,
        21000.0,
    ]
    merged = merge_nearby_stops(stops, distance_m, merge_within_m=100.0)
    assert len(merged) == 2


def test_merge_chains_three_in_same_rest_area():
    # A — 30m — B — 40m — C all under threshold; should collapse into one.
    stops = [
        _stop(1, 2, 100, 400),
        _stop(2, 3, 410, 710),
        _stop(3, 4, 720, 1020),
    ]
    distance_m = [0.0, 1000.0, 1030.0, 1070.0, 1070.0]
    merged = merge_nearby_stops(stops, distance_m, merge_within_m=100.0)
    assert len(merged) == 1
    m = merged[0]
    assert (m.index_before, m.index_after) == (1, 4)
    assert (m.time_before_s, m.time_after_s) == (100, 1020)


def test_merge_disabled_when_threshold_zero():
    stops = [_stop(1, 2, 100, 400), _stop(2, 3, 410, 710)]
    distance_m = [0.0, 1000.0, 1000.0, 1000.0]
    assert merge_nearby_stops(stops, distance_m, merge_within_m=0) == stops


def test_merge_empty_input():
    assert merge_nearby_stops([], [], merge_within_m=100.0) == []
