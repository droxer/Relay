"""Dispatch resolves the task workspace layout against the chosen node.

`TaskDispatcher._run_request` and the scheduler's dispatch request used to
hardcode `workspaceLayout: "project"` only when a project snapshot existed,
leaving every other task on the legacy per-thread directory. These tests
drive dispatch through the real HTTP surface (the same harness the existing
task-dispatch tests in `backend/tests/api/test_tasks.py` use) and assert on
the `run.start` command a daemon actually receives, so a regression here
would be caught the same way a daemon would see it: a wrong or missing
`workspaceLayout`/`workspaceSubpath` on the wire.
"""

from __future__ import annotations

import asyncio
from datetime import date
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.api.deps import AppContext
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.services.task_dispatch import start_task_on_ready_node


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


def _bootstrap_employee(client: TestClient, employee_id: str = "alice") -> None:
    response = client.post(
        "/api/v1/admin/employees",
        json={
            "employeeId": employee_id,
            "username": employee_id,
            "password": "userpass",
            "displayName": employee_id.title(),
        },
    )
    assert response.status_code == 201


def _login_employee(client: TestClient, employee_id: str = "alice") -> None:
    assert client.post("/api/v1/auth/logout").status_code == 200
    response = client.post(
        "/api/v1/auth/login",
        json={"username": employee_id, "password": "userpass"},
    )
    assert response.status_code == 200


def _register_node(
    app,
    node_id: str,
    *,
    capabilities: list[str],
    employee_id: str = "alice",
) -> dict:
    return app.state.registry.register(
        {
            "sandboxId": node_id,
            "employeeId": employee_id,
            "token": f"token_{node_id}",
            "workspacePath": f"/workspace/{employee_id}",
            "workspaceId": f"machine-{node_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": capabilities,
            "status": "ready",
        },
        "ui_token",
    )


def _agent(app, node: dict, *, employee_id: str = "alice") -> dict:
    agent = app.state.agent_store.create_agent(
        employee_id,
        {
            "displayName": "Task Agent",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    app.state.agent_placement_store.create_placement(agent, node["id"])
    return agent


def app_context_for(app) -> AppContext:
    """Build the same `AppContext` the HTTP routes get, from `app.state`.

    Lets a test call `start_task_on_ready_node` directly, skipping the
    `/tasks/{id}/runs` route's pre-dispatch legacy-agent materialization —
    needed to reach a `TaskDispatcher` code path the route would otherwise
    route around before it ever gets there.
    """
    state = app.state
    return AppContext(
        session_store=state.session_store,
        task_store=state.task_store,
        daemon_store=state.daemon_store,
        chat_store=state.chat_store,
        registry=state.registry,
        backend=state.backend,
        auth_store=state.auth_store,
        managed_node_store=state.managed_node_store,
        agent_store=state.agent_store,
        team_store=state.team_store,
        project_store=state.project_store,
        agent_placement_store=state.agent_placement_store,
        profile_image_store=state.profile_image_store,
        org_settings_store=state.org_settings_store,
        workspace_query_broker=state.workspace_query_broker,
        control_plane_notifier=state.control_plane_notifier,
        today=state.today,
    )


def _take_command(app, node: dict) -> dict:
    [command] = app.state.registry.take_commands(
        node["id"], f"token_{node['id']}"
    )
    return command


def test_dispatch_sends_the_task_layout_to_a_capable_node(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces"]
        )
        agent = _agent(app, node)

        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Write the report",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202, started.text

        command = _take_command(app, node)
        assert command["workspaceLayout"] == "task"
        assert command["workspaceSubpath"] == f"tasks/{task['id']}"


def test_dispatch_refuses_silent_workspace_downgrade(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(app, "sbx_alice", capabilities=["thread-workspaces"])
        agent = _agent(app, node)

        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Write the report",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202, started.text

        assert started.json()["dispatch"]["state"] == "queued"
        assert started.json()["dispatch"]["code"] == "workspace_unavailable"
        assert started.json()["session"] is None


def test_dispatch_resolves_the_layout_on_the_legacy_no_agent_record_branch(
    monkeypatch,
) -> None:
    """A task with `assignedAgent` but no `assignedAgentId` and no named
    agent record predates explicit agent assignment. `_resolve_node` falls
    back to `ready_node_for_task` for this shape (`agent_first` is False,
    since nothing in `run_assignments` carries an `agentId`), and that
    branch never lands a `daemonNodeId` on the assignment the way the
    team/project/agent-first branches do. `_run_request` must resolve the
    workspace layout against the node `_dispatch` already holds, not by
    re-deriving it from `run_assignments[0]["daemonNodeId"]` (absent here,
    which raised `KeyError`).

    Dispatching through `start_task_on_ready_node` directly (rather than the
    `/tasks/{id}/runs` HTTP route) is deliberate: the route pre-materializes
    a legacy `assignedAgent`-only task into a named agent record before ever
    reaching `TaskDispatcher`, which would mask the branch this test targets.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces"]
        )

        task = app.state.task_store.create_task(
            {
                "title": "Legacy task without a named agent",
                "assignedAgent": "codex",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "status": "assigned",
            }
        )
        ctx = app_context_for(app)
        actor = {"employeeId": "alice", "isAdmin": True}

        result = asyncio.run(
            start_task_on_ready_node(ctx, task, actor, assignments=None)
        )

        assert result is not None
        assert result.get("dispatch", {}).get("state") == "started"
        assert result.get("session") is not None

        command = _take_command(app, node)
        assert command["workspaceLayout"] == "task"
        assert command["workspaceSubpath"] == f"tasks/{task['id']}"


def test_project_task_keeps_the_project_workspace(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _bootstrap_employee(client)
        node = _register_node(
            app,
            "sbx_alice",
            capabilities=[
                "thread-workspaces",
                "task-workspaces",
                "project-workspaces",
            ],
        )
        lead = _agent(app, node)
        _login_employee(client)

        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Launch",
                "daemonNodeId": node["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]

        task = client.post(
            "/api/v1/tasks",
            json={"title": "Ship project", "projectId": project["id"]},
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202, started.text

        command = _take_command(app, node)
        assert command["workspaceLayout"] == "project"
        assert command["workspaceSubpath"] == project["workspaceSubpath"]


def test_routine_occurrence_dispatch_nests_under_its_routine(monkeypatch) -> None:
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
        node = _register_node(
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces"]
        )
        agent = _agent(app, node)

        routine = client.post(
            "/api/v1/tasks",
            json={
                "title": "Nightly",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "isRoutine": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "routineEnabled": True,
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})
        assert started.status_code == 202, started.text
        occurrence = started.json()["task"]
        assert occurrence["sourceRoutineId"] == routine["id"]

        command = _take_command(app, node)
        assert command["workspaceLayout"] == "task"
        assert (
            command["workspaceSubpath"]
            == f"tasks/{routine['id']}/{occurrence['id']}"
        )


def test_manual_dispatch_failure_records_retry_state(monkeypatch) -> None:
    """A failed manual dispatch persists retry state under the same rules as
    the scheduled path: count, deadline, real error code, and a safe message."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces"]
        )
        agent = _agent(app, node)

        async def failing_run(node_id, request):
            raise ValueError("capacity_exhausted: node is full")

        monkeypatch.setattr(app.state.backend, "run", failing_run)
        task = app.state.task_store.create_task(
            {
                "title": "Manual dispatch that fails",
                "assignedAgent": "codex",
                "assignedAgentId": agent["id"],
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "status": "assigned",
            }
        )
        ctx = app_context_for(app)
        actor = {"employeeId": "alice", "isAdmin": True}

        result = asyncio.run(
            start_task_on_ready_node(ctx, task, actor, assignments=None)
        )

        assert result is not None
        assert result["dispatch"]["state"] == "queued"
        assert result["dispatch"]["code"] == "capacity_exhausted"
        failed = app.state.task_store.get_task(task["id"])
        retry = failed["dispatchRetry"]
        assert retry["failureCount"] == 1
        assert retry["code"] == "capacity_exhausted"
        assert "capacity_exhausted: node is full" in retry["message"]
        assert retry["nextAttemptAt"]
        # A classified failure means the run was not accepted, so the claim
        # is released and the task is eligible again after the deadline.
        assert "dispatchClaim" not in failed


def test_manual_dispatch_ambiguous_failure_consumes_no_retry_budget(
    monkeypatch,
) -> None:
    """An unclassified failure may have been accepted by the daemon: the
    claim is retained and no retry event is recorded."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces"]
        )
        agent = _agent(app, node)

        async def failing_run(node_id, request):
            raise ValueError("connection reset")

        monkeypatch.setattr(app.state.backend, "run", failing_run)
        task = app.state.task_store.create_task(
            {
                "title": "Manual dispatch with unknown outcome",
                "assignedAgent": "codex",
                "assignedAgentId": agent["id"],
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "status": "assigned",
            }
        )
        ctx = app_context_for(app)
        actor = {"employeeId": "alice", "isAdmin": True}

        result = asyncio.run(
            start_task_on_ready_node(ctx, task, actor, assignments=None)
        )

        assert result is not None
        assert result["dispatch"]["state"] == "queued"
        assert result["dispatch"]["code"] == "dispatch_failed"
        failed = app.state.task_store.get_task(task["id"])
        assert failed["dispatchClaim"]["id"]
        assert "dispatchRetry" not in failed
        assert not [
            event
            for event in failed["events"]
            if event["type"] == "task.dispatch_retry"
        ]
