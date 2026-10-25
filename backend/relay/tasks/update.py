"""Patching a task: its fields, status, assignment, project, and automation.

``update_task`` judges a PATCH in a fixed order (fields, automation,
assignment, the next assignment and status) and then writes it under the
dispatch lock and the task store's transaction, re-reading an automation's
state there because the scheduler may have paused it meanwhile.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any

from loguru import logger

from ..automations.model import has_webhook, state_of
from ..core.models import TaskStatus
from ..automations.service import lock_automation_state, prepare_resume
from ..persistence.engine import store_transaction
from ..core.validation import task_priority, task_status
from .flow import validate_manual_transition
from .claims import dispatch_claim_active
from ..sessions.controller import SessionController
from .issue_triage import ISSUE_NEEDS_PROJECT, issue_needs_project
from .assignment import (
    logical_agent_for_assignment,
    team_for_assignment,
    validate_project_assignment,
    validate_project_task_assignment,
    validate_trigger_scope,
)
from .deletion import task_has_active_linked_session
from .requests import (
    TaskRequestError,
    TaskRequestReader,
    acceptance_policy_field,
    collaboration_style_field,
    tags_field,
    update_task_unless_dispatching,
)
from ..security.actor import Actor

UNBLOCKED_WAIT_REASON = (
    "The block was cleared, but the interrupted run does not restart on its own. "
    "Tell the agent how to continue."
)
EMPTY_PATCH_DETAIL = (
    "PATCH requires title, description, priority, tags, dueDate, assigneeUserId, "
    "assignedAgentId, assignedTeamId, projectId, or status."
)
BLOCKER_REASON_MAX_CHARS = 2000


@dataclass(frozen=True)
class TaskPatchRequest:
    """A PATCH whose task the actor may write, read through the HTTP layer."""

    body: dict[str, Any]
    reader: TaskRequestReader
    # The assignee the body names (None when it names none); never refused.
    requested_assignee: str | None
    # The project an intake issue moves into, already authorized.
    move_project: dict[str, Any] | None
    # Re-reads the task under the automation lock with the caller's access rule.
    reload: Callable[[], dict[str, Any]]
    automation_store: Any


@dataclass(frozen=True)
class _Fields:
    title: str | None
    description: str | None
    priority: str | None
    tags: list[str] | None
    status: str | None
    acceptance_policy: Any
    collaboration_style: str | None
    unblock: bool
    unblocked_wait: dict[str, Any]
    blocker_reason: str
    due_date: str | None


@dataclass(frozen=True)
class _Assignment:
    assignee: str | None
    agent: str | None
    agent_id: str | None
    team_id: str | None
    logical_agent: dict[str, Any] | None
    assignee_changed: bool


@dataclass(frozen=True)
class _NextAssignment:
    agent_id: str | None
    team_id: str | None
    changed: bool
    status: str | None
    patch: dict[str, Any]


def update_task(
    ctx: Any, actor: Actor, current: dict[str, Any], request: TaskPatchRequest
) -> dict[str, Any]:
    body, move_project = request.body, request.move_project
    # Everything below judges the task as it will be once the move lands.
    effective = {**current, "projectId": move_project["id"]} if move_project else current
    fields = _read_fields(current, request)
    routine = request.reader.routine(body, current=current)
    ensure_relay_pause_transition_allowed(current, routine, actor)
    if "routineTriggers" in body:
        validate_trigger_scope(
            ctx, routine.get("routineTriggers"), owner=current.get("ownerUserId")
        )
    assignment = _resolve_assignment(ctx, actor, current, effective, request)
    _ensure_patch_not_empty(body, fields, assignment, routine, move_project)
    following = _plan_next_assignment(
        ctx, current, effective, request, fields, assignment, routine
    )
    payload = {
        "title": fields.title,
        "description": fields.description,
        "priority": fields.priority,
        **({"tags": fields.tags} if fields.tags is not None else {}),
        "status": following.status,
        "acceptancePolicy": fields.acceptance_policy,
        "collaborationStyle": fields.collaboration_style,
        "blockerReason": fields.blocker_reason,
        **fields.unblocked_wait,
        "actorUserId": actor["userId"],
        "expectedStatus": current["status"],
        "expectedExecutionRevision": (current.get("executionOwner") or {}).get("revision", 0),
        "dueDate": fields.due_date,
        "assigneeUserId": assignment.assignee,
        **({"projectId": move_project["id"]} if move_project else {}),
        **routine,
        **following.patch,
    }
    guarded = bool(
        following.status
        or following.changed
        or assignment.assignee_changed
        or fields.acceptance_policy
        or move_project
    )
    current, task = _write_update(
        ctx, actor, current, request, routine, payload,
        status=following.status, unblock=fields.unblock,
        acceptance_policy=fields.acceptance_policy, guarded=guarded,
    )
    if has_webhook(current) and (not task.get("isRoutine") or not has_webhook(task)):
        request.automation_store.delete_webhook_secret(current["id"])
    return task


def ensure_relay_pause_transition_allowed(
    current: dict[str, Any], routine: dict[str, Any], actor: Actor
) -> None:
    if (
        state_of(current) == "paused_by_relay"
        and (routine.get("routineState") in ("active", "paused") or routine.get("isRoutine") is False)
        and not actor.get("isAdmin")
        and current.get("ownerUserId") != actor.get("userId")
    ):
        # An ordinary pause or conversion would let the assignee activate it later.
        raise TaskRequestError(403, "Only the automation's owner or an admin can resume it.")


def _read_fields(current: dict[str, Any], request: TaskPatchRequest) -> _Fields:
    body, reader = request.body, request.reader
    title = reader.string(body, "title") or None
    description = body.get("description") if isinstance(body.get("description"), str) else None
    priority = task_priority(body.get("priority"))
    status = task_status(body.get("status"))
    acceptance_policy = acceptance_policy_field(body)
    collaboration_style = collaboration_style_field(body, allow_clear=True)
    if "status" in body and not status:
        raise TaskRequestError(400, "status is not a recognized task status.")
    unblock = body.get("action") == "unblock"
    if "action" in body and not unblock:
        raise TaskRequestError(400, "Unknown task action.")
    if unblock:
        status = _unblocked_status(current, body)
    blocker_reason = reader.string(body, "blockerReason").strip()
    if status == "blocked" and (
        not blocker_reason or len(blocker_reason) > BLOCKER_REASON_MAX_CHARS
    ):
        raise TaskRequestError(400, "Blocking requires a reason of 1–2000 characters.")
    return _Fields(
        title=title,
        description=description,
        priority=priority,
        tags=tags_field(body),
        status=status,
        acceptance_policy=acceptance_policy,
        collaboration_style=collaboration_style,
        unblock=unblock,
        unblocked_wait=_unblocked_wait(current, unblock=unblock, status=status),
        blocker_reason=blocker_reason,
        due_date=reader.date(body, "dueDate"),
    )


def _unblocked_status(current: dict[str, Any], body: dict[str, Any]) -> TaskStatus:
    if "status" in body or current.get("status") != "blocked":
        raise TaskRequestError(409, "task_not_blocked")
    status: TaskStatus = current.get("blockedFromStatus") or "backlog"
    return "waiting_for_human" if status == "running" else status


def _unblocked_wait(
    current: dict[str, Any], *, unblock: bool, status: str | None
) -> dict[str, Any]:
    """An unblocked run cannot resume on its own; say so where the wait is
    quoted, and point the answer at the thread the block came from."""
    if not (unblock and status == "waiting_for_human"):
        return {}
    attention = current.get("attention")
    session_id = attention.get("sessionId") if isinstance(attention, dict) else None
    return {
        "statusReason": UNBLOCKED_WAIT_REASON,
        **({"statusSessionId": session_id} if session_id else {}),
    }


def _resolve_assignment(
    ctx: Any,
    actor: Actor,
    current: dict[str, Any],
    effective: dict[str, Any],
    request: TaskPatchRequest,
) -> _Assignment:
    body, string = request.body, request.reader.string
    assignee = request.requested_assignee
    agent_id = string(body, "assignedAgentId") if "assignedAgentId" in body else None
    team_id = string(body, "assignedTeamId") if "assignedTeamId" in body else None
    if agent_id and team_id:
        raise TaskRequestError(400, "task_agent_and_team_conflict")
    validate_project_task_assignment(
        ctx, effective, assigned_agent_id=agent_id, assigned_team_id=team_id
    )
    if "assignedAgent" in body:
        raise TaskRequestError(400, "assignedAgent is read-only; use assignedAgentId.")
    assignee_changed = bool(assignee and assignee != current.get("assigneeUserId"))
    _ensure_reassignment_allowed(current, body, assignee, assignee_changed=assignee_changed)
    logical_agent = None
    if not (agent_id and agent_id == current.get("assignedAgentId") and not assignee_changed):
        logical_agent = logical_agent_for_assignment(
            ctx,
            actor,
            agent_id,
            expected_user_id=assignee
            or current.get("assigneeUserId")
            or current.get("ownerUserId"),
        )
    agent = None
    if logical_agent:
        agent = logical_agent["executorKind"]
        assignee = logical_agent["supervisorUserId"]
    team_for_assignment(
        ctx,
        actor,
        team_id,
        expected_user_id=assignee
        or current.get("assigneeUserId")
        or current.get("ownerUserId")
        or actor["userId"],
        require_actor_access=not (
            team_id and team_id == current.get("assignedTeamId") and not assignee_changed
        ),
    )
    return _Assignment(assignee, agent, agent_id, team_id, logical_agent, assignee_changed)


def _ensure_reassignment_allowed(
    current: dict[str, Any],
    body: dict[str, Any],
    assignee: str | None,
    *,
    assignee_changed: bool,
) -> None:
    if not assignee_changed:
        return
    if (
        (current.get("assignedAgentId") or current.get("assignedTeamId"))
        and "assignedAgentId" not in body
        and "assignedTeamId" not in body
    ):
        raise TaskRequestError(
            400,
            "Changing the assignee requires an assignment for the new user, or an explicit empty assignment.",
        )
    if (
        current.get("ownerUserId") == current.get("assigneeUserId")
        and assignee != current.get("ownerUserId")
    ):
        raise TaskRequestError(403, "A user-owned task cannot be reassigned to another user.")


def _ensure_patch_not_empty(
    body: dict[str, Any],
    fields: _Fields,
    assignment: _Assignment,
    routine: dict[str, Any],
    move_project: dict[str, Any] | None,
) -> None:
    if (
        not fields.title
        and fields.description is None
        and not fields.priority
        and fields.tags is None
        and not fields.status
        and fields.due_date is None
        and assignment.assignee is None
        and not assignment.agent
        and "assignedAgentId" not in body
        and "assignedTeamId" not in body
        and not routine
        and fields.acceptance_policy is None
        and fields.collaboration_style is None
        and not move_project
    ):
        raise TaskRequestError(400, EMPTY_PATCH_DETAIL)


def _plan_next_assignment(
    ctx: Any,
    current: dict[str, Any],
    effective: dict[str, Any],
    request: TaskPatchRequest,
    fields: _Fields,
    assignment: _Assignment,
    routine: dict[str, Any],
) -> _NextAssignment:
    following = _next_assignment(current, request.body, assignment, fields.status)
    if (following.changed or assignment.assignee_changed) and task_has_active_linked_session(
        ctx.session_store, current
    ):
        raise TaskRequestError(409, "task_execution_active")
    has_target = bool(effective.get("projectId") or following.agent_id or following.team_id)
    next_is_routine = routine.get("isRoutine", current.get("isRoutine"))
    if (
        next_is_routine
        and routine.get("routineState", state_of(current)) == "active"
        and not has_target
    ):
        raise TaskRequestError(400, "An active automation requires an agent, team, or project.")
    if request.move_project and (following.agent_id or following.team_id):
        # A kept legacy assignment must still be someone on the project's computer.
        validate_project_assignment(
            ctx,
            request.move_project,
            assigned_agent_id=following.agent_id,
            assigned_team_id=following.team_id,
        )
    clear_requested = following.changed and not (following.agent_id or following.team_id)
    # Clearing stays allowed: it is how a legacy Ready intake issue goes back
    # to Backlog (just below).
    if (
        issue_needs_project({**effective, "isRoutine": next_is_routine})
        and not clear_requested
        and (
            following.status == "assigned"
            or (following.changed and (following.agent_id or following.team_id))
        )
    ):
        raise TaskRequestError(409, ISSUE_NEEDS_PROJECT)
    if (following.status or current.get("status")) == "assigned" and not has_target:
        if not clear_requested:
            raise TaskRequestError(400, "assigned status requires an agent or team.")
        following = replace(following, status="backlog")
    return following


def _next_assignment(
    current: dict[str, Any],
    body: dict[str, Any],
    assignment: _Assignment,
    status: str | None,
) -> _NextAssignment:
    agent_id = assignment.agent_id if "assignedAgentId" in body else current.get("assignedAgentId")
    team_id = assignment.team_id if "assignedTeamId" in body else current.get("assignedTeamId")
    if "assignedAgentId" in body and assignment.agent_id:
        team_id = None
    if "assignedTeamId" in body and assignment.team_id:
        agent_id = None
    changed = agent_id != current.get("assignedAgentId") or team_id != current.get(
        "assignedTeamId"
    )
    patch: dict[str, Any] = {}
    if changed:
        logical_agent = assignment.logical_agent
        executor_kind = (
            logical_agent["executorKind"] if logical_agent else current.get("assignedAgent")
        )
        patch = {
            "assignedAgentId": agent_id,
            "assignedTeamId": team_id,
            **({"assignedAgent": executor_kind} if agent_id else {}),
        }
    return _NextAssignment(agent_id, team_id, changed, status, patch)


def _write_update(
    ctx: Any,
    actor: Actor,
    current: dict[str, Any],
    request: TaskPatchRequest,
    routine: dict[str, Any],
    payload: dict[str, Any],
    *,
    status: str | None,
    unblock: bool,
    acceptance_policy: Any,
    guarded: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Write the patch; answer the task it was judged against and the result."""
    task_id = current["id"]
    # Resuming here shares the resume route's state reset (prepare_resume).
    with ctx.registry.dispatch_lock, store_transaction(ctx.task_store.engine) as conn:
        if routine:
            # The scheduler can pause it after the initial request validation.
            # Read again under its lock before judging or writing automation state.
            lock_automation_state(conn)
            current = request.reload()
            stale = routine
            routine = request.reader.routine(request.body, current=current)
            ensure_relay_pause_transition_allowed(current, routine, actor)
            payload = {
                **{key: value for key, value in payload.items() if key not in stale},
                **routine,
            }
        if routine.get("routineState") == "active" and state_of(current) != "active":
            prepare_resume(conn, request.automation_store, ctx.task_store, current, actor)
        if status:
            _validate_status_transition(ctx, current, status, unblock=unblock)
        if (
            acceptance_policy
            and acceptance_policy != current.get("acceptancePolicy", "automatic")
            and current.get("startedAt")
        ):
            raise TaskRequestError(409, "task_acceptance_policy_locked")
        try:
            task = (
                update_task_unless_dispatching(ctx, task_id, payload)
                if guarded
                else ctx.task_store.update_task(task_id, payload)
            )
        except ValueError as error:
            raise TaskRequestError(409, str(error)) from error
        if status == "done":
            complete_linked_task_sessions(ctx, task, "Task accepted after review.")
            task = ctx.task_store.get_task(task_id)
    return current, task


def _validate_status_transition(
    ctx: Any, current: dict[str, Any], status: str, *, unblock: bool
) -> None:
    active = bool(
        dispatch_claim_active(current)
        or ctx.registry.daemon_store.active_run_request_for_task(current["id"])
    )
    try:
        validate_manual_transition(current, status, active=active, unblock=unblock)
    except ValueError as error:
        raise TaskRequestError(409, str(error)) from error


def complete_linked_task_sessions(ctx: Any, task: dict[str, Any], outcome: str) -> None:
    # Serialize with admission so a newer thread round cannot acquire the
    # session between checking its scope and completing it.
    with ctx.registry.dispatch_lock:
        controller = SessionController(ctx.session_store)
        for session_id in task.get("linkedSessionIds", []):
            _complete_if_task_scoped(ctx, controller, task, session_id, outcome)


def _complete_if_task_scoped(
    ctx: Any,
    controller: SessionController,
    task: dict[str, Any],
    session_id: str,
    outcome: str,
) -> None:
    session = _linked_session(ctx, session_id)
    if session is None or session.get("status") in ("completed", "failed", "cancelled"):
        return
    run_request = ctx.registry.daemon_store.active_run_request_for_session_any_node(session_id)
    if run_request:
        if run_request.get("taskId") != task["id"]:
            return
    elif _active_round(session).get("workScope") != {"kind": "task", "taskId": task["id"]}:
        return
    if run_request:
        terminal_reason = "Linked task completed before agent delivery finished."
        ctx.registry.cancel_run_request_before_delivery(run_request["id"], terminal_reason)
        if ctx.registry.get(run_request["nodeId"]):
            ctx.registry.cancel_active_run(run_request["nodeId"], session_id, terminal_reason)
    controller.complete_session(session_id, outcome)


def _linked_session(ctx: Any, session_id: str) -> dict[str, Any] | None:
    try:
        return ctx.session_store.get_session(session_id)
    except (KeyError, FileNotFoundError):
        return None
    except Exception:  # noqa: BLE001 - one unreadable linked session must not block the rest
        logger.warning(
            "Unexpected error reading linked session",
            session_id=session_id,
            exc_info=True,
        )
        return None


def _active_round(session: dict[str, Any]) -> dict[str, Any]:
    return next(
        (
            item
            for item in session.get("collaborationRounds", [])
            if item.get("roundId") == session.get("activeRoundId")
        ),
        {},
    )
