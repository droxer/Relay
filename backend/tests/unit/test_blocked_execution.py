"""Dispatch failures explain themselves without overriding admitted work."""

import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest

from relay.daemon_registry import DaemonNodeRegistry, ServerDaemonNodeBackend
from relay.persistence.agent_placement_store import LocalAgentPlacementStore
from relay.persistence.agent_store import LocalAgentStore
from relay.persistence.daemon_store import LocalDaemonStore
from relay.persistence.project_store import DatabaseProjectStore
from relay.persistence.session_store import DatabaseSessionStore, LocalSessionStore
from relay.persistence.task_store import DatabaseTaskStore, LocalTaskStore
from relay.services.dispatch_retry import record_dispatch_retry
from relay.services.task_dispatch import start_task_on_ready_node
from relay.tasks import TaskScheduler


@pytest.fixture(params=["local", "database"])
def execution(tmp_path, request):
    tasks = (
        DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)
        if request.param == "database"
        else LocalTaskStore(tmp_path)
    )
    sessions = (
        DatabaseSessionStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)
        if request.param == "database"
        else LocalSessionStore(tmp_path)
    )
    registry = DaemonNodeRegistry(
        sessions, LocalDaemonStore(tmp_path), task_store=tasks
    )
    registry.register(
        {
            "sandboxId": "node",
            "employeeId": "alice",
            "token": "node_token",
            "workspacePath": "/workspace/alice",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["task-workspaces", "thread-workspaces"],
            "status": "ready",
        },
        "ui_token",
    )
    agents = LocalAgentStore(tmp_path)
    placements = LocalAgentPlacementStore(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node")
    backend = ServerDaemonNodeBackend(
        registry, employee_agent_store=agents, agent_placement_store=placements
    )
    task = tasks.create_task(
        {
            "title": "Deliver work",
            "assignedAgent": "codex",
            "assignedAgentId": agent["id"],
            "assigneeEmployeeId": "alice",
            "status": "assigned",
        }
    )
    ctx = SimpleNamespace(
        task_store=tasks,
        session_store=sessions,
        registry=registry,
        backend=backend,
        agent_store=agents,
        agent_placement_store=placements,
        team_store=None,
        project_store=None,
        managed_node_store=None,
    )
    return ctx, task, agent


def scheduler(ctx):
    return TaskScheduler(
        task_store=ctx.task_store,
        registry=ctx.registry,
        backend=ctx.backend,
        team_store=ctx.team_store,
        project_store=ctx.project_store,
    )


@pytest.mark.parametrize("source", ["manual", "scheduler"])
@pytest.mark.parametrize("assignment", ["team", "project"])
def test_missing_assignment_records_actionable_blocker(
    execution, tmp_path, source, assignment
):
    ctx, original, _ = execution
    # Keep only the task under test in the dispatch queue.
    ctx.task_store.update_task(original["id"], {"status": "backlog"})
    ctx.project_store = DatabaseProjectStore(
        f"sqlite:///{tmp_path}/projects.db", create_schema=True
    )
    field = "assignedTeamId" if assignment == "team" else "projectId"
    task = ctx.task_store.create_task(
        {
            "title": "Missing assignment",
            "status": "assigned",
            "assigneeEmployeeId": "alice",
            field: str(uuid4()),
        }
    )
    if source == "manual":
        asyncio.run(
            start_task_on_ready_node(
                ctx, task, {"employeeId": "alice", "isAdmin": False}
            )
        )
    else:
        asyncio.run(scheduler(ctx).tick())
    blocked = ctx.task_store.get_task(task["id"])
    assert blocked["status"] == "blocked"
    assert f"{assignment}_not_found" in blocked["blockerReason"]
    assert blocked["blockerReason"] == blocked["dispatchOutcome"]["message"]


@pytest.mark.parametrize("source", ["manual", "scheduler"])
def test_disabled_agent_records_actionable_blocker(execution, source):
    ctx, task, agent = execution
    ctx.agent_store.update_agent(agent["id"], {"enabled": False})
    if source == "manual":
        asyncio.run(
            start_task_on_ready_node(
                ctx, task, {"employeeId": "alice", "isAdmin": False}
            )
        )
    else:
        asyncio.run(scheduler(ctx).tick())
    blocked = ctx.task_store.get_task(task["id"])
    assert blocked["status"] == "blocked"
    assert blocked["blockerReason"] == "Agent Builder is disabled."
    assert blocked["blockerReason"] == blocked["dispatchOutcome"]["message"]


def test_retry_exhaustion_records_actionable_blocker(execution):
    ctx, task, _ = execution
    blocked = record_dispatch_retry(
        ctx.task_store,
        task,
        code="capacity_exhausted",
        message="Node is full",
        max_failures=1,
        sample=lambda: 0.5,
    )
    assert blocked["status"] == "blocked"
    assert "capacity_exhausted" in blocked["blockerReason"]
    assert "Node is full" in blocked["blockerReason"]


@pytest.mark.parametrize("admission", ["claim", "request"])
def test_scheduler_leaves_admitted_work_untouched(execution, admission):
    ctx, task, agent = execution
    if admission == "claim":
        ctx.task_store.claim_task_for_dispatch(task["id"], "codex")
    else:
        asyncio.run(
            start_task_on_ready_node(
                ctx, task, {"employeeId": "alice", "isAdmin": False}
            )
        )
        assert ctx.registry.daemon_store.active_run_request_for_task(task["id"])
    ctx.agent_store.update_agent(agent["id"], {"enabled": False})
    before = ctx.task_store.get_task(task["id"])
    result = asyncio.run(scheduler(ctx).tick())
    assert result.dispatched == 0
    assert ctx.task_store.get_task(task["id"]) == before


def test_scheduler_waits_for_daemon_execution_and_does_not_redispatch(execution):
    ctx, task, _ = execution
    runner = scheduler(ctx)
    assert asyncio.run(runner.tick()).dispatched == 1
    queued = ctx.task_store.get_task(task["id"])
    assert queued["status"] == queued["workflowStage"] == "assigned"
    [session_id] = queued["linkedSessionIds"]
    assert ctx.session_store.get_session(session_id)["agentRuns"] == []
    assert asyncio.run(runner.tick()).dispatched == 0
    [command] = ctx.registry.take_commands("node", "node_token")
    ctx.registry.handle_event(
        "node",
        {
            "type": "run.executing",
            "commandId": command["id"],
            "sessionId": command["sessionId"],
            "runId": command["runId"],
            "agent": command["agent"],
            **({"leaseId": command["leaseId"]} if command.get("leaseId") else {}),
        },
        "node_token",
    )
    running = ctx.task_store.get_task(task["id"])
    assert running["status"] == running["workflowStage"] == "running"
