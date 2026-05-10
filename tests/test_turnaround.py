from rando_recap.stops import Control
from rando_recap.turnaround import detect_turnaround


def _line(points):
    return [list(p) for p in points]


def test_too_short_returns_none():
    assert detect_turnaround([], []) is None
    assert detect_turnaround([[0.0, 0.0]], []) is None


def test_zero_distance_returns_none():
    # All samples at the same location — no farthest point.
    assert detect_turnaround([[0.0, 0.0]] * 5, []) is None


def test_out_and_back_without_control_uses_farthest_index():
    # Out and back along a meridian: 0 → 1° N → back to start. Farthest is the apex.
    pts = _line([(0.0, 0.0), (0.5, 0.0), (1.0, 0.0), (0.5, 0.0), (0.0, 0.0)])
    t = detect_turnaround(pts, [])
    assert t is not None
    assert t.control_idx is None
    assert t.index_before == 2
    assert t.index_after == 2


def test_out_and_back_snaps_to_nearby_control():
    # Same out-and-back, with a control parked at the apex (within 1km).
    pts = _line([(0.0, 0.0), (0.5, 0.0), (1.0, 0.0), (0.5, 0.0), (0.0, 0.0)])
    controls = [
        Control(index_before=2, index_after=2, lat=1.0, lng=0.0, time_before_s=120, time_after_s=720),
    ]
    t = detect_turnaround(pts, controls)
    assert t is not None
    assert t.control_idx == 0
    assert t.index_before == 2
    assert t.index_after == 2


def test_far_control_does_not_snap():
    # Control sits well away from the apex (>1km) — fall back to the farthest index.
    pts = _line([(0.0, 0.0), (0.5, 0.0), (1.0, 0.0), (0.5, 0.0), (0.0, 0.0)])
    controls = [
        Control(index_before=1, index_after=1, lat=0.5, lng=0.0, time_before_s=60, time_after_s=120),
    ]
    t = detect_turnaround(pts, controls)
    assert t is not None
    assert t.control_idx is None
    assert t.index_before == 2


def test_point_to_point_returns_none():
    # Straight line: end is the farthest point. end_dist / farthest_dist == 1, gated out.
    pts = _line([(0.0, 0.0), (0.25, 0.0), (0.5, 0.0), (0.75, 0.0), (1.0, 0.0)])
    assert detect_turnaround(pts, []) is None


def test_picks_nearest_of_multiple_candidate_controls():
    # Two controls within snap range of the apex; the closer one wins.
    pts = _line([(0.0, 0.0), (0.5, 0.0), (1.0, 0.0), (0.5, 0.0), (0.0, 0.0)])
    controls = [
        # ~1.1km north of apex — outside SNAP_TO_CONTROL_M, would not snap on its own
        Control(index_before=2, index_after=2, lat=1.01, lng=0.0, time_before_s=120, time_after_s=180),
        # ~110m east of apex — clearly inside snap range
        Control(index_before=2, index_after=2, lat=1.0, lng=0.001, time_before_s=200, time_after_s=300),
    ]
    t = detect_turnaround(pts, controls)
    assert t is not None
    assert t.control_idx == 1
