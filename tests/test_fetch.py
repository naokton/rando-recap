from datetime import datetime, timedelta

import pytest

from rando_recap.app import fetch_summaries, parse_since
from rando_recap.app import matches_filter as _matches_filter


def test_parse_since_all_returns_none():
    assert parse_since("all") is None
    assert parse_since("ALL") is None


def test_parse_since_relative_units():
    now = datetime.now().timestamp()
    one_month = parse_since("1m")
    one_year = parse_since("1y")
    assert one_month is not None and one_year is not None
    # Within a few seconds of expected (test execution drift).
    assert abs((now - one_month) - timedelta(days=30).total_seconds()) < 5
    assert abs((now - one_year) - timedelta(days=365).total_seconds()) < 5


def test_parse_since_iso_date():
    ts = parse_since("2025-01-01")
    assert ts == int(datetime(2025, 1, 1).timestamp())


def test_parse_since_invalid_raises():
    with pytest.raises(ValueError):
        parse_since("bogus")
    with pytest.raises(ValueError):
        parse_since("5x")


def test_matches_filter_passes_when_above_threshold():
    s = {"sport_type": "Ride", "distance": 200_000}
    assert _matches_filter(s, {"Ride", "GravelRide"}, 190_000)


def test_matches_filter_rejects_short_distance():
    s = {"sport_type": "Ride", "distance": 50_000}
    assert not _matches_filter(s, {"Ride", "GravelRide"}, 190_000)


def test_matches_filter_rejects_other_sport():
    s = {"sport_type": "Run", "distance": 200_000}
    assert not _matches_filter(s, {"Ride", "GravelRide"}, 190_000)


def test_matches_filter_falls_back_to_type():
    # Older activities only carry `type`, not `sport_type`.
    s = {"type": "Ride", "distance": 200_000}
    assert _matches_filter(s, {"Ride"}, 190_000)


def test_matches_filter_handles_missing_distance():
    s = {"sport_type": "Ride"}
    assert not _matches_filter(s, {"Ride"}, 190_000)


class _FakeCache:
    def __init__(self, present=()):
        self._store = {sid: {} for sid in present}

    def has(self, kind, id_):
        return id_ in self._store

    def set(self, kind, id_, data):
        self._store[id_] = data


class _FakeClient:
    def __init__(self, activities, present=()):
        self._activities = activities
        self.cache = _FakeCache(present)
        self.list_after = "unset"

    def list_athlete_activities(self, after=None):
        self.list_after = after
        yield from self._activities


def _activity(sid, name="ride", distance=200_000):
    return {"id": sid, "name": name, "distance": distance, "start_date_local": "2026-05-01T00:00:00Z"}


def test_fetch_summaries_adds_new_and_skips_cached():
    client = _FakeClient([_activity(1), _activity(2)], present=[1])
    events = list(fetch_summaries(client, after=12345))

    assert client.list_after == 12345
    assert [(e.action, e.id) for e in events] == [("cached", 1), ("add", 2)]
    # The new activity was cached; the already-present one left untouched.
    assert 2 in client.cache._store and client.cache._store[2]["name"] == "ride"


def test_fetch_summaries_refresh_recaches_present():
    client = _FakeClient([_activity(1)], present=[1])
    events = list(fetch_summaries(client, after=None, refresh=True))

    assert [e.action for e in events] == ["add"]
    assert client.cache._store[1]["id"] == 1
