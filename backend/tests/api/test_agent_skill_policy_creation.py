from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    with TestClient(app) as client:
        assert (
            client.post(
                "/api/v1/auth/bootstrap",
                json={
                    "token": "admin_token",
                    "username": "admin",
                    "password": "kestrel-vault-7719",
                },
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                    "displayName": "Alice",
                },
            ).status_code
            == 201
        )
        node = app.state.registry.register(
            {
                "sandboxId": "skill-policy-node",
                "employeeId": "alice",
                "token": "node-token",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "status": "ready",
                "workspacePath": "/workspace/alice",
                "workspaceId": "alice-machine",
            }
        )
        client.post("/api/v1/auth/logout")
        assert (
            client.post(
                "/api/v1/auth/login",
                json={
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 200
        )
        yield client, computer_id(node)


@pytest.mark.parametrize("policy", [{}, {"version": 1, "grants": []}])
def test_public_agent_creation_rejects_provided_skill_policy(client, policy):
    http, machine = client
    response = http.post(
        "/api/v1/agents",
        json={
            "displayName": "Worker",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": machine,
            "skillPolicy": policy,
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Use skill grant routes to manage skillPolicy."


def test_admin_creation_rejects_skill_policy_but_default_creation_still_works(client):
    http, machine = client
    http.post("/api/v1/auth/logout")
    assert (
        http.post(
            "/api/v1/auth/login",
            json={
                "username": "admin",
                "password": "kestrel-vault-7719",
            },
        ).status_code
        == 200
    )
    body = {
        "supervisorEmployeeId": "alice",
        "displayName": "Worker",
        "executorKind": "codex",
        "defaultRole": "implementer",
        "computerId": machine,
    }
    rejected = http.post("/api/v1/admin/agents", json={**body, "skillPolicy": {}})
    assert rejected.status_code == 422
    assert rejected.json()["detail"] == "Use skill grant routes to manage skillPolicy."
    created = http.post("/api/v1/admin/agents", json=body)
    assert created.status_code == 201, created.text
    assert created.json()["agent"]["skillPolicy"] == {}
