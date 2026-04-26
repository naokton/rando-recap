"""Strava API client: OAuth (one-time browser flow), activity + streams fetch.

Tokens are cached to disk and auto-refreshed when expired.
Activity and stream responses go through ``cache.Cache``.
"""

from __future__ import annotations

import json
import secrets
import time
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

if TYPE_CHECKING:
    from pathlib import Path

    from .cache import Cache

AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"
TOKEN_URL = "https://www.strava.com/oauth/token"
API_BASE = "https://www.strava.com/api/v3"
SCOPES = "activity:read_all"
DEFAULT_STREAM_TYPES = (
    "time",
    "distance",
    "latlng",
    "altitude",
    "heartrate",
    "cadence",
    "watts",
)


@dataclass
class Token:
    access_token: str
    refresh_token: str
    expires_at: int

    @classmethod
    def load(cls, path: Path) -> Token | None:
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        return cls(**data)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.__dict__))

    def expired(self, skew: int = 60) -> bool:
        return time.time() + skew >= self.expires_at


class StravaClient:
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        token_path: Path,
        cache: Cache,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.token_path = token_path
        self.cache = cache
        self._token: Token | None = Token.load(token_path)

    # --- auth ----------------------------------------------------------------

    def login(self, port: int = 8721) -> None:
        """Run the one-time browser OAuth flow and persist tokens."""
        state = secrets.token_urlsafe(16)
        redirect_uri = f"http://localhost:{port}/callback"
        params = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPES,
            "approval_prompt": "auto",
            "state": state,
        }
        url = f"{AUTHORIZE_URL}?{urlencode(params)}"
        code_holder: dict[str, str] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                qs = parse_qs(urlparse(self.path).query)
                if qs.get("state", [""])[0] != state:
                    self.send_response(400)
                    self.end_headers()
                    return
                code_holder["code"] = qs.get("code", [""])[0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<h1>Authorized.</h1><p>You can close this tab.</p>")

            def log_message(self, format: str, *args: object) -> None:  # silence
                return

        server = HTTPServer(("localhost", port), Handler)
        webbrowser.open(url)
        # Single request: handle the callback then return.
        server.handle_request()
        if "code" not in code_holder:
            raise RuntimeError("Strava OAuth callback did not return a code")
        self._exchange_code(code_holder["code"])

    def _post_token(self, grant: dict[str, str]) -> None:
        resp = httpx.post(
            TOKEN_URL,
            data={
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                **grant,
            },
            timeout=30,
        )
        resp.raise_for_status()
        body = resp.json()
        self._token = Token(
            access_token=body["access_token"],
            refresh_token=body["refresh_token"],
            expires_at=body["expires_at"],
        )
        self._token.save(self.token_path)

    def _exchange_code(self, code: str) -> None:
        self._post_token({"grant_type": "authorization_code", "code": code})

    def _refresh(self) -> None:
        assert self._token is not None
        self._post_token({"grant_type": "refresh_token", "refresh_token": self._token.refresh_token})

    def _auth_headers(self) -> dict[str, str]:
        if self._token is None:
            raise RuntimeError("Not authenticated. Run `ride login` first.")
        if self._token.expired():
            self._refresh()
        return {"Authorization": f"Bearer {self._token.access_token}"}

    @property
    def authenticated(self) -> bool:
        return self._token is not None

    # --- fetch ---------------------------------------------------------------

    def _check(self, resp: httpx.Response, what: str) -> None:
        if resp.status_code == 404:
            raise StravaScopeError(
                f"Strava returned 404 for {what}. The activity is either "
                "private (and your token lacks the activity:read_all scope) "
                "or the id is wrong. Run `ride login` to (re-)do the browser "
                "OAuth flow with the right scope."
            )
        resp.raise_for_status()

    def get_activity(self, activity_id: int, refresh: bool = False) -> dict[str, Any]:
        if not refresh:
            cached = self.cache.get_activity(activity_id)
            if cached is not None:
                return cached
        resp = httpx.get(
            f"{API_BASE}/activities/{activity_id}",
            headers=self._auth_headers(),
            params={"include_all_efforts": "false"},
            timeout=30,
        )
        self._check(resp, f"activity {activity_id}")
        data = resp.json()
        self.cache.set_activity(activity_id, data)
        return data

    def get_streams(
        self,
        activity_id: int,
        types: tuple[str, ...] = DEFAULT_STREAM_TYPES,
        refresh: bool = False,
    ) -> dict[str, Any]:
        if not refresh:
            cached = self.cache.get_streams(activity_id)
            if cached is not None:
                return cached
        resp = httpx.get(
            f"{API_BASE}/activities/{activity_id}/streams",
            headers=self._auth_headers(),
            params={"keys": ",".join(types), "key_by_type": "true"},
            timeout=60,
        )
        self._check(resp, f"streams for activity {activity_id}")
        data = resp.json()
        self.cache.set_streams(activity_id, data)
        return data


class StravaScopeError(RuntimeError):
    pass
