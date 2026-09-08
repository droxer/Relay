from __future__ import annotations

import asyncio
from datetime import date
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from fastapi.testclient import TestClient
from relay.api import task_routes
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.services.task_dispatch import active_routine_occurrence


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={
            "token": "admin_token",
            "username": "admin",
            "password": "kestrel-vault-7719",
        },
    )
    assert response.status_code == 200


def _create_user(client: TestClient, username: str, *, employee_id: str) -> None:
    response = client.post(
        "/api/v1/admin/users",
        json={
            "username": username,
            "password": "userpass",
            "role": "user",
            "employeeId": employee_id,
        },
    )
    assert response.status_code == 201


def _login(client: TestClient, username: str, password: str = "userpass") -> None:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert response.status_code == 200


def _create_agent(
    client: TestClient,
    employee_id: str,
    *,
    executor_kind: str = "codex",
    node_id: str | None = None,
) -> dict:
    if node_id:
        # node_id names a node the caller already registered (usually
        # through the real registration route) — reuse its identity.
        node = client.app.state.registry.get(node_id)
        assert node is not None, f"node {node_id} must be registered first"
        target_computer_id = computer_id(node)
    else:
        # No explicit node: give this employee's test computer a stable,
        # offline identity so creation succeeds without auto-placing the
        # agent. Tests relying on "no ready node yet" behavior depend on
        # this staying offline (status "stopped").
        offline_node_id = f"offline_node_{employee_id}"
        existing = client.app.state.registry.get(offline_node_id)
        # supportedAgents is a registration-payload field only; the registry
        # never persists it on the stored node record (it's folded into the
        # "agents" status dict and then dropped). Reading it back off
        # `existing` is always empty, so re-registering here would silently
        # forget every runtime a prior call had already made ready. Read the
        # runtimes this node is actually ready for instead.
        existing_ready = {
            kind
            for kind, status_value in (existing or {}).get("agents", {}).items()
            if status_value == "ready"
        }
        node = client.app.state.registry.register(
            {
                "sandboxId": offline_node_id,
                "employeeId": employee_id,
                "workspaceId": f"machine-{employee_id}",
                "token": "node_token",
                "workspacePath": f"/workspace/{employee_id}",
                "protocolVersion": 1,
                "supportedAgents": sorted(existing_ready | {executor_kind}),
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "stopped",
            }
        )
        target_computer_id = computer_id(node)
    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorEmployeeId": employee_id,
            "displayName": f"{executor_kind.title()} Task Agent",
            "executorKind": executor_kind,
            "defaultRole": "implementer",
            "computerId": target_computer_id,
        },
    )
    assert response.status_code == 201
    agent = response.json()["agent"]
    already_placed = client.app.state.agent_placement_store.list_placements(
        agent_id=agent["id"]
    )
    if node_id and not already_placed:
        placement = client.post(
            f"/api/v1/admin/agents/{agent['id']}/placements",
            json={"daemonNodeId": node_id},
        )
        assert placement.status_code == 201
    return agent


def test_task_create_update_and_retired_claim_next(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship backlog",
                "description": "Add the task board.",
                "priority": "high",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "dueDate": "2026-06-30",
                "isRoutine": True,
                "routineType": "job",
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "routineEnabled": False,
            },
        )
        assert created.status_code == 201
        task = created.json()
        assert task["assigneeEmployeeId"] == "alice"
        assert task["dueDate"] == "2026-06-30"
        assert task["isRoutine"] is True
        assert task["routineType"] == "job"
        assert task["routineCadence"] == "weekly"
        assert task["routineNextRunDate"] == "2026-06-25"
        assert task["routineEnabled"] is False

        updated = client.patch(
            f"/api/v1/tasks/{task['id']}",
            json={
                "priority": "low",
                "assignedAgentId": agent["id"],
                "routineNextRunDate": "2026-07-02",
                "routineEnabled": False,
            },
        )
        assert updated.status_code == 200
        assert updated.json()["assignedAgent"] == "codex"
        assert updated.json()["status"] == "backlog"
        assert updated.json()["routineNextRunDate"] == "2026-07-02"
        assert updated.json()["routineEnabled"] is False

        skipped_routine = client.post(
            "/api/v1/tasks/claim-next",
            json={"agent": "codex", "assigneeEmployeeId": "alice"},
        )
        assert skipped_routine.status_code == 404

        normal = client.post(
            "/api/v1/tasks",
            json={
                "title": "Claim normal backlog",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            },
        )
        assert normal.status_code == 201

        claimed = client.post(
            "/api/v1/tasks/claim-next",
            json={"agent": "codex", "assigneeEmployeeId": "alice"},
        )
        assert claimed.status_code == 404
        assert (
            client.get(f"/api/v1/tasks/{normal.json()['id']}").json()["status"]
            == "assigned"
        )


def test_task_list_summary_view_is_compact_and_keeps_default_contract(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)

        created = client.post("/api/v1/tasks", json={"title": "Compact task"})
        assert created.status_code == 201
        task_id = created.json()["id"]
        updated = client.patch(
            f"/api/v1/tasks/{task_id}", json={"description": "Updated"}
        )
        assert updated.status_code == 200
        app.state.task_store.record_activity(task_id, "Summary activity")

        full_list = client.get("/api/v1/tasks?limit=1")
        assert full_list.status_code == 200
        full_task = full_list.json()["tasks"][0]
        assert full_task["id"] == task_id
        assert len(full_task["events"]) >= 2
        assert len(full_task["activity"]) == 1

        listed = client.get("/api/v1/tasks?view=summary&limit=1")
        assert listed.status_code == 200
        summary = listed.json()["tasks"][0]
        assert summary["id"] == task_id
        assert "events" not in summary
        assert "activity" not in summary
        assert summary["eventCount"] >= 2
        assert summary["activityCount"] == 1
        assert summary["lastActivity"]["message"] == "Summary activity"

        detail = client.get(f"/api/v1/tasks/{task_id}")
        assert detail.status_code == 200
        assert len(detail.json()["events"]) == summary["eventCount"]


def test_task_summary_view_without_limit_preserves_complete_list(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        observed: dict[str, object] = {}

        def list_task_summaries(*, employee_id=None, limit=None):
            observed.update(employee_id=employee_id, limit=limit)
            return []

        monkeypatch.setattr(
            app.state.task_store, "list_task_summaries", list_task_summaries
        )

        response = client.get("/api/v1/tasks?view=summary")

        assert response.status_code == 200
        assert observed == {"employee_id": None, "limit": None}


def test_routine_create_defaults_next_run_when_omitted(monkeypatch) -> None:
    class FixedDate(date):
        @classmethod
        def today(cls) -> date:
            return cls(2026, 7, 7)

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        app.state.today = FixedDate.today
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Daily routine",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "isRoutine": True,
                "routineCadence": "daily",
            },
        )

        assert created.status_code == 201
        task = created.json()
        assert task["routineNextRunDate"] == "2026-07-08"
        assert task["routineEnabled"] is False

        disabled = client.post(
            "/api/v1/tasks",
            json={
                "title": "Disabled weekly routine",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "isRoutine": True,
                "routineCadence": "weekly",
                "routineEnabled": False,
            },
        )

        assert disabled.status_code == 201
        assert disabled.json()["routineNextRunDate"] == "2026-07-14"
        assert disabled.json()["routineEnabled"] is False

        explicit_unscheduled = client.post(
            "/api/v1/tasks",
            json={
                "title": "Manual routine",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "isRoutine": True,
                "routineNextRunDate": "",
            },
        )

        assert explicit_unscheduled.status_code == 201
        assert "routineNextRunDate" not in explicit_unscheduled.json()


def test_routine_api_uses_the_scheduler_calendar(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        app.state.today = lambda: date(2026, 7, 7)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Timezone-aware routine",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "isRoutine": True,
                "routineCadence": "daily",
            },
        )

        assert created.status_code == 201
        assert created.json()["routineNextRunDate"] == "2026-07-08"


def test_manual_routine_start_uses_the_scheduler_calendar(monkeypatch) -> None:
    observed: dict[str, date] = {}

    async def dispatch(*args, run_date: date, **kwargs):
        observed["run_date"] = run_date

    monkeypatch.setattr(task_routes, "dispatch_routine_occurrence", dispatch)
    ctx = SimpleNamespace(today=lambda: date(2026, 7, 7))

    asyncio.run(
        task_routes.start_routine_occurrence_on_ready_node(ctx, {}, {}, agent=None)
    )

    assert observed["run_date"] == date(2026, 7, 7)


def test_routine_cadence_change_and_reenable_recalculate_next_run(monkeypatch) -> None:
    class FixedDate(date):
        @classmethod
        def today(cls) -> date:
            return cls(2026, 7, 7)

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        app.state.today = FixedDate.today
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Routine",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "isRoutine": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-01",
                "routineEnabled": False,
                "assignedAgentId": agent["id"],
            },
        )
        assert created.status_code == 201

        reenabled = client.patch(
            f"/api/v1/tasks/{created.json()['id']}",
            json={
                "routineEnabled": True,
                "routineNextRunDate": "2026-06-01",
            },
        )
        assert reenabled.status_code == 200
        assert reenabled.json()["routineNextRunDate"] == "2026-07-14"

        cadence_changed = client.patch(
            f"/api/v1/tasks/{created.json()['id']}",
            json={
                "routineCadence": "daily",
                "routineNextRunDate": "2026-07-14",
            },
        )
        assert cadence_changed.status_code == 200
        assert cadence_changed.json()["routineNextRunDate"] == "2026-07-08"

        title_changed = client.patch(
            f"/api/v1/tasks/{created.json()['id']}",
            json={
                "title": "Renamed routine",
            },
        )
        assert title_changed.status_code == 200
        assert title_changed.json()["routineNextRunDate"] == "2026-07-08"


def test_marking_task_done_completes_linked_running_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Write the report",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "createSession": True,
            },
        )
        assert created.status_code == 201
        task = created.json()
        [session_id] = task["linkedSessionIds"]

        session = client.get(f"/api/v1/threads/{session_id}")
        assert session.status_code == 200
        assert session.json()["status"] == "running"

        updated = client.patch(f"/api/v1/tasks/{task['id']}", json={"status": "done"})
        assert updated.status_code == 200
        assert updated.json()["status"] == "done"

        completed = client.get(f"/api/v1/threads/{session_id}")
        assert completed.status_code == 200
        body = completed.json()
        assert body["status"] == "completed"
        assert body["finalOutcome"] == "Task marked done."
        assert body["events"][-1]["type"] == "session.completed"


def test_assigned_backlog_waits_for_scheduler_and_start_can_dispatch_manually(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200

        agent = _create_agent(client, "alice", node_id="sbx_alice")
        assert (
            client.app.state.agent_placement_store.list_placements(agent_id=agent["id"])
            != []
        )

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Run from backlog",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            },
        )
        assert created.status_code == 201
        task = created.json()
        assert task["status"] == "assigned"
        assert task["linkedSessionIds"] == []

        pending_commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert pending_commands.status_code == 200
        assert pending_commands.json()["commands"] == []

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202
        assert started.json()["session"]["id"]
        assert started.json()["task"]["id"] == task["id"]
        assert started.json()["task"]["status"] == "running"
        assert started.json()["task"]["linkedSessionIds"] == [
            started.json()["session"]["id"]
        ]

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [command] = commands.json()["commands"]
        assert command["type"] == "run.start"
        assert command["logicalAgentId"] == agent["id"]
        assert command["agent"] == "codex"
        assert command["sessionId"] == started.json()["session"]["id"]
        assert command["taskGoal"] == "Run from backlog"


def test_task_start_uses_agent_selected_execution(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        agent = _create_agent(client, "alice", node_id="sbx_alice")
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Explain backlog",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
            },
        )
        assert created.status_code == 201

        started = client.post(f"/api/v1/tasks/{created.json()['id']}/runs", json={})
        assert started.status_code == 202

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [command] = commands.json()["commands"]
        assert command["agent"] == "codex"
        assert "mode" not in command
        assert command["state"]["task_goal"] == "Explain backlog"


def test_task_start_requests_managed_capacity_when_no_node_is_ready(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Provision before running",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert started.status_code == 202
        assert started.json()["session"] is None
        assert started.json()["task"]["activity"][-1]["message"] == (
            "Managed node provisioning requested for alice."
        )
        [managed] = app.state.managed_node_store.list_nodes()
        assert managed["employeeId"] == "alice"


def test_task_start_reports_restart_of_stopped_managed_capacity(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")
        managed = app.state.managed_node_store.create_node({"employeeId": "alice"})
        app.state.managed_node_store.update_node(
            managed["id"], {"desiredState": "stopped"}
        )
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Restart managed capacity",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert started.status_code == 202
        assert started.json()["task"]["activity"][-1]["message"] == (
            "Managed node provisioning requested for alice."
        )
        restarted = app.state.managed_node_store.get_node(managed["id"])
        assert restarted["desiredState"] == "running"
        assert restarted["phase"] == "requested"


def test_task_start_runs_multi_agent_adaptive_pipeline(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        claude_agent = _create_agent(
            client, "alice", executor_kind="claude", node_id="sbx_alice"
        )
        codex_agent = _create_agent(client, "alice", node_id="sbx_alice")
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Plan onboarding",
                "description": "Discuss rollout and implementation.",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
            },
        )
        assert created.status_code == 201

        started = client.post(
            f"/api/v1/tasks/{created.json()['id']}/runs",
            json={
                "assignments": [
                    {"agentId": claude_agent["id"], "agent": "claude"},
                    {"agentId": codex_agent["id"], "agent": "codex"},
                ],
            },
        )
        assert started.status_code == 202
        session_id = started.json()["session"]["id"]
        assert started.json()["task"]["linkedSessionIds"] == [session_id]
        assert started.json()["task"]["status"] == "running"

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [first] = commands.json()["commands"]
        assert first["agent"] == "claude"
        assert "mode" not in first
        assert (
            first["taskGoal"]
            == "Plan onboarding\n\nDiscuss rollout and implementation."
        )

        completed_first = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": first["id"],
                **({"leaseId": first["leaseId"]} if first.get("leaseId") else {}),
                "sessionId": first["sessionId"],
                "runId": first["runId"],
                "agent": "claude",
                "exitCode": 0,
                "agentLog": "Planner says define milestones.",
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed_first.status_code == 200

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [second] = commands.json()["commands"]
        assert second["agent"] == "codex"
        assert "mode" not in second
        assert "prior_agent_bridge" in second["state"]

        completed_second = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": second["id"],
                **({"leaseId": second["leaseId"]} if second.get("leaseId") else {}),
                "sessionId": second["sessionId"],
                "runId": second["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "Engineer says implementation is feasible.",
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed_second.status_code == 200

        task = client.get(f"/api/v1/tasks/{created.json()['id']}")
        assert task.status_code == 200
        assert task.json()["status"] == "done"
        assert task.json()["linkedSessionIds"] == [session_id]
        assert all(
            item["message"] != "Discussion started." for item in task.json()["activity"]
        )


def test_unclassified_task_without_assignment_uses_existing_ready_agents(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        # Simulate the control-plane provisioning record that authorizes this
        # daemon to register on Alice's behalf.
        provisioned = app.state.registry.register(
            {
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "nodeLocation": "employee-device",
                "protocolVersion": 1,
                "supportedAgents": [],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "stopped",
            },
            "ui_token",
            authorized_node_location="employee-device",
        )
        computer = computer_id(provisioned)
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        assert app.state.agent_store.list_agents(supervisor_employee_id="alice") == []
        named = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        assert named.status_code == 201, named.text
        reviewer = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Reviewer",
                "executorKind": "claude",
                "defaultRole": "reviewer",
                "computerId": computer,
            },
        )
        assert reviewer.status_code == 201, reviewer.text
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Design checkout recovery",
                "description": "Find the right implementation plan and risks.",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
            },
        )
        assert created.status_code == 201
        assert "assignedAgent" not in created.json()

        started = client.post(f"/api/v1/tasks/{created.json()['id']}/runs", json={})
        assert started.status_code == 202
        session = started.json()["session"]
        assert session is not None
        assert started.json()["task"]["linkedSessionIds"] == [session["id"]]
        # The first participant is admitted immediately; the remaining named
        # agents are admitted as the coordinated round advances.
        assert session["participantAgentIds"] == [named.json()["agent"]["id"]]

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [first] = commands.json()["commands"]
        assert first["logicalAgentId"] == named.json()["agent"]["id"]

        completed_first = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": first["id"],
                **({"leaseId": first["leaseId"]} if first.get("leaseId") else {}),
                "sessionId": first["sessionId"],
                "runId": first["runId"],
                "agent": first["agent"],
                "exitCode": 0,
                "agentLog": "Builder proposes the implementation.",
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed_first.status_code == 200, completed_first.text

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [second] = commands.json()["commands"]
        assert second["logicalAgentId"] == reviewer.json()["agent"]["id"]
        assert "prior_agent_bridge" in second["state"]

        completed_second = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": second["id"],
                **({"leaseId": second["leaseId"]} if second.get("leaseId") else {}),
                "sessionId": second["sessionId"],
                "runId": second["runId"],
                "agent": second["agent"],
                "exitCode": 0,
                "agentLog": "Reviewer accepts the implementation.",
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed_second.status_code == 200, completed_second.text
        finished = client.get(f"/api/v1/tasks/{created.json()['id']}")
        assert finished.status_code == 200
        assert finished.json()["status"] == "done"

        removed = client.delete(
            f"/api/v1/admin/agents/{reviewer.json()['agent']['id']}"
        )
        assert removed.status_code == 200, removed.text
        single = client.post(
            "/api/v1/tasks",
            json={
                "title": "Run with the one remaining named agent",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
            },
        )
        assert single.status_code == 201, single.text
        single_started = client.post(
            f"/api/v1/tasks/{single.json()['id']}/runs", json={}
        )
        assert single_started.status_code == 202, single_started.text
        assert single_started.json()["session"] is not None
        single_commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert single_commands.status_code == 200
        [single_command] = single_commands.json()["commands"]
        assert single_command["logicalAgentId"] == named.json()["agent"]["id"]


def test_agent_selected_review_work_uses_normal_task_completion(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        agent = _create_agent(client, "alice", node_id="sbx_alice")
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Audit the release",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
            },
        )
        assert created.status_code == 201

        started = client.post(
            f"/api/v1/tasks/{created.json()['id']}/runs",
            json={
                "assignments": [{"agentId": agent["id"], "agent": "codex"}],
            },
        )
        assert started.status_code == 202

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [command] = commands.json()["commands"]
        assert "mode" not in command

        completed = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": command["id"],
                **({"leaseId": command["leaseId"]} if command.get("leaseId") else {}),
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "Review passed with notes.",
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed.status_code == 200

        task = client.get(f"/api/v1/tasks/{created.json()['id']}")
        assert task.status_code == 200
        assert task.json()["status"] == "done"


def test_agentless_routine_cannot_start_as_team_discussion(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")

    class FixedDate(date):
        @classmethod
        def today(cls) -> date:
            return cls(2026, 6, 26)

    with TemporaryDirectory() as root:
        app = create_app(root)
        app.state.today = FixedDate.today
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Weekly retro",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "isRoutine": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "routineEnabled": False,
            },
        )
        assert created.status_code == 201

        started = client.post(
            f"/api/v1/tasks/{created.json()['id']}/runs",
            json={
                "assignments": [
                    {"agent": "claude"},
                    {"agent": "codex"},
                ],
            },
        )
        assert started.status_code == 202
        assert started.json()["session"] is None
        assert started.json()["dispatch"]["state"] == "rejected"
        assert started.json()["dispatch"]["code"] == "agent_not_found"


def test_scheduler_dispatches_assigned_backlog_task(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        agent = _create_agent(client, "alice", node_id="sbx_alice")

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Scheduled backlog",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            },
        )
        assert created.status_code == 201
        assert created.json()["status"] == "assigned"

        result = asyncio.run(app.state.task_scheduler.tick())
        assert result.dispatched == 1
        updated = client.get(f"/api/v1/tasks/{created.json()['id']}")
        assert updated.status_code == 200
        assert updated.json()["status"] == "running"
        assert updated.json()["linkedSessionIds"]

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [command] = commands.json()["commands"]
        assert command["type"] == "run.start"
        assert command["agent"] == "codex"
        assert command["sessionId"] == updated.json()["linkedSessionIds"][0]
        assert command["taskGoal"] == "Scheduled backlog"


def test_routine_start_dispatches_occurrence_not_definition(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")

    class FixedDate(date):
        @classmethod
        def today(cls) -> date:
            return cls(2026, 6, 26)

    with TemporaryDirectory() as root:
        app = create_app(root)
        app.state.today = FixedDate.today
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        agent = _create_agent(client, "alice", node_id="sbx_alice")

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Weekly report",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "isRoutine": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "routineEnabled": True,
            },
        )
        assert created.status_code == 201
        task = created.json()
        assert task["isRoutine"] is True
        assert task["status"] == "backlog"
        assert task["linkedSessionIds"] == []

        start = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert start.status_code == 202
        assert start.json()["session"]["id"]
        occurrence = start.json()["task"]
        assert occurrence["id"] != task["id"]
        assert occurrence["isRoutine"] is False
        assert occurrence["status"] == "running"
        assert occurrence["dueDate"] == "2026-06-25"
        assert occurrence["sourceRoutineId"] == task["id"]
        assert occurrence["scheduledFor"] == "2026-06-25"

        updated_definition = client.get(f"/api/v1/tasks/{task['id']}").json()
        assert updated_definition["status"] == "backlog"
        assert updated_definition["routineNextRunDate"] == "2026-07-02"
        assert updated_definition["occurrenceIds"] == [occurrence["id"]]
        assert updated_definition["linkedSessionIds"] == [start.json()["session"]["id"]]

        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [command] = commands.json()["commands"]
        assert command["type"] == "run.start"
        assert command["agent"] == "codex"
        assert command["sessionId"] == start.json()["session"]["id"]
        assert command["taskGoal"] == "Weekly report"


def test_routine_start_reuses_an_open_overdue_occurrence(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Retry queued report",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "isRoutine": True,
                "routineCadence": "daily",
                "routineNextRunDate": "2020-01-01",
                "routineEnabled": True,
            },
        )
        assert created.status_code == 201

        promoted = asyncio.run(app.state.task_scheduler.tick())
        assert promoted.promoted == 1
        definition = client.get(f"/api/v1/tasks/{created.json()['id']}").json()
        [occurrence_id] = definition["occurrenceIds"]
        assert app.state.task_store.get_task(occurrence_id)["status"] == "assigned"

        started = client.post(f"/api/v1/tasks/{definition['id']}/runs", json={})

        assert started.status_code == 202
        assert started.json()["task"]["id"] == occurrence_id
        app.state.task_store.update_task(occurrence_id, {"status": "review"})
        assert (
            active_routine_occurrence(
                app.state.task_store,
                app.state.task_store.get_task(definition["id"]),
            )["id"]
            == occurrence_id
        )

        repeated = client.post(f"/api/v1/tasks/{definition['id']}/runs", json={})

        assert repeated.status_code == 202
        assert repeated.json()["task"]["id"] == occurrence_id
        assert repeated.json()["dispatch"]["code"] == "already_active"
        refreshed = client.get(f"/api/v1/tasks/{definition['id']}").json()
        assert refreshed["occurrenceIds"] == [occurrence_id]


def test_routine_start_reuses_the_occurrence_assignment_snapshot(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        original_agent = _create_agent(
            client, "alice", executor_kind="codex", node_id="sbx_alice"
        )
        replacement_agent = _create_agent(
            client, "alice", executor_kind="claude", node_id="sbx_alice"
        )
        routine = client.post(
            "/api/v1/tasks",
            json={
                "title": "Stable assignment report",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": original_agent["id"],
                "isRoutine": True,
                "routineCadence": "daily",
                "routineNextRunDate": "2020-01-01",
                "routineEnabled": True,
            },
        ).json()
        occurrence = app.state.task_store.promote_due_routine(
            routine["id"], "2026-08-30", "2026-08-31"
        )
        assert occurrence and occurrence["assignedAgentId"] == original_agent["id"]
        reassigned = client.patch(
            f"/api/v1/tasks/{routine['id']}",
            json={"assignedAgentId": replacement_agent["id"]},
        )
        assert reassigned.status_code == 200

        started = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})

        assert started.status_code == 202, started.text
        assert started.json()["task"]["id"] == occurrence["id"]
        assert started.json()["task"]["assignedAgentId"] == original_agent["id"]
        [command] = app.state.registry.take_commands("sbx_alice", "node_token")
        assert command["logicalAgentId"] == original_agent["id"]
        assert command["agent"] == "codex"


def test_claimed_task_rejects_status_and_assignment_updates(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        first = _create_agent(client, "alice", executor_kind="codex")
        second = _create_agent(client, "alice", executor_kind="claude")

        for patch in ({"status": "done"}, {"assignedAgentId": second["id"]}):
            task = client.post(
                "/api/v1/tasks",
                json={
                    "title": "Claimed task",
                    "assigneeEmployeeId": "alice",
                    "assignedAgentId": first["id"],
                    "status": "assigned",
                },
            ).json()
            claimed = client.app.state.task_store.claim_task_for_dispatch(
                task["id"], "codex"
            )
            assert claimed is not None

            updated = client.patch(f"/api/v1/tasks/{task['id']}", json=patch)

            assert updated.status_code == 409
            assert updated.json()["detail"] == "task_execution_active"
            unchanged = client.get(f"/api/v1/tasks/{task['id']}").json()
            assert unchanged["status"] == "assigned"
            assert unchanged["assignedAgentId"] == first["id"]


def test_claimed_task_rejects_pickup_assignment_update(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        first = _create_agent(client, "alice", executor_kind="codex")
        second = _create_agent(client, "alice", executor_kind="claude")
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Claimed pickup",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": first["id"],
                "status": "assigned",
            },
        ).json()
        claimed = client.app.state.task_store.claim_task_for_dispatch(
            task["id"], "codex"
        )
        assert claimed is not None

        response = client.post(
            f"/api/v1/tasks/{task['id']}/pickups",
            json={"agentId": second["id"]},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "task_execution_active"
        unchanged = client.get(f"/api/v1/tasks/{task['id']}").json()
        assert unchanged["assignedAgentId"] == first["id"]
        assert unchanged["dispatchClaim"] == claimed["dispatchClaim"]


def test_claimed_task_allows_metadata_update(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice", executor_kind="codex")
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Original title",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            },
        ).json()
        claimed = client.app.state.task_store.claim_task_for_dispatch(
            task["id"], "codex"
        )
        assert claimed is not None

        response = client.patch(
            f"/api/v1/tasks/{task['id']}",
            json={"title": "Updated title", "priority": "high"},
        )

        assert response.status_code == 200, response.text
        assert response.json()["title"] == "Updated title"
        assert response.json()["priority"] == "high"
        assert response.json()["dispatchClaim"] == claimed["dispatchClaim"]


def test_assigned_task_rejects_run_assignment_override(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        assigned = _create_agent(
            client, "alice", executor_kind="codex", node_id="sbx_alice"
        )
        override = _create_agent(
            client, "alice", executor_kind="claude", node_id="sbx_alice"
        )
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Use the assigned agent",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": assigned["id"],
                "status": "assigned",
            },
        ).json()

        started = client.post(
            f"/api/v1/tasks/{task['id']}/runs",
            json={"assignments": [{"agentId": override["id"]}]},
        )

        assert started.status_code == 409
        assert started.json()["detail"] == "task_assignment_override"
        commands = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        assert commands.json()["commands"] == []


def test_task_rejects_invalid_due_date(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        response = client.post(
            "/api/v1/tasks", json={"title": "Bad date", "dueDate": "06/30/2026"}
        )

        assert response.status_code == 400
        assert "YYYY-MM-DD" in response.json()["detail"]

        invalid_status = client.post(
            "/api/v1/tasks", json={"title": "Bad status", "status": "queued-ish"}
        )
        assert invalid_status.status_code == 400

        assigned_without_agent = client.post(
            "/api/v1/tasks", json={"title": "Missing agent", "status": "assigned"}
        )
        assert assigned_without_agent.status_code == 400


def test_task_rejects_invalid_routine_fields(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")

        invalid_type = client.post(
            "/api/v1/tasks",
            json={"title": "Bad routine", "isRoutine": True, "routineType": "cron"},
        )
        assert invalid_type.status_code == 400
        assert "routineType" in invalid_type.json()["detail"]

        invalid_cadence = client.post(
            "/api/v1/tasks",
            json={
                "title": "Bad cadence",
                "isRoutine": True,
                "routineCadence": "hourly",
            },
        )
        assert invalid_cadence.status_code == 400
        assert "routineCadence" in invalid_cadence.json()["detail"]

        invalid_date = client.post(
            "/api/v1/tasks",
            json={
                "title": "Bad next run",
                "isRoutine": True,
                "routineNextRunDate": "06/30/2026",
            },
        )
        assert invalid_date.status_code == 400
        assert "YYYY-MM-DD" in invalid_date.json()["detail"]

        invalid_enabled = client.post(
            "/api/v1/tasks",
            json={"title": "Bad enabled", "isRoutine": True, "routineEnabled": "yes"},
        )
        assert invalid_enabled.status_code == 400
        assert "routineEnabled" in invalid_enabled.json()["detail"]

        enabled_custom_without_date = client.post(
            "/api/v1/tasks",
            json={
                "title": "Never scheduled",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "isRoutine": True,
                "routineCadence": "custom",
                "routineEnabled": True,
                "routineNextRunDate": "",
            },
        )
        assert enabled_custom_without_date.status_code == 400
        assert "routineNextRunDate" in enabled_custom_without_date.json()["detail"]


def test_clearing_an_assigned_task_returns_it_to_backlog(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Requeue me",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            },
        ).json()

        cleared = client.patch(
            f"/api/v1/tasks/{task['id']}",
            json={
                "status": "assigned",
                "assignedAgentId": None,
                "assignedTeamId": None,
            },
        )

        assert cleared.status_code == 200
        assert cleared.json()["status"] == "backlog"
        assert "assignedAgent" not in cleared.json()
        assert "assignedAgentId" not in cleared.json()
        assert "assignedTeamId" not in cleared.json()


def test_retrying_blocked_task_revalidates_unchanged_team(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        task = client.post("/api/v1/tasks", json={"title": "Retry stale team"}).json()
        missing_team_id = "bfb532f7-c185-404c-8648-18188433b9a5"
        client.app.state.task_store.set_task_team_assignment(
            task["id"], missing_team_id
        )
        client.app.state.task_store.update_task(task["id"], {"status": "blocked"})

        retried = client.patch(
            f"/api/v1/tasks/{task['id']}",
            json={"assignedTeamId": missing_team_id, "status": "assigned"},
        )

        assert retried.status_code == 404
        assert retried.json()["detail"] == "Team not found."
        unchanged = client.get(f"/api/v1/tasks/{task['id']}").json()
        assert unchanged["status"] == "blocked"


def test_active_task_assignment_cannot_change(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        first = _create_agent(client, "alice", executor_kind="codex")
        second = _create_agent(client, "alice", executor_kind="claude")
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Already running",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": first["id"],
                "createSession": True,
            },
        ).json()
        session_id = task["linkedSessionIds"][0]
        client.app.state.session_store.append_event(
            session_id,
            {
                "id": "20000000-0000-4000-8000-000000000001",
                "type": "session.status",
                "sessionId": session_id,
                "timestamp": "2026-07-30T00:00:00.000Z",
                "status": "running",
                "phase": "assigned",
            },
        )

        reassigned = client.patch(
            f"/api/v1/tasks/{task['id']}",
            json={"assignedAgentId": second["id"]},
        )

        assert reassigned.status_code == 409
        assert reassigned.json()["detail"] == "task_execution_active"
        unchanged = client.get(f"/api/v1/tasks/{task['id']}").json()
        assert unchanged["assignedAgentId"] == first["id"]


def test_pickup_rejects_terminal_tasks_without_creating_a_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Already done",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "status": "done",
            },
        ).json()

        pickup = client.post(
            f"/api/v1/tasks/{task['id']}/pickups",
            json={"agentId": agent["id"]},
        )

        assert pickup.status_code == 409
        assert pickup.json()["detail"] == "task_not_dispatchable"
        assert (
            client.get(f"/api/v1/tasks/{task['id']}").json()["linkedSessionIds"] == []
        )


def test_task_delete_hides_task_from_list_and_get(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Delete me",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "isRoutine": True,
                "routineType": "task",
                "routineCadence": "daily",
                "routineEnabled": False,
            },
        )
        assert created.status_code == 201
        task_id = created.json()["id"]

        deleted = client.delete(f"/api/v1/tasks/{task_id}")
        assert deleted.status_code == 200
        assert deleted.json()["outcome"] == "deleted"
        assert deleted.json()["task"]["deletedAt"]
        assert deleted.json()["task"]["deletedByEmployeeId"] == "admin"

        again = client.delete(f"/api/v1/tasks/{task_id}")
        assert again.status_code == 200
        assert again.json()["outcome"] == "already_deleted"
        assert again.json()["task"]["deletedAt"] == deleted.json()["task"]["deletedAt"]

        listed = client.get("/api/v1/tasks")
        assert listed.status_code == 200
        assert all(task["id"] != task_id for task in listed.json()["tasks"])
        assert client.get(f"/api/v1/tasks/{task_id}").status_code == 404

        missing = client.delete("/api/v1/tasks/11111111-1111-4111-8111-111111111111")
        assert missing.status_code == 404


def test_task_delete_requires_owner_or_admin(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        _create_user(client, "bob", employee_id="bob")
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Owned by Alice",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "bob",
            },
        ).json()

        _login(client, "bob")
        forbidden = client.delete(f"/api/v1/tasks/{task['id']}")
        assert forbidden.status_code == 403
        assert forbidden.json()["detail"] == "task_delete_forbidden"

        _login(client, "alice")
        deleted = client.delete(f"/api/v1/tasks/{task['id']}")
        assert deleted.status_code == 200
        assert deleted.json()["outcome"] == "deleted"
        assert deleted.json()["task"]["deletedByEmployeeId"] == "alice"


def test_task_delete_rejects_active_dispatch_and_linked_thread(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        agent = _create_agent(client, "alice")
        dispatching = client.post(
            "/api/v1/tasks",
            json={
                "title": "Dispatching",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            },
        ).json()
        claimed = client.app.state.task_store.claim_task_for_dispatch(
            dispatching["id"], "codex"
        )
        assert claimed is not None

        claim_delete = client.delete(f"/api/v1/tasks/{dispatching['id']}")
        assert claim_delete.status_code == 409
        assert claim_delete.json()["detail"] == "task_execution_active"

        running = client.post(
            "/api/v1/tasks",
            json={
                "title": "Already running",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
            },
        ).json()
        session = client.app.state.session_store.create_session(
            {
                "workspacePath": root,
                "taskGoal": "Run linked work",
                "participants": ["human", "codex"],
                "ownerEmployeeId": "alice",
            }
        )
        client.app.state.task_store.link_session(running["id"], session["id"])

        session_delete = client.delete(f"/api/v1/tasks/{running['id']}")
        assert session_delete.status_code == 409
        assert session_delete.json()["detail"] == "task_execution_active"


def test_blocked_dispatch_reports_the_recorded_failure_not_progress(
    monkeypatch,
) -> None:
    """A held claim after a failed dispatch must not read as work in progress.

    An unclassified failure keeps its claim on purpose, so the retry used to be
    told "dispatch in progress" for a dispatch that had already failed and
    created no thread — sending the operator looking for a thread that does not
    exist. The recorded outcome is what they need instead.
    """
    from relay.services.task_dispatch import _unclaimable_dispatch

    failed = {
        "status": "assigned",
        "isRoutine": False,
        "dispatchOutcome": {
            "state": "queued",
            "code": "agent_offline",
            "message": "Agent Black Panther has no eligible runtime placement.",
        },
    }
    blocked = _unclaimable_dispatch(failed, "claude")
    assert blocked["code"] == "agent_offline"
    assert "no thread was created" in blocked["message"]
    assert "Black Panther" in blocked["message"]

    running = {"status": "assigned", "isRoutine": False}
    assert _unclaimable_dispatch(running, "claude")["code"] == "dispatch_in_progress"

    routine = {"status": "assigned", "isRoutine": True}
    assert (
        _unclaimable_dispatch(routine, "claude")["code"] == "routine_not_dispatchable"
    )

    mismatched = {"status": "assigned", "isRoutine": False, "assignedAgent": "codex"}
    assert _unclaimable_dispatch(mismatched, "claude")["code"] == "agent_mismatch"

    backlog = {"status": "backlog", "isRoutine": False}
    assert _unclaimable_dispatch(backlog, "claude")["code"] == "task_not_assigned"
