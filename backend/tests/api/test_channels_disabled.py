from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from relay.api.contract import API_PREFIX, is_channel_route
from relay.app import channels_enabled_from_env, create_app

CHANNEL_REQUESTS = (
    ("GET", "/admin/chat-integrations"),
    ("POST", "/admin/chat-integrations"),
    ("GET", "/admin/chat-integrations/chat_1/audit"),
    ("GET", "/internal/chat/integrations/runtime"),
    ("POST", "/internal/chat/identity/resolve"),
    ("POST", "/internal/chat/conversation/sessions"),
)


def _client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_secret")
    return TestClient(create_app(tmp_path / "state"))


def _published_paths(client: TestClient) -> set[str]:
    return set(client.get("/api/openapi.json").json()["paths"])


def test_channel_routes_are_not_mounted_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("RELAY_CHANNELS_ENABLED", raising=False)
    client = _client(monkeypatch, tmp_path)

    for method, path in CHANNEL_REQUESTS:
        response = client.request(
            method,
            f"{API_PREFIX}{path}",
            headers={"Authorization": "Bearer chat_secret"},
        )
        assert response.status_code == 404, f"{method} {path} is still mounted"

    assert not [path for path in _published_paths(client) if "chat" in path]


def test_disabling_channels_leaves_the_rest_of_the_api_mounted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("RELAY_CHANNELS_ENABLED", raising=False)
    paths = _published_paths(_client(monkeypatch, tmp_path))

    assert f"{API_PREFIX}/threads" in paths
    assert f"{API_PREFIX}/admin/daemon-nodes" in paths
    assert f"{API_PREFIX}/admin/employees" in paths


def test_channel_routes_mount_when_enabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("RELAY_CHANNELS_ENABLED", "1")
    paths = _published_paths(_client(monkeypatch, tmp_path))

    assert f"{API_PREFIX}/admin/chat-integrations" in paths
    assert f"{API_PREFIX}/internal/chat/integrations/runtime" in paths


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, False),
        ("", False),
        ("0", False),
        ("off", False),
        ("1", True),
        ("true", True),
        (" ON ", True),
    ],
)
def test_channels_flag_is_off_unless_explicitly_enabled(
    monkeypatch: pytest.MonkeyPatch, value: str | None, expected: bool
) -> None:
    if value is None:
        monkeypatch.delenv("RELAY_CHANNELS_ENABLED", raising=False)
    else:
        monkeypatch.setenv("RELAY_CHANNELS_ENABLED", value)

    assert channels_enabled_from_env() is expected


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/internal/chat/identity/resolve", True),
        ("/admin/chat-integrations", True),
        ("/admin/chat-integrations/{integration_id}/audit", True),
        ("/admin/employees", False),
        ("/threads/{session_id}/messages", False),
    ],
)
def test_channel_route_classification(path: str, expected: bool) -> None:
    assert is_channel_route(path) is expected
