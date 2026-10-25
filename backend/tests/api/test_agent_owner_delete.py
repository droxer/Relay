from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from user_ids import user_id

ALICE = user_id("alice")


def _bootstrap(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
    )
    assert response.status_code == 200
    for name in ("alice", "bob"):
        created = client.post(
            "/api/v1/admin/users",
            json={"userId": name, "username": name, "password": "userpass"},
        )
        assert created.status_code == 201, created.text


def _register_node(app) -> None:
    app.state.registry.register(
        {
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


def _create_agent(client: TestClient) -> dict:
    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorUserId": ALICE,
            "displayName": "Fixer",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": "node:node_a",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["agent"]


def _login(client: TestClient, username: str) -> None:
    assert client.post("/api/v1/auth/logout").status_code == 200
    login = client.post(
        "/api/v1/auth/login", json={"username": username, "password": "userpass"}
    )
    assert login.status_code == 200


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _register_node(app)
        yield app, client


def test_owner_deletes_their_own_agent_without_admin_access(env) -> None:
    app, client = env
    agent = _create_agent(client)
    _login(client, "alice")

    response = client.delete(f"/api/v1/agents/{agent['id']}")

    assert response.status_code == 200, response.text
    assert response.json()["agent"]["id"] == agent["id"]
    assert app.state.agent_store.get_agent(agent["id"]).get("deletedAt")
    listed = client.get("/api/v1/agents").json()["agents"]
    assert all(item["id"] != agent["id"] for item in listed)


def test_user_cannot_delete_another_users_agent(env) -> None:
    app, client = env
    agent = _create_agent(client)
    _login(client, "bob")

    response = client.delete(f"/api/v1/agents/{agent['id']}")

    assert response.status_code == 403
    assert not app.state.agent_store.get_agent(agent["id"]).get("deletedAt")


def test_deleting_a_missing_agent_answers_404(env) -> None:
    _app, client = env
    _login(client, "alice")

    assert client.delete("/api/v1/agents/agent_missing").status_code == 404


def test_owner_delete_refuses_an_agent_with_active_work(env, monkeypatch) -> None:
    app, client = env
    agent = _create_agent(client)
    _login(client, "alice")
    monkeypatch.setattr(
        app.state.registry.daemon_store,
        "list_active_run_requests",
        lambda: [{"assignments": [{"agentId": agent["id"]}]}],
    )

    response = client.delete(f"/api/v1/agents/{agent['id']}")

    assert response.status_code == 409
    assert not app.state.agent_store.get_agent(agent["id"]).get("deletedAt")
