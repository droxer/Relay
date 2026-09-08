from __future__ import annotations

import asyncio
import json
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from fastapi.testclient import TestClient
from relay.api import task_routes
from relay.app import create_app
from relay.core.computer_identity import computer_id


def _bootstrap(client: TestClient) -> None:
    assert (
        client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
        ).status_code
        == 200
    )


def _employee(client: TestClient, employee_id: str) -> None:
    assert (
        client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": employee_id,
                "username": employee_id,
                "password": "userpass",
                "displayName": employee_id.title(),
            },
        ).status_code
        == 201
    )


def _agent(
    client: TestClient,
    employee_id: str,
    name: str,
    executor: str,
    *,
    place: bool = True,
    role: str = "implementer",
) -> dict:
    # Give this employee's test computer a stable identity so agent creation
    # can find it. A pre-existing node (registered by the test itself, or by
    # an earlier _agent() call for the same employee) keeps its status and
    # gains this executor in its supported set; otherwise a fresh offline node
    # is registered so creation succeeds without silently auto-placing the
    # agent (that would make the placement below a duplicate).
    node_id = f"test_node_{employee_id}"
    existing_node = client.app.state.registry.get(node_id)
    # supportedAgents is a registration-payload field only; the registry
    # never persists it on the stored node record (it's folded into the
    # "agents" status dict and then dropped). Reading it back off
    # `existing_node` is always empty, so re-registering here would silently
    # forget every runtime a prior call had already made ready. Read the
    # runtimes this node is actually ready for instead.
    existing_ready = {
        kind
        for kind, status_value in (existing_node or {}).get("agents", {}).items()
        if status_value == "ready"
    }
    node = client.app.state.registry.register(
        {
            "sandboxId": node_id,
            "employeeId": employee_id,
            "workspaceId": f"machine-{employee_id}",
            "token": "node_token",
            "workspacePath": f"/workspace/{employee_id}",
            "protocolVersion": 1,
            "supportedAgents": sorted(existing_ready | {executor}),
            "capabilities": ["task-workspaces", "thread-workspaces"],
            "status": (existing_node or {}).get("status", "stopped"),
        }
    )
    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorEmployeeId": employee_id,
            "displayName": name,
            "executorKind": executor,
            "defaultRole": role,
            "computerId": computer_id(node),
        },
    )
    assert response.status_code == 201
    agent = response.json()["agent"]
    already_placed = client.app.state.agent_placement_store.list_placements(
        agent_id=agent["id"]
    )
    if place and not already_placed:
        client.app.state.agent_placement_store.create_placement(agent, node_id)
    return agent


def _login(client: TestClient, employee_id: str) -> None:
    client.post("/api/v1/auth/logout")
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"username": employee_id, "password": "userpass"},
        ).status_code
        == 200
    )


def test_admin_and_employee_manage_teams(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")

        created = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        )
        assert created.status_code == 201
        team = created.json()["team"]
        assert team["ownerEmployeeId"] == "alice"
        assert "employeeId" not in team
        assert "supervisorEmployeeId" not in team
        assert team["lead"]["displayName"] == "Lead"
        assert [member["availability"] for member in team["members"]] == [
            "offline",
            "offline",
        ]
        admin_renamed = client.patch(
            f"/api/v1/admin/teams/{team['id']}",
            json={
                "name": "Delivery admin",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
                "enabled": True,
            },
        )
        assert admin_renamed.status_code == 200
        assert admin_renamed.json()["team"]["name"] == "Delivery admin"

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        own = client.get("/api/v1/teams")
        assert own.status_code == 200
        assert own.json()["teams"][0]["id"] == team["id"]
        renamed = client.patch(
            f"/api/v1/teams/{team['id']}", json={"name": "Delivery crew"}
        )
        assert renamed.status_code == 200
        assert renamed.json()["team"]["name"] == "Delivery crew"


def test_legacy_supervisor_owned_team_can_be_assigned_to_task(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Legacy delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]

        snapshot_path = Path(root) / "teams" / team["id"] / "snapshot.json"
        legacy = json.loads(snapshot_path.read_text(encoding="utf-8"))
        legacy["supervisorEmployeeId"] = legacy.pop("ownerEmployeeId")
        snapshot_path.write_text(json.dumps(legacy), encoding="utf-8")

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Legacy team task",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        )

        assert created.status_code == 201, created.json()
        assert created.json()["assignedTeamId"] == team["id"]


def test_employee_team_routes_cannot_access_another_employee_team(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        _employee(client, "bob")
        bob_lead = _agent(client, "bob", "Bob lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "bob",
                "name": "Bob delivery",
                "leadAgentId": bob_lead["id"],
                "memberAgentIds": [bob_lead["id"]],
            },
        ).json()["team"]
        assert client.get(f"/api/v1/admin/teams/{team['id']}").status_code == 200

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        assert client.get("/api/v1/teams").json()["teams"] == []
        assert (
            client.patch(
                f"/api/v1/teams/{team['id']}", json={"name": "Stolen"}
            ).status_code
            == 403
        )
        assert client.delete(f"/api/v1/teams/{team['id']}").status_code == 403
        assert (
            client.get(f"/api/v1/workspace/brief?teamId={team['id']}").status_code
            == 403
        )


def test_employee_reads_team_profile_and_activity(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        team_task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Team task",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
                "status": "assigned",
            },
        ).json()
        individual_task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Individual task",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": lead["id"],
            },
        ).json()
        session = app.state.session_store.create_session(
            {
                "workspacePath": "/workspace/alice",
                "ownerEmployeeId": "alice",
                "ownerAgentId": lead["id"],
                "teamId": team["id"],
                "taskGoal": "Ship together",
            }
        )
        unrelated_session = app.state.session_store.create_session(
            {
                "workspacePath": "/workspace/alice",
                "ownerEmployeeId": "alice",
                "ownerAgentId": lead["id"],
                "taskGoal": "Work alone",
            }
        )
        monkeypatch.setattr(
            app.state.registry,
            "monitor_nodes",
            lambda: [
                {
                    "id": "node_alice",
                    "employeeId": "alice",
                    "activeRuns": [
                        {
                            "runId": "run_team",
                            "sessionId": session["id"],
                            "logicalAgentId": lead["id"],
                            "taskGoal": "Ship together",
                            "agent": "codex",
                            "startedAt": "2026-07-23T00:00:00Z",
                        },
                        {
                            "runId": "run_individual",
                            "sessionId": unrelated_session["id"],
                            "logicalAgentId": lead["id"],
                            "taskGoal": "Work alone",
                            "agent": "codex",
                            "startedAt": "2026-07-23T00:00:01Z",
                        },
                    ],
                }
            ],
        )
        app.state.session_store.create_artifact(
            session["id"],
            {
                "kind": "workspace_file",
                "title": "delivery.md",
                "body": "# Delivered",
                "agentId": lead["id"],
            },
        )

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        brief = client.get(f"/api/v1/workspace/brief?teamId={team['id']}")
        assert brief.status_code == 200
        payload = brief.json()
        assert payload["teamId"] == team["id"]
        assert [item["id"] for item in payload["sessions"]] == [session["id"]]
        assert [item["runId"] for item in payload["activeRuns"]] == ["run_team"]
        assert team_task["id"] in {item["id"] for item in payload["tasks"]}
        assert individual_task["id"] not in {item["id"] for item in payload["tasks"]}
        assert payload["metrics"]["artifactCount"] == 1
        assert client.get(f"/api/v1/teams/{team['id']}/artifacts").status_code == 404


def test_team_rejects_cross_supervisor_members_and_assignment_conflicts(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        _employee(client, "bob")
        alice = _agent(client, "alice", "Lead", "codex")
        bob = _agent(client, "bob", "Outsider", "claude")

        rejected = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Invalid",
                "leadAgentId": alice["id"],
                "memberAgentIds": [alice["id"], bob["id"]],
            },
        )
        assert rejected.status_code == 400
        assert rejected.json()["detail"] == "team_member_wrong_supervisor"

        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": alice["id"],
                "memberAgentIds": [alice["id"]],
            },
        ).json()["team"]
        conflict = client.post(
            "/api/v1/tasks",
            json={
                "title": "Conflicted",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": alice["id"],
                "assignedTeamId": team["id"],
            },
        )
        assert conflict.status_code == 400
        assert conflict.json()["detail"] == "task_agent_and_team_conflict"


def test_team_task_assignee_can_switch_to_one_of_their_agents(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "requester")
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Delegated delivery",
                "ownerEmployeeId": "requester",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        switched = client.patch(
            f"/api/v1/tasks/{task['id']}",
            json={"assignedAgentId": lead["id"], "assignedTeamId": None},
        )

        assert switched.status_code == 200
        updated = switched.json()
        assert updated["assignedAgentId"] == lead["id"]
        assert "assignedTeamId" not in updated
        assert updated["assigneeEmployeeId"] == "alice"

        reassigned_team = client.put(
            f"/api/v1/tasks/{task['id']}/assignment", json={"teamId": team["id"]}
        )
        assert reassigned_team.status_code == 200
        assert reassigned_team.json()["assignedTeamId"] == team["id"]

        reassigned_agent = client.put(
            f"/api/v1/tasks/{task['id']}/assignment", json={"agentId": lead["id"]}
        )
        assert reassigned_agent.status_code == 200
        assert reassigned_agent.json()["assignedAgentId"] == lead["id"]
        assert "assignedTeamId" not in reassigned_agent.json()


def test_admin_can_patch_owner_only_task_to_owners_team(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        legacy = app.state.task_store.create_task(
            {"title": "Owner-only task", "ownerEmployeeId": "alice"}
        )

        assigned = client.patch(
            f"/api/v1/tasks/{legacy['id']}", json={"assignedTeamId": team["id"]}
        )

        assert assigned.status_code == 200
        assert assigned.json()["assignedTeamId"] == team["id"]


def test_team_task_cannot_bypass_lead_routing_through_pickup(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Keep Team routing",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()

        pickup = client.post(
            f"/api/v1/tasks/{task['id']}/pickups", json={"agentId": lead["id"]}
        )

        assert pickup.status_code == 409
        assert pickup.json()["detail"] == "team_task_requires_team_start"
        unchanged = client.get(f"/api/v1/tasks/{task['id']}").json()
        assert unchanged["assignedTeamId"] == team["id"]
        assert "assignedAgentId" not in unchanged


def test_agent_pickup_thread_is_owned_by_the_task_assignee(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        _employee(client, "requester")
        app.state.registry.register(
            {
                "sandboxId": "test_node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        agent = _agent(client, "alice", "Builder", "codex")
        task = app.state.task_store.create_task(
            {
                "title": "Delegated pickup",
                "ownerEmployeeId": "requester",
                "assigneeEmployeeId": "alice",
            }
        )

        pickup = client.post(
            f"/api/v1/tasks/{task['id']}/pickups", json={"agentId": agent["id"]}
        )

        assert pickup.status_code == 202
        payload = pickup.json()
        assert payload["task"]["assigneeEmployeeId"] == "alice"
        assert payload["session"]["ownerEmployeeId"] == "alice"
        assert payload["session"]["ownerAgentId"] == agent["id"]
        duplicate = client.post(
            f"/api/v1/tasks/{task['id']}/pickups", json={"agentId": agent["id"]}
        )
        assert duplicate.status_code == 409
        assert duplicate.json()["detail"] == "task_not_dispatchable"


def test_task_owner_can_edit_delegated_team_task_without_reassigning_it(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        _employee(client, "requester")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Delegated work",
                "ownerEmployeeId": "requester",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "requester", "password": "userpass"},
            ).status_code
            == 200
        )

        edited = client.patch(
            f"/api/v1/tasks/{task['id']}",
            json={
                "title": "Delegated work clarified",
                "assignedAgentId": None,
                "assignedTeamId": team["id"],
            },
        )

        assert edited.status_code == 200
        assert edited.json()["title"] == "Delegated work clarified"
        assert edited.json()["assignedTeamId"] == team["id"]


def test_deleting_lead_agent_promotes_next_member(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]

        assert client.delete(f"/api/v1/admin/agents/{lead['id']}").status_code == 200

        updated = app.state.team_store.get_team(team["id"])
        assert updated["leadAgentId"] == support["id"]
        assert updated["memberAgentIds"] == [support["id"]]


def test_startup_repairs_team_members_deleted_by_an_older_runtime(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        deleted_lead = _agent(client, "alice", "Deleted lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Legacy delivery",
                "leadAgentId": deleted_lead["id"],
                "memberAgentIds": [deleted_lead["id"], support["id"]],
            },
        ).json()["team"]

        # Simulate historical data written by a runtime that deleted the agent
        # without removing its Team membership.
        app.state.agent_store.delete_agent(deleted_lead["id"])

        restarted = create_app(root)
        repaired = restarted.state.team_store.get_team(team["id"])

        assert repaired["leadAgentId"] == support["id"]
        assert repaired["memberAgentIds"] == [support["id"]]


def test_task_assigned_to_team_starts_all_members_lead_first_in_assignee_thread(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        _employee(client, "requester")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        for agent in (lead, support):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship with the team",
                "ownerEmployeeId": "requester",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()

        assert task["assignedTeamId"] == team["id"]
        assert "assignedAgentId" not in task
        started = client.post(
            f"/api/v1/tasks/{task['id']}/runs",
            json={"assignments": [{"agent": "pi"}]},
        )

        assert started.status_code == 202
        payload = started.json()
        assert payload["dispatch"]["state"] == "started"
        assert payload["session"]["teamId"] == team["id"]
        assert payload["session"]["ownerEmployeeId"] == "alice"
        assert payload["session"]["ownerAgentId"] == lead["id"]
        assert (
            client.get(f"/api/v1/threads/{payload['session']['id']}").json()["teamId"]
            == team["id"]
        )
        assert len(payload["session"]["agentRuns"]) == 1
        assert payload["session"]["agentRuns"][0]["logicalAgentId"] == lead["id"]
        [lead_command] = app.state.registry.take_commands("node_alice", "node_token")
        assert lead_command["logicalAgentId"] == lead["id"]
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": lead_command["id"],
                "sessionId": lead_command["sessionId"],
                "runId": lead_command["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "lead result",
            },
            "node_token",
        )
        [support_command] = app.state.registry.take_commands("node_alice", "node_token")
        assert support_command["logicalAgentId"] == support["id"]
        assert support_command["agent"] == "claude"


def test_team_task_start_has_no_execution_mode(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        for agent in (lead, support):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Reviewers",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Review with the team",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert started.status_code == 202
        [lead_command] = app.state.registry.take_commands("node_alice", "node_token")
        assert "mode" not in lead_command
        assert lead_command["logicalAgentId"] == lead["id"]
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": lead_command["id"],
                "sessionId": lead_command["sessionId"],
                "runId": lead_command["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "support review",
            },
            "node_token",
        )
        [support_command] = app.state.registry.take_commands("node_alice", "node_token")
        assert "mode" not in support_command
        assert support_command["logicalAgentId"] == support["id"]


def test_unroutable_team_start_requests_capacity_and_queues_scheduler_retry(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        # This test exercises the legacy phantom-placement attach path
        # (_attach_never_run_agent_to_managed_capacity in
        # relay/services/agent_routing.py): an agent with a placement that
        # has no computerId and points at a node that was never actually
        # registered, representing pre-Task-3 data or anything created by
        # writing directly to the store. computerId is optional at the
        # store layer (Task 1) — only the POST /admin/agents API layer
        # (create_agent_for_employee) requires one — so this fixture goes
        # straight to the store to construct that state, bypassing the API.
        lead = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Lead",
                "executorKind": "codex",
                "defaultRole": "implementer",
            },
        )
        app.state.agent_placement_store.create_placement(lead, "test_node_alice")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Wait for the lead",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        assert task["status"] == "backlog"

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert started.status_code == 202
        payload = started.json()
        assert payload["session"] is None
        assert payload["dispatch"]["state"] == "queued"
        assert payload["task"]["status"] == "assigned"
        assert payload["task"]["activity"][-1]["message"] == (
            "Managed node provisioning requested for alice."
        )
        [managed] = app.state.managed_node_store.list_nodes()
        assert managed["employeeId"] == "alice"
        assert client.get(f"/api/v1/tasks/{task['id']}").json()["status"] == "assigned"

        attempt = client.post(f"/api/v1/admin/managed-nodes/{managed['id']}/attempts")
        assert attempt.status_code == 201
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments",
            json={"workspacePath": "/workspace/alice"},
            headers={
                "Authorization": f"Enrollment {attempt.json()['enrollmentCredential']}"
            },
        )
        assert enrolled.status_code == 201
        runtime = enrolled.json()
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": runtime["sandboxId"],
                "token": runtime["token"],
                "workspacePath": "/workspace/alice",
                "sandboxMode": "boxlite",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
        )
        assert registered.status_code == 200

        tick = asyncio.run(app.state.task_scheduler.tick())

        assert tick.dispatched == 1
        commands = client.get(
            f"/api/v1/daemon-nodes/{runtime['sandboxId']}/commands",
            headers={"Authorization": f"Bearer {runtime['token']}"},
        ).json()["commands"]
        [command] = commands
        assert command["logicalAgentId"] == lead["id"]
        placements = app.state.agent_placement_store.list_placements(
            agent_id=lead["id"]
        )
        assert any(
            placement.get("computerId") == f"managed:{managed['id']}"
            for placement in placements
        )


def test_team_reviewer_reviews_the_leads_work_and_carries_its_role(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex", place=False, role="implementer")
        reviewer = _agent(
            client, "alice", "Reviewer", "claude", place=False, role="reviewer"
        )
        for agent in (lead, reviewer):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], reviewer["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Build it and check it",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert started.status_code == 202
        [lead_command] = app.state.registry.take_commands("node_alice", "node_token")
        assert lead_command["phase"] == "execution"
        assert lead_command["role"] == "implementer"
        assert lead_command["state"]["agent_role"] == "implementer"
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": lead_command["id"],
                "sessionId": lead_command["sessionId"],
                "runId": lead_command["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "built it",
            },
            "node_token",
        )

        [review_command] = app.state.registry.take_commands("node_alice", "node_token")
        # The role shapes the contribution without switching execution modes.
        assert review_command["phase"] == "review"
        assert review_command["role"] == "reviewer"
        assert review_command["state"]["agent_role"] == "reviewer"
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": review_command["id"],
                "sessionId": review_command["sessionId"],
                "runId": review_command["runId"],
                "agent": "claude",
                "exitCode": 0,
                "agentLog": "looks fine",
            },
            "node_token",
        )

        # The reviewer role contributes to the same adaptive round; the role
        # does not force a separate task mode or terminal status.
        assert client.get(f"/api/v1/tasks/{task['id']}").json()["status"] == "done"
        session = client.get(f"/api/v1/threads/{lead_command['sessionId']}").json()
        assert [run["role"] for run in session["agentRuns"]] == [
            "implementer",
            "reviewer",
        ]


def test_team_start_runs_on_the_placement_node_not_any_ready_node(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        # The team is placed here; the decoy below registers later and is
        # therefore the node a plain ready-node scan would hand back first.
        for node_id in ("node_alice_team", "node_alice_idle"):
            app.state.registry.register(
                {
                    "sandboxId": node_id,
                    "employeeId": "alice",
                    "token": f"{node_id}_token",
                    "workspacePath": f"/workspace/{node_id}",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex", "claude"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                }
            )
        lead = _agent(client, "alice", "Lead", "codex", place=False)
        support = _agent(client, "alice", "Support", "claude", place=False)
        for agent in (lead, support):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice_team"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship from the placement node",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert started.status_code == 202
        session = started.json()["session"]
        assert session["daemonNodeId"] == "node_alice_team"
        assert session["workspacePath"] == "/workspace/node_alice_team"
        assert (
            app.state.registry.take_commands("node_alice_idle", "node_alice_idle_token")
            == []
        )
        [command] = app.state.registry.take_commands(
            "node_alice_team", "node_alice_team_token"
        )
        assert command["logicalAgentId"] == lead["id"]


def test_start_on_a_running_team_task_leaves_its_status_alone(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex", place=False)
        assert (
            client.post(
                f"/api/v1/admin/agents/{lead['id']}/placements",
                json={"daemonNodeId": "node_alice"},
            ).status_code
            == 201
        )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Already under way",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        assert (
            client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()["dispatch"][
                "state"
            ]
            == "started"
        )
        assert client.get(f"/api/v1/tasks/{task['id']}").json()["status"] == "running"

        # Disabling the team makes resolution fail permanently; a second start
        # must not blocked-out a task whose run is still in flight.
        assert (
            client.patch(
                f"/api/v1/admin/teams/{team['id']}", json={"enabled": False}
            ).status_code
            == 200
        )
        again = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert again.status_code == 202
        assert again.json()["dispatch"]["state"] == "rejected"
        assert again.json()["dispatch"]["code"] == "invalid_state"
        assert client.get(f"/api/v1/tasks/{task['id']}").json()["status"] == "running"


def test_team_task_create_session_uses_assignee_lead_and_team_ownership(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        _employee(client, "requester")
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]

        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Create the Team thread",
                "ownerEmployeeId": "requester",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
                "createSession": True,
            },
        ).json()

        [session_id] = task["linkedSessionIds"]
        session = client.get(f"/api/v1/threads/{session_id}").json()
        assert session["teamId"] == team["id"]
        assert session["ownerEmployeeId"] == "alice"
        assert session["ownerAgentId"] == lead["id"]
        assert session["participants"] == ["human", "codex", "claude"]


def test_linked_session_uses_team_task_assignee_lead_and_team_ownership(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        _employee(client, "requester")
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Link a Team thread",
                "ownerEmployeeId": "requester",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()

        created = client.post(
            "/api/v1/threads",
            json={"taskGoal": "Link a Team thread", "taskId": task["id"]},
        )

        assert created.status_code == 201
        session = created.json()
        assert session["teamId"] == team["id"]
        assert session["ownerEmployeeId"] == "alice"
        assert session["ownerAgentId"] == lead["id"]
        assert session["participants"] == ["human", "codex", "claude"]


def test_manual_team_routine_start_creates_retryable_team_occurrence(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        routine = client.post(
            "/api/v1/tasks",
            json={
                "title": "Run the Team routine",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
                "isRoutine": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2099-01-01",
                "routineEnabled": True,
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})

        assert started.status_code == 202
        payload = started.json()
        assert payload["session"] is None
        occurrence = payload["task"]
        assert occurrence["id"] != routine["id"]
        assert occurrence["sourceRoutineId"] == routine["id"]
        assert occurrence["assignedTeamId"] == team["id"]
        assert occurrence["status"] == "assigned"
        refreshed = client.get(f"/api/v1/tasks/{routine['id']}").json()
        assert occurrence["id"] in refreshed["occurrenceIds"]
        [managed] = app.state.managed_node_store.list_nodes()
        assert managed["employeeId"] == "alice"


def test_manual_team_routine_start_reuses_occurrence_promoted_today(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")

    class FixedDate(date):
        @classmethod
        def today(cls) -> date:
            return cls(2026, 7, 23)

    monkeypatch.setattr(task_routes, "date", FixedDate)
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        assert (
            client.post(
                f"/api/v1/admin/agents/{lead['id']}/placements",
                json={"daemonNodeId": "node_alice"},
            ).status_code
            == 201
        )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        routine = client.post(
            "/api/v1/tasks",
            json={
                "title": "Run today's Team routine",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
                "isRoutine": True,
                "routineCadence": "daily",
                "routineNextRunDate": "2026-07-23",
                "routineEnabled": True,
            },
        ).json()
        promoted = app.state.task_store.promote_due_routine(
            routine["id"], "2026-07-23", "2026-07-24"
        )
        assert promoted is not None
        first_start = client.post(f"/api/v1/tasks/{promoted['id']}/runs", json={})
        assert first_start.status_code == 202
        assert first_start.json()["session"] is not None

        started = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})

        assert started.status_code == 202
        assert started.json()["task"]["id"] == promoted["id"]
        assert started.json()["session"]["id"] == first_start.json()["session"]["id"]
        assert started.json()["dispatch"] == {
            "state": "started",
            "code": "already_started",
        }
        refreshed = client.get(f"/api/v1/tasks/{routine['id']}").json()
        assert refreshed["occurrenceIds"] == [promoted["id"]]
        assert refreshed["linkedSessionIds"] == [first_start.json()["session"]["id"]]


def test_empty_team_cannot_create_a_task_thread_without_lead_ownership(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        assert client.delete(f"/api/v1/admin/agents/{lead['id']}").status_code == 200

        create_with_thread = client.post(
            "/api/v1/tasks",
            json={
                "title": "No lead thread",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
                "createSession": True,
            },
        )

        assert create_with_thread.status_code == 409
        assert create_with_thread.json()["detail"] == "team_invalid"

        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "No lead task",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        linked = client.post(
            "/api/v1/threads", json={"taskGoal": "No lead thread", "taskId": task["id"]}
        )
        assert linked.status_code == 409
        assert linked.json()["detail"] == "team_invalid"


def test_assign_endpoint_rejects_unavailable_team(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _employee(client, "alice")
        lead = _agent(client, "alice", "Lead", "codex")
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={"title": "Assignable", "assigneeEmployeeId": "alice"},
        ).json()

        assigned = client.put(
            f"/api/v1/tasks/{task['id']}/assignment", json={"teamId": team["id"]}
        )
        assert assigned.status_code == 200
        assert assigned.json()["assignedTeamId"] == team["id"]
        assert assigned.json()["status"] == "assigned"

        assert (
            client.patch(
                f"/api/v1/admin/teams/{team['id']}", json={"enabled": False}
            ).status_code
            == 200
        )
        rejected = client.put(
            f"/api/v1/tasks/{task['id']}/assignment", json={"teamId": team["id"]}
        )
        assert rejected.status_code == 409
        assert rejected.json()["detail"] == "team_disabled"


def test_message_to_a_team_thread_runs_every_member_lead_first(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex", role="reviewer")
        support = _agent(client, "alice", "Support", "claude")
        for agent in (lead, support):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship with the team",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        session_id = started.json()["session"]["id"]
        task_round = next(
            event
            for event in app.state.session_store.get_session(session_id)["events"]
            if event["type"] == "collaboration.round.started"
        )
        assert task_round["manifest"]["source"] == "task"
        assert task_round["manifest"]["strategy"] == "coordinate"
        assert all(
            assignment["assignmentId"]
            for assignment in task_round["manifest"]["assignments"]
        )
        first = app.state.registry.take_commands("node_alice", "node_token")[0]
        assert "mode" not in first
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": first["id"],
                "sessionId": session_id,
                "runId": first["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "lead result",
            },
            "node_token",
        )
        second = app.state.registry.take_commands("node_alice", "node_token")[0]
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": second["id"],
                "sessionId": session_id,
                "runId": second["runId"],
                "agent": "claude",
                "exitCode": 0,
                "agentLog": "support result",
            },
            "node_token",
        )

        answered = client.post(
            f"/api/v1/threads/{session_id}/messages",
            json={
                "text": "one more pass please",
                "intent": "accomplish",
                "idempotencyKey": "message_room_1",
            },
        )

        assert answered.status_code == 202
        [room_command] = app.state.registry.take_commands("node_alice", "node_token")
        assert room_command["logicalAgentId"] == lead["id"]
        request = (
            app.state.registry.daemon_store.active_run_request_for_session_any_node(
                session_id
            )
        )
        assert [item["agentId"] for item in request["assignments"]] == [
            lead["id"],
            support["id"],
        ]
        assert request["assignments"][0]["coordinator"] is True
        assert request["assignments"][0]["mode"] == "action"
        assert "adaptive" not in request["assignments"][0]
        assert request["assignments"][0]["phase"] == "execution"
        assert request["assignments"][0]["brief"]
        assert request["assignments"][0]["teamSnapshot"] == {
            "teamId": team["id"],
            "teamRevision": team["updatedAt"],
            "memberAgentIds": [lead["id"], support["id"]],
            "leadAgentId": lead["id"],
        }
        round_events = [
            event
            for event in app.state.session_store.get_session(session_id)["events"]
            if event["type"] == "collaboration.round.started"
            and event["manifest"]["source"] == "message"
        ]
        assert len(round_events) == 1
        manifest = round_events[0]["manifest"]
        assert room_command["delivery"] == {
            "type": "assignment-attempt",
            "attemptId": room_command["runId"],
            "collaborationId": manifest["collaborationId"],
            "roundId": manifest["roundId"],
            "assignmentId": manifest["assignments"][0]["assignmentId"],
            "workItemId": manifest["assignments"][0]["assignmentId"],
        }
        assert manifest["strategy"] == "coordinate"
        assert manifest["source"] == "message"
        assert manifest["teamSnapshot"] == request["assignments"][0]["teamSnapshot"]
        assert [item["assignmentId"] for item in manifest["assignments"]] == [
            item["assignmentId"] for item in request["assignments"]
        ]
        assert all(item["assignmentId"] for item in request["assignments"])
        assert (
            room_command["state"]["assignment_brief"]
            == (request["assignments"][0]["brief"])
        )
        assert room_command["state"]["team_phase"] == "execution"
        work_graph = manifest["workGraph"]
        assert [item["ownerAgentId"] for item in work_graph["items"]] == [
            lead["id"],
            support["id"],
        ]
        assert work_graph["items"][1]["delegationAuthority"] == "conductor"
        assert work_graph["items"][1]["dependsOnWorkItemIds"] == [
            work_graph["items"][0]["workItemId"]
        ]
        assert (
            room_command["state"]["work_item_id"]
            == work_graph["items"][0]["workItemId"]
        )
        assert room_command["state"]["depends_on_work_item_ids"] == []
        first_run = app.state.session_store.get_session(session_id)["agentRuns"][-1]
        assert first_run["dependsOnWorkItemIds"] == []
        assert first_run["teamPhase"] == "execution"
        assert "adaptive_execution" not in room_command["state"]


def test_message_to_a_team_thread_reports_a_disabled_team(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        assert (
            client.post(
                f"/api/v1/admin/agents/{lead['id']}/placements",
                json={"daemonNodeId": "node_alice"},
            ).status_code
            == 201
        )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship with the team",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        session_id = started.json()["session"]["id"]
        command = app.state.registry.take_commands("node_alice", "node_token")[0]
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": command["id"],
                "sessionId": session_id,
                "runId": command["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "done",
            },
            "node_token",
        )
        client.patch(f"/api/v1/admin/teams/{team['id']}", json={"enabled": False})

        answered = client.post(
            "/api/v1/agent-runs",
            json={"taskGoal": "another pass", "sessionId": session_id},
        )

        assert answered.status_code == 409
        assert answered.json()["detail"]["code"] == "team_disabled"


def test_explicit_assignment_to_a_disabled_team_requires_a_recovery_decision(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        assert (
            client.post(
                f"/api/v1/admin/agents/{lead['id']}/placements",
                json={"daemonNodeId": "node_alice"},
            ).status_code
            == 201
        )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship with the team",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        session_id = started.json()["session"]["id"]
        command = app.state.registry.take_commands("node_alice", "node_token")[0]
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": command["id"],
                "sessionId": session_id,
                "runId": command["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "done",
            },
            "node_token",
        )
        client.patch(f"/api/v1/admin/teams/{team['id']}", json={"enabled": False})

        answered = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "another pass",
                "sessionId": session_id,
                "assignments": [{"agentId": lead["id"]}],
            },
        )

        assert answered.status_code == 409
        assert answered.json()["detail"]["code"] == "team_disabled"

        recovered = client.post(
            f"/api/v1/threads/{session_id}/recoveries",
            json={
                "kind": "rerun",
                "targetAgentId": lead["id"],
                "mode": "action",
                "note": "try the same participant again",
            },
        )

        assert recovered.status_code == 202
        request = (
            app.state.registry.daemon_store.active_run_request_for_session_any_node(
                session_id
            )
        )
        assert [item["agentId"] for item in request["assignments"]] == [lead["id"]]
        recovery_round = [
            event
            for event in recovered.json()["events"]
            if event["type"] == "collaboration.round.started"
        ][-1]
        assert recovery_round["manifest"]["source"] == "recovery"
        assert recovery_round["manifest"]["address"] == {
            "kind": "members",
            "agentIds": [lead["id"]],
        }


def test_agent_runs_still_requires_an_assignment_for_a_solo_thread(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")

        refused = client.post("/api/v1/agent-runs", json={"taskGoal": "do something"})

        assert refused.status_code == 400


def test_agent_runs_creates_a_team_thread_from_a_team_id(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        for agent in (lead, support):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        _login(client, "alice")

        started = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "ship the release",
                "teamId": team["id"],
                "daemonNodeId": "node_alice",
            },
        )

        assert started.status_code == 202
        session = started.json()
        assert session["teamId"] == team["id"]
        assert session["ownerEmployeeId"] == "alice"
        request = (
            app.state.registry.daemon_store.active_run_request_for_session_any_node(
                session["id"]
            )
        )
        assert [item["agentId"] for item in request["assignments"]] == [
            lead["id"],
            support["id"],
        ]
        assert request["assignments"][0]["coordinator"] is True
        assert request["assignments"][0]["teamSnapshot"]["teamId"] == team["id"]
        [command] = app.state.registry.take_commands("node_alice", "node_token")
        assert command["logicalAgentId"] == lead["id"]


def test_agent_runs_rejects_a_team_id_that_does_not_match_the_thread(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        assert (
            client.post(
                f"/api/v1/admin/agents/{lead['id']}/placements",
                json={"daemonNodeId": "node_alice"},
            ).status_code
            == 201
        )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        _login(client, "alice")
        solo = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "solo thread",
                "assignments": [{"agentId": lead["id"]}],
            },
        )
        assert solo.status_code == 202

        mismatched = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "keep going",
                "sessionId": solo.json()["id"],
                "teamId": team["id"],
            },
        )

        assert mismatched.status_code == 400


def test_a_team_thread_refuses_an_assignment_outside_the_room(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        outsider = _agent(client, "alice", "Outsider", "claude")
        for agent in (lead, outsider):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship with the team",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        session_id = started.json()["session"]["id"]
        command = app.state.registry.take_commands("node_alice", "node_token")[0]
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": command["id"],
                "sessionId": session_id,
                "runId": command["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "done",
            },
            "node_token",
        )

        refused = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "you handle it",
                "sessionId": session_id,
                "assignments": [{"agentId": outsider["id"]}],
            },
        )

        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "agent_forbidden"


def test_a_team_thread_accepts_an_assignment_naming_one_member(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        for agent in (lead, support):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship with the team",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        session_id = started.json()["session"]["id"]
        for executor in ("codex", "claude"):
            command = app.state.registry.take_commands("node_alice", "node_token")[0]
            app.state.registry.handle_event(
                "node_alice",
                {
                    "type": "run.completed",
                    "commandId": command["id"],
                    "sessionId": session_id,
                    "runId": command["runId"],
                    "agent": executor,
                    "exitCode": 0,
                    "agentLog": "done",
                },
                "node_token",
            )

        answered = client.post(
            f"/api/v1/threads/{session_id}/messages",
            json={
                "text": "just you, Support",
                "intent": "accomplish",
                "addressAgentId": support["id"],
                "idempotencyKey": "message_support_1",
            },
        )

        assert answered.status_code == 202
        request = (
            app.state.registry.daemon_store.active_run_request_for_session_any_node(
                session_id
            )
        )
        assert [item["agentId"] for item in request["assignments"]] == [support["id"]]
        round_event = next(
            event
            for event in reversed(
                app.state.session_store.get_session(session_id)["events"]
            )
            if event["type"] == "collaboration.round.started"
        )
        assert round_event["manifest"]["strategy"] == "direct"
        assert round_event["manifest"]["address"] == {
            "kind": "members",
            "agentIds": [support["id"]],
        }


def test_message_to_a_team_thread_runs_every_member_as_the_owning_employee(
    monkeypatch,
) -> None:
    """Same expansion as the lead-first test above, but exercised as the
    non-admin employee who owns the team rather than as the bootstrap admin.

    `team_employee_id` in agent_routes.run_logical_agents takes the admin
    branch (`session.get("ownerEmployeeId")`) when the actor is an admin, and
    the employee branch (`actor["employeeId"]`) otherwise. Every other test in
    this module posts as admin, so only the admin branch had coverage; this
    proves the actual product path -- a non-admin actor continuing their own
    team thread -- still expands to every member.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        for agent in (lead, support):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship with the team",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        session_id = started.json()["session"]["id"]
        first = app.state.registry.take_commands("node_alice", "node_token")[0]
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": first["id"],
                "sessionId": session_id,
                "runId": first["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "lead result",
            },
            "node_token",
        )
        second = app.state.registry.take_commands("node_alice", "node_token")[0]
        app.state.registry.handle_event(
            "node_alice",
            {
                "type": "run.completed",
                "commandId": second["id"],
                "sessionId": session_id,
                "runId": second["runId"],
                "agent": "claude",
                "exitCode": 0,
                "agentLog": "support result",
            },
            "node_token",
        )

        _login(client, "alice")
        answered = client.post(
            "/api/v1/agent-runs",
            json={"taskGoal": "one more pass please", "sessionId": session_id},
        )

        assert answered.status_code == 202
        [room_command] = app.state.registry.take_commands("node_alice", "node_token")
        assert room_command["logicalAgentId"] == lead["id"]
        request = (
            app.state.registry.daemon_store.active_run_request_for_session_any_node(
                session_id
            )
        )
        assert [item["agentId"] for item in request["assignments"]] == [
            lead["id"],
            support["id"],
        ]


def test_a_team_thread_narrows_to_one_member_for_the_owning_employee(
    monkeypatch,
) -> None:
    """Same narrowing as the naming test above, but exercised as the
    non-admin employee who owns the team, so the employee branch of
    `team_employee_id` is exercised alongside an explicit assignment.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _employee(client, "alice")
        app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        lead = _agent(client, "alice", "Lead", "codex")
        support = _agent(client, "alice", "Support", "claude")
        for agent in (lead, support):
            assert (
                client.post(
                    f"/api/v1/admin/agents/{agent['id']}/placements",
                    json={"daemonNodeId": "node_alice"},
                ).status_code
                == 201
            )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": lead["id"],
                "memberAgentIds": [lead["id"], support["id"]],
            },
        ).json()["team"]
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship with the team",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedTeamId": team["id"],
            },
        ).json()
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        session_id = started.json()["session"]["id"]
        for executor in ("codex", "claude"):
            command = app.state.registry.take_commands("node_alice", "node_token")[0]
            app.state.registry.handle_event(
                "node_alice",
                {
                    "type": "run.completed",
                    "commandId": command["id"],
                    "sessionId": session_id,
                    "runId": command["runId"],
                    "agent": executor,
                    "exitCode": 0,
                    "agentLog": "done",
                },
                "node_token",
            )

        _login(client, "alice")
        answered = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "just you, Support",
                "sessionId": session_id,
                "assignments": [{"agentId": support["id"]}],
            },
        )

        assert answered.status_code == 202
        request = (
            app.state.registry.daemon_store.active_run_request_for_session_any_node(
                session_id
            )
        )
        assert [item["agentId"] for item in request["assignments"]] == [support["id"]]


@pytest.fixture
def recovery_team_thread(monkeypatch, tmp_path):
    from relay.sessions.controller import SessionController

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    _employee(client, "alice")
    lead = _agent(client, "alice", "Lead", "codex", role="planner")
    reviewer = _agent(client, "alice", "Reviewer", "codex", role="reviewer")
    app.state.registry.update_status("test_node_alice", {"status": "ready"})
    response = client.post(
        "/api/v1/admin/teams",
        json={
            "ownerEmployeeId": "alice",
            "name": "Delivery",
            "leadAgentId": lead["id"],
            "memberAgentIds": [lead["id"], reviewer["id"]],
        },
    )
    assert response.status_code == 201, response.text
    team = response.json()["team"]
    controller = SessionController(
        app.state.session_store,
        owner_employee_id="alice",
        owner_agent_id=lead["id"],
        team_id=team["id"],
        daemon_node_id="test_node_alice",
        workspace_layout="thread",
    )
    session = controller.create_session("Build a login page")
    return client, controller, session, team, reviewer


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("kind", ["handoff", "rerun"])
@pytest.mark.parametrize("followup", [False, True])
def test_recovery_dispatches_current_user_turn(
    recovery_team_thread, kind, followup, legacy
) -> None:
    client, controller, session, team, reviewer = recovery_team_thread
    expected = session["taskGoal"]
    if followup:
        controller.record_user_message(session["id"], "Add a signup form")
        expected = "Only fix the logout bug now"
        controller.record_user_message(session["id"], expected)
    controller.fail_session(session["id"], "Agent stopped before answering")
    client.patch(f"/api/v1/admin/teams/{team['id']}", json={"enabled": False})
    body = {
        "kind": kind,
        "targetAgentId": reviewer["id"],
        "idempotencyKey": "recover-1",
    }
    endpoint = f"/api/v1/threads/{session['id']}/recoveries"
    if legacy:
        endpoint = "/api/v1/agent-runs"
        body = {
            "sessionId": session["id"],
            "taskGoal": session["taskGoal"],
            "assignments": [{"agentId": reviewer["id"]}],
            "decision": {"kind": kind, "targetAgentId": reviewer["id"]},
            "idempotencyKey": "recover-1",
        }
    response = client.post(endpoint, json=body)
    assert response.status_code == 202, response.text
    command = client.app.state.registry.take_commands("test_node_alice", "node_token")[0]
    assert command["taskGoal"] == expected
    assert command["state"]["task_goal"] == expected
    assert command["state"]["agent_role"] == "reviewer"
    assert command["phase"] == "review"
    if followup:
        assert "Add a signup form" in command["state"]["prior_conversation"]
        assert expected not in command["state"]["prior_conversation"]
    replay = client.post(endpoint, json=body)
    assert replay.status_code == 202, replay.text
    assert len(replay.json()["agentRuns"]) == 1
    user_messages = [e for e in replay.json()["events"] if e["type"] == "user.message"]
    assert len(user_messages) == (2 if followup else 0)
    assert replay.json()["taskGoal"] == "Build a login page"


@pytest.mark.parametrize(
    "intent,phase",
    [("accomplish", "review"), ("discuss", "discussion"), ("review", "review")],
)
def test_addressed_team_reviewer_keeps_specialization(
    recovery_team_thread, intent, phase
) -> None:
    client, _controller, session, _team, reviewer = recovery_team_thread
    response = client.post(
        f"/api/v1/threads/{session['id']}/messages",
        json={"text": "@Reviewer inspect the change", "intent": intent},
    )
    assert response.status_code == 202, response.text
    command = client.app.state.registry.take_commands("test_node_alice", "node_token")[0]
    assert command["phase"] == phase
    assert command["state"]["agent_role"] == "reviewer"
    assert "Review the accumulated workspace changes" in command["state"]["assignment_brief"]
    request = (
        client.app.state.registry.daemon_store.active_run_request_for_session_any_node(
            session["id"]
        )
    )
    assert [a["agentId"] for a in request["assignments"]] == [reviewer["id"]]
