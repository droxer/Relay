"""Every published route either authenticates its caller or is public on purpose.

Handlers check auth themselves (a session, the admin role, a daemon node
token, a chat-service token, or a one-time credential), so nothing structural
stops a new route from forgetting. This walks the real route table and calls
each route with no credentials: anything not listed in ``PUBLIC_ROUTES`` must
refuse with a 4xx. Adding a public route means adding it here, in review.

``/admin`` routes are also guarded by a router-level dependency
(``api/contract.py``); the last test proves a signed-in non-admin is refused
by every one of them.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from relay.api.contract import API_PREFIX
from relay.app import create_app

# (method, path) pairs that answer without any credential, by design.
PUBLIC_ROUTES = frozenset(
    {
        ("GET", "/healthz"),
        ("GET", "/api"),
        ("GET", f"{API_PREFIX}/auth/status"),
        ("POST", f"{API_PREFIX}/auth/login"),
        ("POST", f"{API_PREFIX}/auth/logout"),
        ("POST", f"{API_PREFIX}/auth/bootstrap"),
        # Password reset: answers 202 whatever matched; redeeming needs the token.
        ("POST", f"{API_PREFIX}/auth/password-reset"),
        ("POST", f"{API_PREFIX}/auth/password-reset/lookup"),
        ("POST", f"{API_PREFIX}/auth/password-reset/complete"),
        # Waitlist (mounted only when enabled): every valid join is 202.
        ("POST", f"{API_PREFIX}/waitlist"),
        ("POST", f"{API_PREFIX}/waitlist/invites/lookup"),
        ("POST", f"{API_PREFIX}/waitlist/invites/accept"),
        # Computer setup: the installer and bundle are public downloads; the
        # device flow starts anonymously and redeems with its device code.
        ("GET", "/install.sh"),
        ("GET", "/computer/install.sh"),
        ("GET", "/install.ps1"),
        ("GET", "/computer/install.ps1"),
        ("GET", "/computer/daemon-{digest}.tar.gz"),
        ("POST", f"{API_PREFIX}/computer-authorizations"),
        # Automation webhooks authenticate with the routine's own signing secret.
        ("POST", f"{API_PREFIX}/automations/{{routine_id}}/webhook"),
        # Profile images are persisted media locators rendered by <img>.
        ("GET", "/profile-images/{kind}/{entity_id}"),
        # The exported web UI.
        ("GET", "/{asset_path:path}"),
    }
)
SKIPPED_PATHS = frozenset({"/api/docs", "/api/docs/oauth2-redirect", "/api/openapi.json", "/api/redoc"})


def _client(monkeypatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_CHANNELS_ENABLED", "1")
    monkeypatch.setenv("RELAY_WAITLIST_ENABLED", "1")
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    web_dist = tmp_path / "web-out"
    web_dist.mkdir()
    (web_dist / "index.html").write_text("<html>relay</html>")
    monkeypatch.setenv("RELAY_WEB_UI_DIST_DIR", str(web_dist))
    return TestClient(create_app(tmp_path / "state"), raise_server_exceptions=False)


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "probe", path)


def _operations(client: TestClient) -> list[tuple[str, str]]:
    return sorted(
        (method, route.path)
        for route in client.app.routes
        if isinstance(route, APIRoute) and route.path not in SKIPPED_PATHS
        for method in route.methods or ()
        if method != "HEAD"
    )


def _call(client: TestClient, method: str, path: str) -> int:
    body = {"json": {}} if method in ("POST", "PUT", "PATCH") else {}
    return client.request(method, _concrete(path), **body).status_code


def test_every_non_public_route_refuses_an_anonymous_caller(monkeypatch, tmp_path: Path) -> None:
    client = _client(monkeypatch, tmp_path)
    operations = _operations(client)
    assert len(operations) > 150  # the walk saw the real route table

    unauthenticated = {
        f"{method} {path} -> {status}"
        for method, path in operations
        if (method, path) not in PUBLIC_ROUTES
        and not 400 <= (status := _call(client, method, path)) < 500
    }

    assert unauthenticated == set()


def test_public_routes_are_still_published(monkeypatch, tmp_path: Path) -> None:
    client = _client(monkeypatch, tmp_path)
    published = set(_operations(client))
    assert PUBLIC_ROUTES <= published, sorted(PUBLIC_ROUTES - published)


def test_every_admin_route_refuses_a_signed_in_non_admin(monkeypatch, tmp_path: Path) -> None:
    client = _client(monkeypatch, tmp_path)
    assert client.post(
        f"{API_PREFIX}/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
    ).status_code == 200
    assert client.post(
        f"{API_PREFIX}/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}
    ).status_code == 200
    assert client.post(
        f"{API_PREFIX}/admin/accounts",
        json={"username": "alice", "password": "userpass", "role": "user"},
    ).status_code == 201
    client.cookies.clear()
    assert client.post(
        f"{API_PREFIX}/auth/login", json={"username": "alice", "password": "userpass"}
    ).status_code == 200

    admitted = {
        f"{method} {path} -> {status}"
        for method, path in _operations(client)
        if path.startswith(f"{API_PREFIX}/admin/")
        and (status := _call(client, method, path)) != 403
    }

    assert admitted == set()
