"""Typed accessor over Strava's ``key_by_type`` stream envelope.

Strava returns streams as ``{type: {"data": [...], "type": ..., ...}}``.
This wrapper localizes that shape in one place so consumers don't repeat
``streams[key]["data"]`` / ``streams.get(key, {}).get("data")`` and the
missing-key defensiveness that comes with it. ``time``, ``latlng`` and
``distance`` are treated as required (GPS rides always carry them); the
remaining streams are optional and return ``None`` when absent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class MissingStreamsError(ValueError):
    """Activity is missing the ``time`` or ``latlng`` streams (no GPS)."""


@dataclass(frozen=True)
class Streams:
    """Thin view over the raw ``key_by_type`` dict returned by the Strava API."""

    raw: dict[str, Any]

    def has(self, key: str) -> bool:
        return key in self.raw

    def series(self, key: str) -> list[Any] | None:
        """Data list for ``key``, or ``None`` if the stream is absent."""
        bucket = self.raw.get(key)
        return bucket.get("data") if bucket else None

    def require_gps(self) -> None:
        """Raise :class:`MissingStreamsError` unless time and latlng are present."""
        if "time" not in self.raw or "latlng" not in self.raw:
            raise MissingStreamsError("Activity is missing 'time' or 'latlng' streams (no GPS?).")

    @property
    def time(self) -> list[int]:
        return self.raw["time"]["data"]

    @property
    def latlng(self) -> list[list[float]]:
        return self.raw["latlng"]["data"]

    @property
    def distance(self) -> list[float]:
        return self.raw["distance"]["data"]

    @property
    def altitude(self) -> list[float] | None:
        return self.series("altitude")

    @property
    def heartrate(self) -> list[float] | None:
        return self.series("heartrate")

    @property
    def cadence(self) -> list[float] | None:
        return self.series("cadence")

    @property
    def watts(self) -> list[float] | None:
        return self.series("watts")
