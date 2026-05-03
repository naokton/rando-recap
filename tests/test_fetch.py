from datetime import datetime, timedelta

import click
import pytest

from ride_analysis.app import matches_filter as _matches_filter
from ride_analysis.cli import _parse_since


def test_parse_since_all_returns_none():
    assert _parse_since("all") is None
    assert _parse_since("ALL") is None


def test_parse_since_relative_units():
    now = datetime.now().timestamp()
    one_month = _parse_since("1m")
    one_year = _parse_since("1y")
    assert one_month is not None and one_year is not None
    # Within a few seconds of expected (test execution drift).
    assert abs((now - one_month) - timedelta(days=30).total_seconds()) < 5
    assert abs((now - one_year) - timedelta(days=365).total_seconds()) < 5


def test_parse_since_iso_date():
    ts = _parse_since("2025-01-01")
    assert ts == int(datetime(2025, 1, 1).timestamp())


def test_parse_since_invalid_raises():
    with pytest.raises(click.BadParameter):
        _parse_since("bogus")
    with pytest.raises(click.BadParameter):
        _parse_since("5x")


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
