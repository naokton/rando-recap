"""SQLite cache for Strava API responses (raw JSON blobs).

Cache hits are returned by default; pass ``refresh=True`` to bypass.
"""

from __future__ import annotations

import json
import sqlite3
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path


class Cache:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path
        self._conn = sqlite3.connect(db_path)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS blobs (
                kind TEXT NOT NULL,
                id INTEGER NOT NULL,
                json TEXT NOT NULL,
                PRIMARY KEY (kind, id)
            )
            """
        )
        self._conn.commit()

    def get(self, kind: str, id_: int) -> dict[str, Any] | None:
        row = self._conn.execute("SELECT json FROM blobs WHERE kind = ? AND id = ?", (kind, id_)).fetchone()
        return json.loads(row[0]) if row else None

    def has(self, kind: str, id_: int) -> bool:
        row = self._conn.execute("SELECT 1 FROM blobs WHERE kind = ? AND id = ?", (kind, id_)).fetchone()
        return row is not None

    def set(self, kind: str, id_: int, data: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO blobs (kind, id, json) VALUES (?, ?, ?)",
            (kind, id_, json.dumps(data)),
        )
        self._conn.commit()

    def iter_kind(self, kind: str) -> Iterator[tuple[int, dict[str, Any]]]:
        """Yield (id, parsed_json) for every blob of the given kind."""
        for row in self._conn.execute("SELECT id, json FROM blobs WHERE kind = ?", (kind,)):
            yield row[0], json.loads(row[1])
