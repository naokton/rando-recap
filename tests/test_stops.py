from ride_analysis.stops import detect_controls


def test_detects_stop_above_threshold():
    # Sample interval 1s, then a 600s gap (paused), then more 1s samples.
    time_s = [0, 1, 2, 3, 603, 604, 605]
    latlng = [[float(i), float(i)] for i in range(len(time_s))]
    controls = detect_controls(time_s, latlng, min_stop_s=300)
    assert len(controls) == 1
    c = controls[0]
    assert c.index_before == 3
    assert c.index_after == 4
    assert c.rest_s == 600
    assert (c.lat, c.lng) == (3.0, 3.0)


def test_ignores_normal_sample_intervals():
    time_s = list(range(0, 100))
    latlng = [[0.0, 0.0]] * len(time_s)
    assert detect_controls(time_s, latlng, min_stop_s=60) == []


def test_threshold_inclusive():
    time_s = [0, 60]  # exactly threshold
    latlng = [[0.0, 0.0], [0.0, 0.0]]
    assert len(detect_controls(time_s, latlng, min_stop_s=60)) == 1


def test_multiple_stops():
    time_s = [0, 1, 401, 402, 1002]
    latlng = [[float(i), float(i)] for i in range(len(time_s))]
    controls = detect_controls(time_s, latlng, min_stop_s=300)
    assert [c.rest_s for c in controls] == [400, 600]
    assert [c.index_before for c in controls] == [1, 3]
