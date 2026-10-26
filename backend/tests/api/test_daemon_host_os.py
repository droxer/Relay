from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest

from relay.app import create_app
from user_ids import user_id

ALICE = user_id("alice")


def _register(app, **extra) -> None:
    app.state.registry.register(
        {
            **extra,
            "sandboxId": "node_a",
            "userId": ALICE,
            "token": "node_token",
            "workspacePath": "/workspace/alice",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["thread-workspaces"],
            "status": "ready",
        }
    )


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        yield create_app(root)


@pytest.mark.parametrize("host_os", ["macos", "linux", "windows"])
def test_registration_records_the_reported_host_os(app, host_os: str) -> None:
    _register(app, hostOs=host_os)

    assert app.state.registry.get("node_a")["hostOs"] == host_os


@pytest.mark.parametrize("host_os", ["darwin", "freebsd", 7, "", None])
def test_registration_drops_an_unknown_host_os(app, host_os) -> None:
    _register(app, hostOs=host_os)

    assert "hostOs" not in app.state.registry.get("node_a")


def test_a_daemon_that_reports_no_os_keeps_the_one_recorded(app) -> None:
    _register(app, hostOs="windows")
    _register(app)

    assert app.state.registry.get("node_a")["hostOs"] == "windows"


def test_a_newly_reported_os_replaces_the_recorded_one(app) -> None:
    _register(app, hostOs="linux")
    _register(app, hostOs="macos")

    assert app.state.registry.get("node_a")["hostOs"] == "macos"
