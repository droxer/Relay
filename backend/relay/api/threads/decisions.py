from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger

from ...core.models import AGENT_NAMES
from ...core.permission_requests import PERMISSION_DECISIONS, PERMISSION_NOTE_MAX_CHARS
from ...core.validation import valid_agent
from ...sessions.controller import SessionController
from ...sessions.task_scope import (
    IN_FLIGHT_TASK_STATUSES,
    MARK_DONE_TASK_STATUSES,
    thread_task_scope,
)
from ..actors import (
    get_session_for_actor,
    request_actor_or_sandbox,
)
from ..bodies import JsonBodyDep, role_name, string_field
from ..deps import AppContextDep

router = APIRouter()


def _assert_rejectable(session: dict[str, Any], ctx: Any) -> None:
    """Refuse a reject that would leave the thread and its task disagreeing.

    A reject parks the thread for feedback. While a run is in flight there is
    no finished turn to reject, and while the round's task awaits review the
    task's own review is where changes are requested — a thread reject would
    leave that task in review with nothing to resume it.
    """
    if session.get("status") == "running" or (
        ctx.registry.daemon_store.active_run_request_for_session_any_node(session["id"])
    ):
        raise HTTPException(409, "session_run_in_flight")
    active_round: dict[str, Any] = next(
        (
            item
            for item in session.get("collaborationRounds", [])
            if item.get("roundId") == session.get("activeRoundId")
        ),
        {},
    )
    scope = active_round.get("workScope") or {}
    if scope.get("kind") != "task" or not scope.get("taskId"):
        return
    try:
        task = ctx.task_store.get_task(scope["taskId"])
    except (KeyError, FileNotFoundError):
        return
    if task.get("status") == "review" and not task.get("deletedAt"):
        raise HTTPException(409, "task_review_pending")


@router.post("/threads/{session_id}/decisions")
def decision(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    # The sandbox credential here is the browser-minted UI token, which acts as
    # its user; the daemon (and every agent) holds only the node token,
    # which never authenticates as a person.
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    session = get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    kind = body.get("kind")
    if kind in ("rerun", "handoff"):
        # These name the next turn, and this route dispatches nothing; recording
        # one here would mark the thread running with no run behind it.
        raise HTTPException(
            400, f"{kind} dispatches an agent; send it through POST /agent-runs."
        )
    if kind not in ("approve", "reject", "cancel", "mark_done"):
        raise HTTPException(400, "kind must be approve, reject, cancel, or mark_done.")
    if kind == "reject":
        with (
            ctx.registry.dispatch_lock,
            ctx.execution_lifecycle.admission_scope(),
            ctx.session_store.mutation_scope(session_id),
        ):
            session = get_session_for_actor(ctx.session_store, session_id, actor)
            _assert_rejectable(session, ctx)
            return SessionController(ctx.session_store).record_decision(
                session_id, kind, string_field(body, "note") or None,
                valid_agent(body.get("targetAgent")),
                actor_user_id=actor["userId"],
            )
    task_id = task_owner = None
    if kind in ("cancel", "mark_done"):
        run_request = ctx.registry.daemon_store.active_run_request_for_session_any_node(
            session_id
        )
        # Resolved before cancelling, which ends the request's task authority.
        task_id, task_owner = thread_task_scope(
            session, run_request, ctx.task_store, ctx.registry.daemon_store,
            statuses=(
                MARK_DONE_TASK_STATUSES if kind == "mark_done"
                else IN_FLIGHT_TASK_STATUSES
            ),
        )
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        task_id=task_id,
        task_execution_owner=task_owner,
        owner_user_id=actor["userId"],
    )
    if kind in ("cancel", "mark_done"):
        if run_request:
            terminal_reason = string_field(body, "note") or (
                "Session marked done by user."
                if kind == "mark_done"
                else "Cancelled by user."
            )
            ctx.registry.cancel_run_request_before_delivery(
                run_request["id"], terminal_reason
            )
            if ctx.registry.get(run_request["nodeId"]):
                ctx.registry.cancel_active_run(
                    run_request["nodeId"], session_id, terminal_reason
                )
    result = controller.record_decision(
        session_id,
        kind,
        string_field(body, "note") or None,
        valid_agent(body.get("targetAgent")),
        actor_user_id=actor["userId"],
    )
    logger.info("Session decision recorded", session_id=session_id, kind=kind)
    return result


@router.post("/threads/{session_id}/permission-requests/{request_id}")
def answer_permission_request(
    session_id: str,
    request_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    # Like a decision, only a person answers: the node token an agent can
    # reach never authenticates as one.
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    decision = body.get("decision")
    if decision not in PERMISSION_DECISIONS:
        raise HTTPException(400, "decision must be allow or deny.")
    note = string_field(body, "note")
    if len(note) > PERMISSION_NOTE_MAX_CHARS:
        raise HTTPException(400, "note is too long.")
    always = body.get("always", False)
    if not isinstance(always, bool):
        raise HTTPException(400, "always must be a boolean.")
    try:
        result = SessionController(ctx.session_store).resolve_permission_request(
            session_id,
            request_id,
            decision,
            note or None,
            answers=body.get("answers"),
            always=always,
            actor_user_id=actor["userId"],
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if result is None:
        raise HTTPException(409, "permission_request_closed")
    return result


@router.post("/threads/{session_id}/handoffs")
def handoff(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    target_agent = valid_agent(body.get("targetAgent"))
    if not target_agent:
        raise HTTPException(
            400, f"targetAgent must be one of: {', '.join(AGENT_NAMES)}."
        )
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_user_id=actor["userId"],
    )
    result = controller.handoff_session(
        session_id,
        target_agent,
        [{"agent": target_agent, "role": role_name(body.get("role"))}],
        string_field(body, "note") or None,
    )
    logger.info(
        "Session handoff recorded",
        session_id=session_id,
        target_agent=target_agent,
    )
    return result
