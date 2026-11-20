from __future__ import annotations


from fastapi.testclient import TestClient
from sqlalchemy import insert
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.persistence.daemon.rows import run_to_row
from relay.persistence.events import relay_event
from user_ids import user_id

ALICE = user_id("alice")
BOB = user_id("bob")


def _bootstrap(client: TestClient) -> None:
    assert (
        client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "email": "admin@example.com", "password": "kestrel-vault-7719"},
        ).status_code
        == 200
    )


def _agent(client: TestClient) -> dict:
    assert (
        client.post(
            "/api/v1/admin/accounts",
            json={"username": "alice", "email": "alice@example.com", "password": "userpass", "userId": "alice"},
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
            "capabilities": ["workspace-scope", "thread-workspaces"],
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

    assert client.post("/api/v1/auth/login", json={"username": "alice", "password": "userpass"}).status_code == 200
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

    assert client.post("/api/v1/auth/login", json={"username": "alice", "password": "userpass"}).status_code == 200
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

    assert client.post("/api/v1/auth/login", json={"username": "alice", "password": "userpass"}).status_code == 200
    response = client.get(f"/api/v1/workspace/brief?agentId={agent['id']}")

    assert response.status_code == 200, response.text
    sessions = response.json()["sessions"]
    assert len(sessions) == 10
    assert {session["id"] for session in sessions} == created_ids

    app.state.session_store.create_session({
        "workspacePath": "/workspace", "ownerUserId": ALICE, "taskGoal": "Unrelated work",
    })
    participated_id = app.state.session_store.create_session({
        "workspacePath": "/workspace", "ownerUserId": ALICE, "taskGoal": "Joined later",
    })["id"]
    app.state.session_store.append_event(participated_id, relay_event("agent.started", participated_id, {
        "runId": "joined-run", "agent": "codex", "logicalAgentId": agent["id"],
    }))

    def reject_snapshot_read(**_kwargs):
        raise AssertionError("Activities needs Thread row fields only")

    monkeypatch.setattr(app.state.session_store, "list_session_snapshots", reject_snapshot_read)
    activity_path = f"/api/v1/workspace/brief?view=activity&agentId={agent['id']}"
    activity = client.get(activity_path)
    assert activity.status_code == 200
    payload = activity.json()
    assert set(payload) == {"activeRuns", "sessions", "tasks"}
    assert {session["id"] for session in payload["sessions"]} == created_ids | {participated_id}
    assert next(session for session in payload["sessions"] if session["id"] == participated_id)["runCount"] == 1
    assert set(payload["sessions"][0]) == {"id", "title", "taskGoal", "status", "runCount", "updatedAt"}
    assert len(activity.content) < len(response.content) // 2
    assert activity.headers["cache-control"] == "private, no-cache"
    headers = {"If-None-Match": activity.headers["etag"]}
    assert client.get(activity_path, headers=headers).status_code == 304
    assert TestClient(app).get(activity_path, headers=headers).status_code == 401
    app.state.session_store.append_event(participated_id, relay_event("session.renamed", participated_id, {
        "title": "Renamed after revalidation",
    }))
    changed = client.get(activity_path, headers=headers)
    assert changed.status_code == 200
    assert changed.headers["etag"] != activity.headers["etag"]


def test_workspace_activity_reads_only_owned_active_runs_without_fleet_monitor(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap(client)
    agent = _agent(client)
    assert client.post("/api/v1/admin/accounts", json={
        "username": "bob", "email": "bob@example.com", "password": "userpass", "userId": "bob",
    }).status_code == 201
    owned = app.state.session_store.create_session({"ownerUserId": ALICE, "taskGoal": "Owned", "workspacePath": "/workspace"})
    other = app.state.session_store.create_session({"ownerUserId": BOB, "taskGoal": "Other", "workspacePath": "/workspace"})
    store = app.state.daemon_store
    with store.engine.begin() as conn:
        conn.execute(insert(store.runs), [run_to_row({
            "runId": run_id, "nodeId": "offline_node_alice", "sessionId": session["id"],
            "logicalAgentId": agent["id"], "agent": "codex", "taskGoal": session["taskGoal"],
            "status": "running", "startedAt": "2026-07-23T00:00:00Z",
        }) for run_id, session in (("owned", owned), ("other", other))])

    def reject_fleet_monitor():
        raise AssertionError("Activity should read scoped active runs directly")

    monkeypatch.setattr(app.state.registry, "monitor_nodes", reject_fleet_monitor)
    assert client.post("/api/v1/auth/login", json={"username": "alice", "password": "userpass"}).status_code == 200
    for scope in ("", f"&agentId={agent['id']}"):
        response = client.get(f"/api/v1/workspace/brief?view=activity{scope}")
        assert response.status_code == 200, response.text
        assert [run["sessionId"] for run in response.json()["activeRuns"]] == [owned["id"]]


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
            json={"username": "bob", "email": "bob@example.com", "password": "userpass", "userId": "bob"},
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
    assert bob.get(f"/api/v1/workspace/brief?view=activity&agentId={agent['id']}").status_code == 403


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

    assert client.post("/api/v1/auth/login", json={"username": "alice", "password": "userpass"}).status_code == 200
    response = client.get(f"/api/v1/workspace/brief?agentId={agent['id']}")

    assert response.status_code == 200, response.text
    assert [node["id"] for node in response.json()["nodes"]] == ["runtime_new"]
