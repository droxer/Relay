from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol, cast

from fastapi import APIRouter, HTTPException, Request, Response
from loguru import logger

from ...core.computer_identity import computer_id as resolve_computer_id
from ...execution.session_deletion import delete_thread
from ...persistence.daemon.rules import TERMINAL_CLAIM_EXPIRES_STATE_KEY, TERMINAL_CLAIM_ID_STATE_KEY
from ...sessions.controller import SessionController
from ...sessions.errors import SessionArchivedError, SessionRunInFlightError
from ...sessions.task_scope import thread_task_scope
from ...teams.dispatch import (
    TeamDispatchError,
    task_thread_assignments,
    task_thread_ownership,
)
from ..actors import (
    get_session_for_actor,
    get_task_for_actor,
    owner_user_id_for_create,
    request_actor,
    request_actor_or_sandbox,
)
from ..bodies import JsonBodyDep, assignment_list, string_field
from ..deps import AppContext, AppContextDep
from ..projects.access import (
    ensure_project_node_matches,
    project_for_owner,
    project_session_fields,
)
from ..schemas import ThreadCreateBody, ThreadCreateBodyDep, openapi_body
from .projections import ensure_session_managed_affinity

router = APIRouter()


class _RunRequestRecovery(Protocol):
    """Run-request reads and writes both daemon stores implement but the
    ``DaemonStore`` protocol does not yet declare."""

    def active_run_request_for_session_any_node(
        self, session_id: str
    ) -> dict[str, Any] | None: ...

    def update_run_request_if_claimed(
        self, request_id: str, claim_key: str, claim_id: str, patch: dict[str, Any]
    ) -> dict[str, Any] | None: ...


@router.post("/threads", status_code=201, openapi_extra=openapi_body(ThreadCreateBody))
def create_session(
    request: Request, ctx: AppContextDep, *, _request_body: ThreadCreateBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    body = _request_body
    task_goal = body.task_goal
    if not task_goal:
        raise HTTPException(400, "taskGoal is required.")
    assignments = assignment_list(body.assignments)
    owner_agent_id = next(
        (
            assignment.get("agentId")
            for assignment in assignments
            if assignment.get("agentId")
        ),
        None,
    )
    workspace_path = body.workspace_path or "/workspace"
    daemon_node_id = body.node_id()
    managed_node_id = None
    session_computer_id = None
    task_id = body.task_id
    task = get_task_for_actor(ctx.task_store, task_id, actor) if task_id else None
    requested_project_id = body.project_id or None
    task_project_id = task.get("projectId") if task else None
    if requested_project_id and task_project_id and requested_project_id != task_project_id:
        raise HTTPException(400, "thread_project_task_mismatch")
    project_id = task_project_id or requested_project_id
    if project_id and body.is_set("assignments"):
        raise HTTPException(400, "project_assignment_override_unsupported")
    owner = owner_user_id_for_create(actor, body.as_dict())
    thread_ownership = {
        "owner_user_id": owner,
        **({"owner_agent_id": owner_agent_id} if owner_agent_id else {}),
    }
    if task:
        thread_ownership, assignments, owner = _task_thread_ownership(
            ctx, task, body, assignments, owner
        )
    node = _selected_thread_node(ctx, daemon_node_id, owner) if daemon_node_id else None
    if node:
        managed_node_id = node.get("managedNodeId")
        session_computer_id = resolve_computer_id(node)
    project = project_for_owner(ctx, project_id, owner, require_enabled=True) if project_id and owner else None
    project_fields: dict[str, Any] = {}
    if project:
        ensure_project_node_matches(project, node)
        project_fields = project_session_fields(ctx, project)
        workspace_path = project_fields.pop("workspace_path")
        session_computer_id = project_fields.pop("computer_id")
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        task_id=task_id,
        workspace_path=workspace_path,
        daemon_node_id=daemon_node_id,
        managed_node_id=managed_node_id,
        computer_id=session_computer_id,
        **project_fields,
        **thread_ownership,
    )
    session = controller.create_session(
        task_goal,
        list(
            dict.fromkeys(
                ["human", *(assignment["agent"] for assignment in assignments)]
            )
        ),
    )
    if assignments:
        controller.assign_session(session["id"], assignments)
    logger.info(
        "Session created",
        session_id=session["id"],
        workspace_path=workspace_path,
        owner=owner,
    )
    return ctx.session_store.get_session(session["id"])


def _task_thread_ownership(
    ctx: AppContext,
    task: dict[str, Any],
    body: ThreadCreateBody,
    assignments: list[dict[str, Any]],
    owner: str,
) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    """A task thread's ownership and assignments come from the task."""
    try:
        thread_ownership = task_thread_ownership(
            task, team_store=ctx.team_store, agent_store=ctx.agent_store
        )
        assignments = task_thread_assignments(
            task,
            assignments,
            team_store=ctx.team_store,
            agent_store=ctx.agent_store,
        )
    except TeamDispatchError as error:
        raise HTTPException(409, error.code) from error
    expected_owner = thread_ownership.get("owner_user_id")
    requested_owner = body.owner_user_id or body.user_id
    if requested_owner and requested_owner != expected_owner:
        raise HTTPException(
            403, "Session owner must match the linked task assignee."
        )
    owner = expected_owner or owner
    if owner and "owner_user_id" not in thread_ownership:
        thread_ownership = {**thread_ownership, "owner_user_id": owner}
    return thread_ownership, assignments, owner


def _selected_thread_node(
    ctx: AppContext, daemon_node_id: str, owner: str
) -> dict[str, Any]:
    node = next(
        (
            item
            for item in ctx.registry.monitor_nodes()
            if item.get("id") == daemon_node_id
        ),
        None,
    )
    if not node or not node.get("online") or node.get("stale"):
        raise HTTPException(
            409,
            {
                "code": "node_offline",
                "message": "The selected computer is not available.",
            },
        )
    if owner and node.get("userId") != owner:
        raise HTTPException(
            403, "The selected computer belongs to another user."
        )
    return node


@router.get("/threads/{session_id}")
def get_session(
    session_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    session = ensure_session_managed_affinity(
        ctx, get_session_for_actor(ctx.session_store, session_id, actor)
    )
    return {**session, "execution": ctx.execution_lifecycle.status(session)}


@router.get("/threads/{session_id}/execution")
def get_execution_status(session_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    session = get_session_for_actor(ctx.session_store, session_id, actor)
    return ctx.execution_lifecycle.status(session)


@router.post("/threads/{session_id}/execution/recovery")
def retry_execution_recovery(session_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    session = get_session_for_actor(ctx.session_store, session_id, actor)

    daemon_store = cast(_RunRequestRecovery, ctx.daemon_store)
    with ctx.registry.dispatch_lock:
        run = daemon_store.active_run_request_for_session_any_node(session_id)
        state = dict((run or {}).get("state") or {})
        if run and run.get("status") == "finalizing" and state.get("_relay_recovery_required"):
            claim = state.get(TERMINAL_CLAIM_ID_STATE_KEY)
            if claim:
                state.pop("_relay_recovery_required", None)
                state.pop("_relay_finalization_retry_at", None)
                state["_relay_finalization_attempts"] = 0
                state[TERMINAL_CLAIM_EXPIRES_STATE_KEY] = datetime.now(UTC).isoformat()
                daemon_store.update_run_request_if_claimed(run["id"], TERMINAL_CLAIM_ID_STATE_KEY, claim, {"state": state})
    return ctx.execution_lifecycle.status(session)


@router.post("/threads/{session_id}/execution/reconcile")
def reconcile_execution(session_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    """Release a blocked execution on a person's word that the agent is gone.

    The retry above repairs a save that failed after the daemon reported exit.
    This one covers the case where the report is never coming: without it a
    thread whose computer died can never be deleted, and the node cannot be
    deleted either while its stuck request counts as active work.
    """
    actor = request_actor(request, ctx.auth_store)
    get_session_for_actor(ctx.session_store, session_id, actor)
    status = ctx.execution_lifecycle.reconcile(session_id, actor["userId"])
    if status is None:
        raise HTTPException(
            409,
            "Only an execution Relay has given up on can be reported gone.",
        )
    return status


@router.patch("/threads/{session_id}")
def update_session(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    unknown = set(body) - {"title", "archived"}
    if unknown or not body:
        fields = ", ".join(sorted(unknown)) if unknown else "none"
        raise HTTPException(400, f"Unsupported thread field(s): {fields}.")
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_user_id=actor["userId"],
    )
    result = ctx.session_store.get_session(session_id)
    if "title" in body:
        title = string_field(body, "title").strip()
        if not title:
            raise HTTPException(400, "title is required.")
        if len(title) > 200:
            raise HTTPException(400, "title must be 200 characters or fewer.")
        result = controller.rename_session(session_id, title)
    if "archived" in body:
        if body["archived"] is not True:
            raise HTTPException(400, "archived currently supports only true.")
        result = controller.archive_session(session_id)
    return result


@router.post("/threads/{session_id}/cancellations", status_code=202)
def cancel_session_run(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    session = get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    reason = string_field(body, "reason") or "Cancelled by user."
    node = next(
        (
            item
            for item in ctx.registry.monitor_nodes()
            if any(
                run.get("sessionId") == session_id for run in item.get("activeRuns", [])
            )
        ),
        None,
    )
    run_request = ctx.registry.daemon_store.active_run_request_for_session_any_node(
        session_id
    )
    node_id = node["id"] if node else run_request.get("nodeId") if run_request else None
    # Resolved before cancelling: an undelivered request stops being active,
    # and its task must still be released or the scheduler starts it again.
    task_id, task_owner = thread_task_scope(
        session, run_request, ctx.task_store, ctx.registry.daemon_store
    )
    if node_id:
        cancelled = ctx.backend.cancel_run(
            node_id,
            session_id,
            reason,
            actor_user_id=actor["userId"],
            actor_is_admin=bool(actor.get("isAdmin")),
        )
        if cancelled is not None:
            return cancelled
        # The node had no cancellable run — it finished moments ago, or its run
        # request is parked in a state list_active_runs never reports, such as
        # finalizing. Cancel the thread itself rather than failing: Stop must
        # never be a dead end that leaves a thread stuck running forever.
    if session.get("status") in ("completed", "failed", "cancelled"):
        return session
    return SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        task_id=task_id,
        task_execution_owner=task_owner,
        owner_user_id=actor["userId"],
    ).cancel_session(session_id, reason, actor_user_id=actor["userId"])


@router.post("/threads/{session_id}/assignments")
def assign_session(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    assignments = assignment_list(body.get("assignments"))
    if not assignments:
        raise HTTPException(400, "assignments must include at least one agent.")
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_user_id=actor["userId"],
    )
    try:
        controller.assign_session(session_id, assignments)
    except SessionArchivedError:
        raise HTTPException(409, "Session is archived.") from None
    except SessionRunInFlightError:
        raise HTTPException(409, "Session has a run in flight.") from None
    return ctx.session_store.get_session(session_id)


@router.delete("/threads/{session_id}", status_code=204)
def delete_session(
    session_id: str, request: Request, ctx: AppContextDep
) -> Response:
    actor = request_actor(request, ctx.auth_store)
    get_session_for_actor(ctx.session_store, session_id, actor)
    stop = request.query_params.get("stop", "false")
    if stop not in ("true", "false"):
        raise HTTPException(400, "stop must be true or false.")
    if stop == "true":
        from fastapi.responses import JSONResponse
        status = ctx.execution_lifecycle.request_delete(session_id, actor["userId"])
        return JSONResponse(status, status_code=202) if status else Response(status_code=204)
    try:
        delete_thread(
            ctx,
            session_id,
            execution_lifecycle=ctx.execution_lifecycle,
            deleted_by=actor["userId"],
            reload=lambda: get_session_for_actor(ctx.session_store, session_id, actor),
        )
    except SessionRunInFlightError:
        raise HTTPException(409, "Session has a run in flight.") from None
    return Response(status_code=204)
