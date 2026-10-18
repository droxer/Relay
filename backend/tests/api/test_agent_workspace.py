from __future__ import annotations


from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id
from user_ids import user_id

ALICE = user_id("alice")
BOB = user_id("bob")


def _bootstrap(client: TestClient) -> None:
    assert (
        client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
        ).status_code
        == 200
    )


def _agent(client: TestClient) -> dict:
    assert (
        client.post(
            "/api/v1/admin/accounts",
            json={"username": "alice", "password": "userpass", "userId": "alice"},
        ).status_code
        == 201
    )
    # An offline birth-certificate computer: enough to mint a computerId
    # without auto-placing the agent, so tests that build their own live
    # placement/node afterward see exactly the placements they create.
    node = client.app.state.registry.register(
        {
            "sandboxId": "offline_node_alice",
            "userId": ALICE,
            "workspaceId": "machine-alice",
            "token": "node_token",
            "workspacePath": "/workspace/alice",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["thread-workspaces"],
            "status": "stopped",
        }
    )
    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorUserId": ALICE,
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": computer_id(node),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["agent"]


def test_workspace_brief_accepts_legacy_agent_user_id(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap(client)
    agent = _agent(client)
    legacy_agent = {
        **agent,
        "userId": agent["supervisorUserId"],
    }
    legacy_agent.pop("supervisorUserId")
    get_agent = app.state.agent_store.get_agent
    monkeypatch.setattr(
        app.state.agent_store,
        "get_agent",
        lambda agent_id: (
            legacy_agent if agent_id == agent["id"] else get_agent(agent_id)
        ),
    )

    response = client.get(f"/api/v1/workspace/brief?agentId={agent['id']}")

    assert response.status_code == 200, response.text
    assert response.json()["userId"] == ALICE


def test_agent_workspace_brief_includes_owned_session_before_first_run(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap(client)
    agent = _agent(client)
    session = app.state.session_store.create_session(
        {
            "workspacePath": "/workspace",
            "ownerUserId": ALICE,
            "ownerAgentId": agent["id"],
            "taskGoal": "queued work",
        }
    )

    response = client.get(f"/api/v1/workspace/brief?agentId={agent['id']}")

    assert response.status_code == 200, response.text
    sessions = response.json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["id"] == session["id"]
    assert sessions[0]["ownerUserId"] == ALICE
    assert sessions[0]["ownerAgentId"] == agent["id"]
    assert sessions[0]["runCount"] == 0


def test_agent_workspace_brief_lists_every_thread_for_workspace_selection(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap(client)
    agent = _agent(client)
    created_ids = {
        app.state.session_store.create_session(
            {
                "workspacePath": "/workspace",
                "ownerUserId": ALICE,
                "ownerAgentId": agent["id"],
                "taskGoal": f"thread {index}",
            }
        )["id"]
        for index in range(10)
    }

    response = client.get(f"/api/v1/workspace/brief?agentId={agent['id']}")

    assert response.status_code == 200, response.text
    sessions = response.json()["sessions"]
    assert len(sessions) == 10
    assert {session["id"] for session in sessions} == created_ids


def test_agent_workspace_brief_uses_authorized_placements_for_user(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    admin = TestClient(app)
    _bootstrap(admin)
    agent = _agent(admin)
    assert (
        admin.post(
            "/api/v1/admin/accounts",
            json={"username": "bob", "password": "userpass", "userId": "bob"},
        ).status_code
        == 201
    )
    app.state.registry.register(
        {
            "sandboxId": "node_placed",
            "userId": BOB,
            "token": "placed_token",
            "nodeLocation": "user-device",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "status": "ready",
        }
    )
    app.state.registry.register(
        {
            "sandboxId": "node_same_user_unplaced",
            "userId": ALICE,
            "token": "unplaced_token",
            "nodeLocation": "user-device",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "status": "ready",
        }
    )
    app.state.agent_placement_store.create_placement(agent, "node_placed", {})

    alice = TestClient(app)
    assert (
        alice.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
        ).status_code
        == 200
    )
    response = alice.get(f"/api/v1/workspace/brief?agentId={agent['id']}")

    assert response.status_code == 200, response.text
    assert [node["id"] for node in response.json()["nodes"]] == ["node_placed"]

    bob = TestClient(app)
    assert (
        bob.post(
            "/api/v1/auth/login", json={"username": "bob", "password": "userpass"}
        ).status_code
        == 200
    )
    assert bob.get(f"/api/v1/workspace/brief?agentId={agent['id']}").status_code == 403


def test_agent_workspace_brief_follows_current_runtime_for_computer(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap(client)
    agent = _agent(client)
    app.state.registry.register(
        {
            "sandboxId": "runtime_old",
            "userId": ALICE,
            "workspaceId": "machine-1",
            "token": "old_token",
            "nodeLocation": "user-device",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "status": "ready",
        }
    )
    placed = client.post(
        f"/api/v1/admin/agents/{agent['id']}/placements",
        json={"daemonNodeId": "runtime_old"},
    )
    assert placed.status_code == 201, placed.text
    app.state.registry.delete("runtime_old")
    app.state.registry.register(
        {
            "sandboxId": "runtime_new",
            "userId": ALICE,
            "workspaceId": "machine-1",
            "token": "new_token",
            "nodeLocation": "user-device",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "status": "ready",
        }
    )

    response = client.get(f"/api/v1/workspace/brief?agentId={agent['id']}")

    assert response.status_code == 200, response.text
    assert [node["id"] for node in response.json()["nodes"]] == ["runtime_new"]
