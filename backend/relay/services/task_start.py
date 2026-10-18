"""Starting a task by hand: who runs it, and the dispatch that follows.

``prepare_task_start`` either refuses (``TaskRequestError``), answers a
recorded dispatch outcome (a dict), or returns ``(task, agent, assignments)``
for ``start_prepared_task`` to dispatch.
"""
from __future__ import annotations

from typing import Any

from starlette.concurrency import run_in_threadpool

from ..automations.service import request_manual_occurrence
from ..persistence.stores import valid_agent
from .task_dispatch import (
    DispatchResult,
    implicit_group_assignments_for_task,
    start_task_on_ready_node,
)
from .task_placement import (
    materialize_legacy_agent_assignment,
    materialize_legacy_task_assignment,
)
from .task_requests import TaskRequestError, ensure_issue_in_project
from ..security.actor import Actor

AGENT_NOT_FOUND = "agent_not_found"
START_ASSIGNMENT_UNAVAILABLE = "Every start assignment requires an available agent."
LEGACY_RUNTIME_OFFLINE = "No compatible runtime is currently available for this legacy task."
NAMED_AGENT_REQUIRED = "Select a named agent before starting this task."
ROUTINE_AGENT_REQUIRED = "A routine requires a named agent before it can start."
INVALID_STATE_DISPATCH = {
    "state": "rejected",
    "code": "invalid_state",
    "message": "This task cannot be started in its current state.",
}

PreparedStart = dict[str, Any] | tuple[dict[str, Any], str | None, list[dict[str, Any]]]


def prepare_task_start(
    ctx: Any,
    task: dict[str, Any],
    *,
    raw_assignments: Any,
    assignments: list[dict[str, Any]],
    agent_requested: bool,
) -> PreparedStart:
    """Resolve who runs a task the actor may start, recording any refusal."""
    task_id = task["id"]
    ensure_issue_in_project(task)
    if agent_requested:
        raise TaskRequestError(400, "agent is read-only; start through assignedAgentId.")
    if assignments and task.get("assignedTeamId"):
        assignments = []
    assignments = _pinned_assignments(task, raw_assignments, assignments)
    if not task.get("assignedTeamId") and any(not item.get("agentId") for item in assignments):
        materialized = _materialize_assignments(ctx, task, assignments)
        if materialized is None:
            return _dispatch_outcome(
                ctx, task_id, "rejected", AGENT_NOT_FOUND, START_ASSIGNMENT_UNAVAILABLE
            )
        assignments = materialized
    if not assignments and task.get("assignedAgent") and not task.get("assignedAgentId"):
        legacy_task = materialize_legacy_task_assignment(
            task,
            task_store=ctx.task_store,
            registry=ctx.registry,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        )
        if not legacy_task:
            return _dispatch_outcome(
                ctx, task_id, "queued", "agent_offline", LEGACY_RUNTIME_OFFLINE
            )
        task = legacy_task
    if not assignments and task.get("assignedAgentId") and task.get("assignedAgent"):
        assignments = [_assigned_agent(task)]
    if not assignments and not task.get("assignedTeamId") and not task.get("projectId"):
        assignments = implicit_group_assignments_for_task(ctx, task)
    agent = valid_agent(task.get("assignedAgent"))
    if not agent and assignments:
        agent = assignments[0]["agent"]
    if not agent and not task.get("assignedTeamId") and not task.get("projectId"):
        return _dispatch_outcome(
            ctx, task_id, "rejected", AGENT_NOT_FOUND, NAMED_AGENT_REQUIRED
        )
    if task.get("isRoutine") and not (
        task.get("projectId") or task.get("assignedAgentId") or task.get("assignedTeamId")
    ):
        return _dispatch_outcome(
            ctx, task_id, "rejected", AGENT_NOT_FOUND, ROUTINE_AGENT_REQUIRED
        )
    return task, agent, assignments


async def start_prepared_task(
    ctx: Any,
    task: dict[str, Any],
    assignments: list[dict[str, Any]],
    actor: Actor,
    *,
    automation_store: Any,
) -> dict[str, Any] | DispatchResult:
    """Dispatch a prepared start; a routine runs as a fresh manual occurrence."""
    if task.get("isRoutine"):
        occurrence = await run_in_threadpool(
            request_manual_occurrence, automation_store, ctx, task, actor
        )
        if "dispatch" in occurrence:
            return occurrence
        result = await start_task_on_ready_node(ctx, occurrence, actor, retry_blocked=True)
    else:
        result = await start_task_on_ready_node(
            ctx, task, actor, assignments=assignments or None, retry_blocked=True
        )
    if task.get("isRoutine") and result and (session := result.get("session")):
        await run_in_threadpool(ctx.task_store.link_session, task["id"], session["id"])
    if not result:
        return {"task": task, "session": None, "dispatch": dict(INVALID_STATE_DISPATCH)}
    return result


def _assigned_agent(task: dict[str, Any]) -> dict[str, Any]:
    return {"agentId": task["assignedAgentId"], "agent": task["assignedAgent"]}


def _pinned_assignments(
    task: dict[str, Any], raw_assignments: Any, assignments: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """A task pinned to an agent starts only that agent."""
    if not (task.get("assignedAgentId") and isinstance(raw_assignments, list) and raw_assignments):
        return assignments
    requested_agent_ids = [
        item.get("agentId") if isinstance(item, dict) else None for item in raw_assignments
    ]
    if requested_agent_ids != [task.get("assignedAgentId")]:
        raise TaskRequestError(409, "task_assignment_override")
    if not task.get("assignedAgent"):
        raise TaskRequestError(409, "task_assignment_invalid")
    return [_assigned_agent(task)]


def _materialize_assignments(
    ctx: Any, task: dict[str, Any], assignments: list[dict[str, Any]]
) -> list[dict[str, Any]] | None:
    """Give each executor-kind-only assignment a named agent, or answer None."""
    materialized_assignments = []
    for assignment in assignments:
        if assignment.get("agentId"):
            materialized_assignments.append(assignment)
            continue
        executor_kind = valid_agent(assignment.get("agent"))
        materialized = (
            materialize_legacy_agent_assignment(
                task,
                executor_kind,
                registry=ctx.registry,
                agent_store=ctx.agent_store,
                placement_store=ctx.agent_placement_store,
            )
            if executor_kind
            else None
        )
        if not materialized:
            return None
        materialized_assignments.append({**assignment, **materialized})
    return materialized_assignments


def _dispatch_outcome(
    ctx: Any, task_id: str, state: str, code: str, message: str
) -> dict[str, Any]:
    updated = ctx.task_store.record_dispatch_outcome(task_id, state, code=code, message=message)
    return {
        "task": updated,
        "session": None,
        "dispatch": {"state": state, "code": code, "message": message},
    }
