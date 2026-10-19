from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger
from starlette.concurrency import run_in_threadpool

from ...security.actor import Actor
from ...tasks.assignment import logical_agent_for_assignment
from ...tasks.deletion import task_has_active_linked_session
from ...tasks.dispatch import start_task_on_ready_node
from ...tasks.dispatch_outcome import DispatchResult
from ...tasks.requests import (
    ensure_issue_in_project,
    update_task_unless_dispatching,
)
from ...tasks.start import PreparedStart, prepare_task_start, start_prepared_task
from ...tasks.workspace import task_artifacts_dir
from ..actors import (
    get_task_for_actor,
    request_actor,
)
from ..bodies import assignment_list, json_body, string_field
from ..deps import AppContext, AppContextDep
from ..projects.access import ensure_task_project_writable
from ..schemas import (
    TaskStartBody,
    openapi_body,
    parse_request_body,
)
from .history import newest_artifacts_by_file, occurrence_tasks
from .payloads import public_task_envelope, task_request_errors

router = APIRouter()


def _prepare_task_start(task_id: str, ctx: AppContext, actor: Actor, body: TaskStartBody) -> PreparedStart:
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    if task.get("isRoutine") and not actor["isAdmin"] and task.get("ownerUserId") != actor.get("userId"):
        raise HTTPException(403, "Only the automation's owner or an admin can run it.")
    ensure_task_project_writable(ctx, task)
    raw_assignments = body.assignments
    with task_request_errors():
        return prepare_task_start(
            ctx,
            task,
            raw_assignments=raw_assignments,
            assignments=assignment_list(raw_assignments),
            agent_requested=body.requests_agent(),
        )


@router.post("/tasks/{task_id}/runs", status_code=202, openapi_extra=openapi_body(TaskStartBody))
async def start_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    # Every answer below carries a task (often the routine definition).
    return public_task_envelope(await _start_task(task_id, request, ctx))


async def _start_task(
    task_id: str, request: Request, ctx: AppContext
) -> dict[str, Any] | DispatchResult:
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    body = await parse_request_body(request, TaskStartBody)
    prepared = await run_in_threadpool(_prepare_task_start, task_id, ctx, actor, body)
    if isinstance(prepared, dict):
        return prepared
    task, _agent, assignments = prepared
    return await start_prepared_task(
        ctx, task, assignments, actor, automation_store=ctx.automation_store
    )


def _prepare_task_pickup(task_id: str, ctx: AppContext, actor: Actor, body: dict[str, Any]) -> Any:
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    ensure_task_project_writable(ctx, current)
    with task_request_errors():
        return _pick_up(ctx, actor, current, body)


def _pick_up(
    ctx: AppContext, actor: Actor, current: dict[str, Any], body: dict[str, Any]
) -> tuple[dict[str, Any], str, str]:
    task_id = current["id"]
    ensure_issue_in_project(current)
    if current.get("status") not in ("backlog", "assigned"):
        raise HTTPException(409, "task_not_dispatchable")
    if task_has_active_linked_session(ctx.session_store, current):
        raise HTTPException(409, "task_execution_active")
    if current.get("assignedTeamId"):
        raise HTTPException(409, "team_task_requires_team_start")
    agent_id = string_field(body, "agentId") or string_field(body, "assignedAgentId")
    logical_agent = logical_agent_for_assignment(
        ctx,
        actor,
        agent_id,
        expected_user_id=current.get("assigneeUserId")
        or current.get("ownerUserId")
        or actor["userId"],
    )
    if not logical_agent or not agent_id:
        raise HTTPException(400, "agentId is required to pick up a task.")
    agent = logical_agent["executorKind"]
    task = update_task_unless_dispatching(
        ctx,
        task_id,
        {
            "assigneeUserId": logical_agent["supervisorUserId"],
            "status": "assigned",
            "assignedAgent": agent,
            "assignedAgentId": agent_id,
            "assignedTeamId": None,
        },
    )
    return task, agent_id, agent


@router.post("/tasks/{task_id}/pickups", status_code=202)
async def pickup_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    body = await json_body(request)
    task, agent_id, agent = await run_in_threadpool(_prepare_task_pickup, task_id, ctx, actor, body)
    result = await start_task_on_ready_node(
        ctx,
        task,
        actor,
        assignments=[
            {
                "agentId": agent_id,
                "agent": agent,
            }
        ],
    )
    if not result:
        raise HTTPException(409, "task_not_dispatchable")
    logger.info(
        "Task picked up",
        task_id=task_id,
        session_id=(result.get("session") or {}).get("id"),
        agent=agent,
    )
    return public_task_envelope(result)


# A routine that has run nightly for a year has hundreds of occurrences; the
# ledger answers "is this healthy lately", so it reads recent runs by default.
RUN_LEDGER_LIMIT = 30
RUN_LEDGER_MAX_LIMIT = 200
# The task statuses that end a run. There is no "failed" task status — a run
# that went wrong lands in `blocked`, carrying the reason that put it there.
RUN_TERMINAL_STATUSES = ("done", "blocked")


def run_row(ctx: Any, task: dict[str, Any]) -> dict[str, Any]:
    """One run of `task`, summarized for the ledger.

    Timing comes from the status events rather than the snapshot: `updatedAt`
    moves for edits that have nothing to do with the run, and a run that is
    still going has no end at all.
    """
    started_at: str | None = None
    ended_at: str | None = None
    failure_message: str | None = None
    for event in task.get("events", []):
        if event.get("type") != "task.status":
            continue
        status = event.get("status")
        if status == "running" and started_at is None:
            started_at = event.get("timestamp")
        elif status in RUN_TERMINAL_STATUSES:
            ended_at = event.get("timestamp")
            failure_message = event.get("reason") if status == "blocked" else None
    if task.get("status") not in RUN_TERMINAL_STATUSES:
        ended_at = None
        failure_message = None
    session_ids = list(task.get("linkedSessionIds", []))
    artifacts = newest_artifacts_by_file(
        ctx, [(task["id"], session_id) for session_id in session_ids]
    )
    return {
        "taskId": task["id"],
        "scheduledFor": task.get("scheduledFor") or task.get("dueDate"),
        "status": task.get("status"),
        "createdAt": task.get("createdAt"),
        "startedAt": started_at,
        "endedAt": ended_at,
        "failureMessage": failure_message,
        "sessionIds": session_ids,
        "latestSessionId": session_ids[-1] if session_ids else None,
        "artifactCount": len(artifacts),
        # The folder this run's deliverables live in, relative to the shared
        # workspace the Runs tab browses; null when the workspace is that folder.
        "artifactsDir": task_artifacts_dir(task),
        "triggerKind": task.get("routineTriggerKind"),
        "triggerSummary": task.get("routineTriggerSummary"),
    }


@router.get("/tasks/{task_id}/runs")
def task_runs(
    task_id: str,
    request: Request,
    ctx: AppContextDep,
    limit: int = RUN_LEDGER_LIMIT,
) -> dict[str, Any]:
    """The task's run ledger — one row per run, newest first.

    A routine never runs itself: the scheduler promotes an occurrence and that
    occurrence carries the run, so a routine's rows are its occurrences. A
    plain task ran as itself and gets a single row, which keeps the ledger one
    component on the client instead of two shapes to switch between.

    Rows are dated by the day the run was scheduled for, so a routine reads as
    a calendar of its runs rather than as promotion bookkeeping.
    """
    if limit < 1:
        raise HTTPException(400, "limit must be at least 1.")
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    occurrences = occurrence_tasks(ctx, task, actor)
    runs = [run_row(ctx, occurrence) for occurrence in occurrences] if occurrences else (
        [] if task.get("isRoutine") else [run_row(ctx, task)]
    )
    runs.sort(
        key=lambda run: (run.get("scheduledFor") or "", run.get("createdAt") or ""),
        reverse=True,
    )
    return {"taskId": task_id, "runs": runs[: min(limit, RUN_LEDGER_MAX_LIMIT)]}
