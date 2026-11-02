"""Browser setup must identify the host before issuing its runtime credential."""
from __future__ import annotations

import pytest

from test_computer_limits import _client, _create_user, _login, _set_global_limit


def _authorize(client, machine_id: str | None, name: str = "Linux computer"):
    body = {"workspacePath": "/home/alice/work", "displayName": name}
    if machine_id is not None:
        body["workspaceId"] = machine_id
    started = client.post("/api/v1/computer-authorizations", json=body)
    assert started.status_code == 201, started.text
    grant = started.json()
    approved = client.post(f"/api/v1/computer-authorizations/{grant['userCode']}/approve")
    assert approved.status_code == 200, approved.text
    redeemed = client.post("/api/v1/computer-authorizations/token", headers={
        "Authorization": f"Device {grant['deviceCode']}"})
    assert redeemed.status_code == 200, redeemed.text
    return redeemed.json()


def _register(client, grant, machine_id):
    result = client.post("/api/v1/daemon-node-registrations", json={
        "sandboxId": grant["sandboxId"], "token": grant["token"],
        "workspaceId": machine_id, "workspacePath": grant["workspacePath"],
        "protocolVersion": 1, "supportedAgents": ["codex"], "status": "ready"})
    assert result.status_code == 200, result.text


@pytest.mark.parametrize("registered", [False, True])
@pytest.mark.parametrize("second_machine", ["desktop-id", None])
def test_same_path_on_another_host_does_not_revoke_first_host(monkeypatch, registered, second_machine):
    with _client(monkeypatch) as client:
        _create_user(client, "alice")
        _login(client, "alice")
        first = _authorize(client, "laptop-id", "Linux laptop")
        if registered:
            _register(client, first, "laptop-id")
        second = _authorize(client, second_machine, "Linux desktop")
        assert second["sandboxId"] != first["sandboxId"]
        check = client.get(f"/api/v1/daemon-nodes/{first['sandboxId']}/auth-check", headers={
            "Authorization": f"Bearer {first['token']}"})
        assert check.status_code == 200


def test_same_host_reauthorization_reuses_node_at_limit_after_restart(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from relay.app import create_app

    with _client(monkeypatch) as client:
        _set_global_limit(client, 1)
        _create_user(client, "alice")
        _login(client, "alice")
        first = _authorize(client, "laptop-id")
        _register(client, first, "laptop-id")
        # Use the same database with a new registry: reuse must not depend on memory.
        restarted = TestClient(create_app(str(tmp_path / "restarted")))
        _login(restarted, "alice")
        second = _authorize(restarted, "laptop-id")
        assert second["sandboxId"] == first["sandboxId"]


def test_another_host_cannot_bypass_computer_limit_with_same_path(monkeypatch):
    with _client(monkeypatch) as client:
        _set_global_limit(client, 1)
        _create_user(client, "alice")
        _login(client, "alice")
        first = _authorize(client, "laptop-id")
        _register(client, first, "laptop-id")
        grant = client.post("/api/v1/computer-authorizations", json={
            "workspacePath": first["workspacePath"], "displayName": "Desktop",
            "workspaceId": "desktop-id"}).json()
        result = client.post(f"/api/v1/computer-authorizations/{grant['userCode']}/approve")
        assert result.status_code == 409
        check = client.get(f"/api/v1/daemon-nodes/{first['sandboxId']}/auth-check", headers={
            "Authorization": f"Bearer {first['token']}"})
        assert check.status_code == 200


@pytest.mark.parametrize("identity", ["", "x" * 129, "bad\nidentity", 123])
def test_authorization_rejects_invalid_machine_identity(monkeypatch, identity):
    with _client(monkeypatch) as client:
        result = client.post("/api/v1/computer-authorizations", json={
            "workspacePath": "/home/alice/work", "displayName": "Laptop", "workspaceId": identity})
        assert result.status_code == 400
