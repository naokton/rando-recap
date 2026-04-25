"""SQLite cache for Strava API responses (raw JSON blobs).

Cache hits are returned by default; pass ``refresh=True`` to bypass.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any


class Cache:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path
        self._conn = sqlite3.connect(db_path)
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY,
                fetched_at INTEGER NOT NULL,
                json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS streams (
                activity_id INTEGER PRIMARY KEY,
                fetched_at INTEGER NOT NULL,
                json TEXT NOT NULL
            );
            """
        )
        self._conn.commit()

    def get_activity(self, activity_id: int) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT json FROM activities WHERE id = ?", (activity_id,)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def set_activity(self, activity_id: int, data: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO activities (id, fetched_at, json) VALUES (?, ?, ?)",
            (activity_id, int(time.time()), json.dumps(data)),
        )
        self._conn.commit()

    def get_streams(self, activity_id: int) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT json FROM streams WHERE activity_id = ?", (activity_id,)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def set_streams(self, activity_id: int, data: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO streams (activity_id, fetched_at, json) VALUES (?, ?, ?)",
            (activity_id, int(time.time()), json.dumps(data)),
        )
        self._conn.commit()
