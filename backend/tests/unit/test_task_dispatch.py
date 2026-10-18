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

from automation_helpers import WEEKLY_TRIGGERS

import asyncio
from datetime import date
from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from app_state_helpers import replace_app_context
from relay.api.deps import AppContext
from relay.app import create_app
from relay.services.task_dispatch import start_task_on_ready_node

from issue_projects import PROJECT_CAPABILITY, project_for
from user_ids import user_id as handle_user_id

# A routine's run is the one kind of work that dispatches outside a project.
ROUTINE_RUN = {"sourceRoutineId": "routine_nightly"}

ALICE = handle_user_id("alice")


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


def _bootstrap_user(client: TestClient, user_id: str = "alice") -> None:
    response = client.post(
        "/api/v1/admin/users",
        json={
            "userId": user_id,
            "username": user_id,
            "password": "userpass",
            "displayName": user_id.title(),
        },
    )
    assert response.status_code == 201


def _login_user(client: TestClient, user_id: str = "alice") -> None:
    assert client.post("/api/v1/auth/logout").status_code == 200
    response = client.post(
        "/api/v1/auth/login",
        json={"username": user_id, "password": "userpass"},
    )
    assert response.status_code == 200


def _register_node(
    app,
    node_id: str,
    *,
    capabilities: list[str],
    user_id: str = ALICE,
) -> dict:
    return app.state.registry.register(
        {
            "sandboxId": node_id,
            "userId": user_id,
            "token": f"token_{node_id}",
            "workspacePath": f"/workspace/{user_id}",
            "workspaceId": f"machine-{node_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": capabilities,
            "status": "ready",
        },
        "ui_token",
    )


def _agent(app, node: dict, *, user_id: str = ALICE) -> dict:
    agent = app.state.agent_store.create_agent(
        user_id,
        {
            "displayName": "Task Agent",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    app.state.agent_placement_store.create_placement(agent, node["id"])
    return agent


def app_context_for(app) -> AppContext:
    """The same `AppContext` the HTTP routes get (`app.state.context`).

    Lets a test call `start_task_on_ready_node` directly, skipping the
    `/tasks/{id}/runs` route's pre-dispatch legacy-agent materialization —
    needed to reach a `TaskDispatcher` code path the route would otherwise
    route around before it ever gets there.
    """
    context: AppContext = app.state.context
    return context


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

        # The per-task layout serves routine runs; other work runs in a project.
        task = app.state.task_store.create_task(
            {
                **ROUTINE_RUN,
                "title": "Write the report",
                "ownerUserId": ALICE,
                "assigneeUserId": ALICE,
                "assignedAgent": "codex",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            }
        )

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202, started.text

        command = _take_command(app, node)
        assert command["workspaceLayout"] == "task"
        assert command["workspaceSubpath"] == f"tasks/routine_nightly/{task['id']}"


def test_dispatch_refuses_silent_workspace_downgrade(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(app, "sbx_alice", capabilities=["thread-workspaces"])
        agent = _agent(app, node)

        # The per-task layout serves routine runs; other work runs in a project.
        task = app.state.task_store.create_task(
            {
                **ROUTINE_RUN,
                "title": "Write the report",
                "ownerUserId": ALICE,
                "assigneeUserId": ALICE,
                "assignedAgent": "codex",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            }
        )

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202, started.text

        assert started.json()["dispatch"]["state"] == "rejected"
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
                **ROUTINE_RUN,
                "title": "Legacy task without a named agent",
                "assignedAgent": "codex",
                "ownerUserId": ALICE,
                "assigneeUserId": ALICE,
                "status": "assigned",
            }
        )
        ctx = app_context_for(app)
        actor = {"userId": ALICE, "isAdmin": True}

        result = asyncio.run(
            start_task_on_ready_node(ctx, task, actor, assignments=None)
        )

        assert result is not None
        assert result.get("dispatch", {}).get("state") == "started"
        assert result.get("session") is not None

        command = _take_command(app, node)
        assert command["workspaceLayout"] == "task"
        assert command["workspaceSubpath"] == f"tasks/routine_nightly/{task['id']}"


def test_project_task_keeps_the_project_workspace(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _bootstrap_user(client)
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
        _login_user(client)

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
        # A project directory is the deliverable location: no `artifacts/`.
        assert command["artifactsDir"] is None
        assert command["workspaceSubpath"] == project["workspaceSubpath"]


def test_routine_occurrence_keeps_its_own_directory_on_an_older_daemon(monkeypatch) -> None:
    """Without `artifact-layout` every run would share one `artifacts/`, so the
    occurrence keeps the older per-run directory."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")

    class FixedDate(date):
        @classmethod
        def today(cls) -> date:
            return cls(2026, 6, 26)

    with TemporaryDirectory() as root:
        app = create_app(root)
        replace_app_context(app, today=FixedDate.today)
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
                "ownerUserId": ALICE,
                "assigneeUserId": ALICE,
                "assignedAgentId": agent["id"],
                "isRoutine": True,
                "routineState": "active",
                "routineTriggers": WEEKLY_TRIGGERS,
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
        assert command["artifactsDir"] == "artifacts"


def test_routine_occurrences_share_the_automation_directory_with_per_run_artifacts(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")

    class FixedDate(date):
        @classmethod
        def today(cls) -> date:
            return cls(2026, 6, 26)

    with TemporaryDirectory() as root:
        app = create_app(root)
        replace_app_context(app, today=FixedDate.today)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces", "artifact-layout"]
        )
        agent = _agent(app, node)

        routine = client.post(
            "/api/v1/tasks",
            json={
                "title": "Nightly",
                "ownerUserId": ALICE,
                "assigneeUserId": ALICE,
                "assignedAgentId": agent["id"],
                "isRoutine": True,
                "routineState": "active",
                "routineTriggers": WEEKLY_TRIGGERS,
            },
        ).json()

        started = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})
        assert started.status_code == 202, started.text
        occurrence = started.json()["task"]
        assert occurrence["sourceRoutineId"] == routine["id"]

        command = _take_command(app, node)
        assert command["workspaceLayout"] == "task"
        assert command["workspaceSubpath"] == f"tasks/{routine['id']}"
        assert command["artifactsDir"] == f"artifacts/{occurrence['id']}"
        record = client.get(f"/api/v1/tasks/{occurrence['id']}").json()
        assert record["workspaceArtifactsDir"] == f"artifacts/{occurrence['id']}"
        runs = client.get(f"/api/v1/tasks/{routine['id']}/runs").json()["runs"]
        assert [run["artifactsDir"] for run in runs] == [f"artifacts/{occurrence['id']}"]


def test_manual_dispatch_failure_blocks_until_manual_retry(monkeypatch) -> None:
    """Manual failures block under the same policy as scheduled failures."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces", PROJECT_CAPABILITY]
        )
        agent = _agent(app, node)
        project = project_for(app.state.project_store, ALICE, node, [agent["id"]])

        async def failing_run(node_id, request):
            raise ValueError("capacity_exhausted: node is full")

        monkeypatch.setattr(app.state.backend, "run", failing_run)
        task = app.state.task_store.create_task(
            {
                "title": "Manual dispatch that fails",
                "assignedAgent": "codex",
                "assignedAgentId": agent["id"],
                "ownerUserId": ALICE,
                "assigneeUserId": ALICE,
                "projectId": project["id"],
                "status": "assigned",
            }
        )
        ctx = app_context_for(app)
        actor = {"userId": ALICE, "isAdmin": True}

        result = asyncio.run(
            start_task_on_ready_node(ctx, task, actor, assignments=None)
        )

        assert result is not None
        assert result["dispatch"]["state"] == "rejected"
        assert result["dispatch"]["code"] == "capacity_exhausted"
        failed = app.state.task_store.get_task(task["id"])
        assert failed["status"] == "blocked"
        assert "dispatchRetry" not in failed
        assert "capacity_exhausted: node is full" in failed["blockerReason"]
        assert "manually" in failed["blockerReason"]
        # Known rejection releases the claim so an explicit retry can proceed.
        assert "dispatchClaim" not in failed


def test_unrecorded_dispatch_failure_reraises_the_original_error(monkeypatch) -> None:
    """A caller that records failures itself gets the backend's own error.

    The failure is finished in a worker thread (`run_in_threadpool`), where no
    exception is being handled, so a bare `raise` there surfaced as
    "RuntimeError: No active exception to reraise" instead of this error.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = _register_node(
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces", PROJECT_CAPABILITY]
        )
        agent = _agent(app, node)
        project = project_for(app.state.project_store, ALICE, node, [agent["id"]])

        async def failing_run(node_id, request):
            raise ValueError("capacity_exhausted: node is full")

        monkeypatch.setattr(app.state.backend, "run", failing_run)
        task = app.state.task_store.create_task(
            {
                "title": "Dispatch whose caller records the failure",
                "assignedAgent": "codex",
                "assignedAgentId": agent["id"],
                "ownerUserId": ALICE,
                "assigneeUserId": ALICE,
                "projectId": project["id"],
                "status": "assigned",
            }
        )
        ctx = app_context_for(app)
        actor = {"userId": ALICE, "isAdmin": True}

        with pytest.raises(ValueError, match="capacity_exhausted: node is full"):
            asyncio.run(
                start_task_on_ready_node(
                    ctx, task, actor, assignments=None, record_pending=False
                )
            )


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
            app, "sbx_alice", capabilities=["thread-workspaces", "task-workspaces", PROJECT_CAPABILITY]
        )
        agent = _agent(app, node)
        project = project_for(app.state.project_store, ALICE, node, [agent["id"]])

        async def failing_run(node_id, request):
            raise ValueError("connection reset")

        monkeypatch.setattr(app.state.backend, "run", failing_run)
        task = app.state.task_store.create_task(
            {
                "title": "Manual dispatch with unknown outcome",
                "assignedAgent": "codex",
                "assignedAgentId": agent["id"],
                "ownerUserId": ALICE,
                "assigneeUserId": ALICE,
                "projectId": project["id"],
                "status": "assigned",
            }
        )
        ctx = app_context_for(app)
        actor = {"userId": ALICE, "isAdmin": True}

        result = asyncio.run(
            start_task_on_ready_node(ctx, task, actor, assignments=None)
        )

        assert result is not None
        assert result["dispatch"]["state"] == "rejected"
        assert result["dispatch"]["code"] == "dispatch_failed"
        failed = app.state.task_store.get_task(task["id"])
        assert failed["dispatchClaim"]["id"]
        assert "dispatchRetry" not in failed
        assert not [
            event
            for event in failed["events"]
            if event["type"] == "task.dispatch_retry"
        ]
