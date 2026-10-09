from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app


def _bootstrap(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
    )
    assert response.status_code == 200
    assert (
        client.post(
            "/api/v1/admin/employees",
            json={"employeeId": "alice", "username": "alice", "password": "userpass"},
        ).status_code
        == 201
    )


def _register_node(app, capabilities: list[str], **extra) -> None:
    app.state.registry.register(
        {
            **extra,
            "sandboxId": "node_a",
            "employeeId": "alice",
            "token": "node_token",
            "workspacePath": "/workspace/alice",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["thread-workspaces", *capabilities],
            "status": "ready",
        }
    )


def _create_agent(client: TestClient, **extra) -> dict:
    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorEmployeeId": "alice",
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": "node:node_a",
            **extra,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["agent"]


def _login_alice(client: TestClient) -> None:
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert (
        client.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
        ).status_code
        == 200
    )


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        yield app, client


def test_agent_is_created_with_a_pinned_model(env) -> None:
    app, client = env
    _register_node(app, ["agent-model"])

    agent = _create_agent(client, modelPolicy={"model": " gpt-5.1-codex "})

    assert agent["modelPolicy"] == {"model": "gpt-5.1-codex"}


def test_invalid_model_is_rejected_at_creation(env) -> None:
    app, client = env
    _register_node(app, ["agent-model"])

    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorEmployeeId": "alice",
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": "node:node_a",
            "modelPolicy": {"model": "gpt; whoami"},
        },
    )

    assert response.status_code == 400
    assert "may only contain" in response.json()["detail"]


def test_owner_changes_and_clears_the_model(env) -> None:
    app, client = env
    _register_node(app, ["agent-model"])
    agent = _create_agent(client)
    _login_alice(client)

    pinned = client.patch(
        f"/api/v1/agents/{agent['id']}", json={"modelPolicy": {"model": "gpt-5"}}
    )
    assert pinned.status_code == 200
    assert pinned.json()["agent"]["modelPolicy"] == {"model": "gpt-5"}

    cleared = client.patch(f"/api/v1/agents/{agent['id']}", json={"modelPolicy": {}})
    assert cleared.status_code == 200
    assert cleared.json()["agent"]["modelPolicy"] == {}


def test_dispatch_passes_the_pinned_model_to_the_daemon(env) -> None:
    app, client = env
    _register_node(app, ["agent-model"])
    agent = _create_agent(client, modelPolicy={"model": "gpt-5.1-codex"})
    _login_alice(client)

    response = client.post(
        "/api/v1/agent-runs",
        json={"taskGoal": "Build it", "assignments": [{"agentId": agent["id"]}]},
    )

    assert response.status_code == 202, response.text
    commands = app.state.daemon_store.take_queued_commands("node_a")
    assert len(commands) == 1
    assert commands[0]["command"]["state"]["agent_model"] == "gpt-5.1-codex"


def test_agent_without_a_model_sends_none(env) -> None:
    app, client = env
    _register_node(app, ["agent-model"])
    agent = _create_agent(client)
    _login_alice(client)

    response = client.post(
        "/api/v1/agent-runs",
        json={"taskGoal": "Build it", "assignments": [{"agentId": agent["id"]}]},
    )

    assert response.status_code == 202, response.text
    commands = app.state.daemon_store.take_queued_commands("node_a")
    assert "agent_model" not in commands[0]["command"]["state"]


def test_daemon_without_model_support_fails_the_run_instead_of_ignoring_it(
    env,
) -> None:
    app, client = env
    _register_node(app, [])
    agent = _create_agent(client, modelPolicy={"model": "gpt-5.1-codex"})
    _login_alice(client)

    response = client.post(
        "/api/v1/agent-runs",
        json={"taskGoal": "Build it", "assignments": [{"agentId": agent["id"]}]},
    )

    assert app.state.daemon_store.take_queued_commands("node_a") == []
    session = response.json()
    assert session["status"] == "failed"
    failure = next(e for e in session["events"] if e["type"] == "session.failed")
    assert "cannot select models" in failure["outcome"]


def test_computer_list_reports_whether_the_daemon_can_select_models(env) -> None:
    app, client = env
    _register_node(app, ["agent-model"])

    sandboxes = client.get("/api/v1/sandboxes").json()["sandboxes"]

    node = next(item for item in sandboxes if item["id"] == "node_a")
    assert "agent-model" in node["capabilities"]


@pytest.mark.parametrize(
    ("capabilities", "expected"), [(["agent-model"], True), ([], False)]
)
def test_agent_reports_whether_its_daemon_can_select_models(
    env, capabilities: list[str], expected: bool
) -> None:
    app, client = env
    _register_node(app, capabilities)
    agent = _create_agent(client)

    record = client.get(f"/api/v1/admin/agents/{agent['id']}").json()["agent"]

    assert record["canSelectModel"] is expected


@pytest.mark.parametrize(
    ("endpoints", "expected"),
    [(["codex"], True), (["claude"], False), ([], False), ("codex", False)],
)
def test_agent_reports_whether_its_runtime_calls_a_custom_model_endpoint(
    env, endpoints, expected: bool
) -> None:
    app, client = env
    _register_node(app, ["agent-model"], customModelEndpoints=endpoints)
    agent = _create_agent(client)

    record = client.get(f"/api/v1/admin/agents/{agent['id']}").json()["agent"]

    assert record["customModelEndpoint"] is expected


def test_registration_keeps_only_known_runtimes_as_custom_endpoints(env) -> None:
    app, _client = env
    _register_node(
        app, ["agent-model"], customModelEndpoints=["codex", "gpt", 7, "claude"]
    )

    node = app.state.registry.get("node_a")

    assert node["customModelEndpoints"] == ["claude", "codex"]
