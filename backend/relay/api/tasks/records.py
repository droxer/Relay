from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger

from ...tasks.flow import wip_limit
from ...security.actor import Actor
from ...tasks.assignment import (
    logical_agent_for_assignment,
    team_for_assignment,
    validate_project_task_assignment,
)
from ...tasks.creation import TaskCreateRequest
from ...tasks.creation import create_task as create_task_record
from ...tasks.deletion import (
    TaskDeletionError,
    task_has_active_linked_session,
)
from ...tasks.deletion import delete_task as delete_task_record
from ...tasks.requests import (
    ensure_issue_in_project,
    update_task_unless_dispatching,
)
from ...tasks.update import TaskPatchRequest
from ...tasks.update import update_task as update_task_record
from ...teams.dispatch import TeamDispatchError, task_thread_ownership
from ..actors import (
    assignee_user_id_for_task,
    get_task_for_actor,
    get_task_or_404,
    owner_user_id_for_create,
    request_actor,
)
from ..bodies import JsonBodyDep, string_field
from ..deps import AppContext, AppContextDep
from ..projects.access import ensure_task_project_writable, project_for_owner, project_session_fields
from ..schemas import (
    TaskCreateBody,
    TaskCreateBodyDep,
    TaskPatchBody,
    TaskPatchBodyDep,
    openapi_body,
)
from .payloads import (
    project_move_target,
    public_task,
    public_task_envelope,
    request_reader,
    task_request_errors,
)

router = APIRouter()

# Explicit limits remain bounded; an omitted limit preserves the complete list.
TASK_LIST_MAX_LIMIT = 500


def task_list_limit(raw_limit: str | None) -> int | None:
    if raw_limit is None:
        return None
    try:
        requested_limit = int(raw_limit)
    except ValueError as error:
        raise HTTPException(400, "limit must be an integer.") from error
    return min(max(1, requested_limit), TASK_LIST_MAX_LIMIT)


@router.get("/tasks")
def list_tasks(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    summary_view = request.query_params.get("view") == "summary"
    limit = task_list_limit(request.query_params.get("limit"))
    if summary_view and hasattr(ctx.task_store, "list_task_summaries"):
        tasks = ctx.task_store.list_task_summaries(
            user_id=None if actor["isAdmin"] else actor["userId"],
            limit=limit,
        )
    else:
        tasks = ctx.task_store.list_tasks(
            user_id=None if actor["isAdmin"] else actor["userId"],
            limit=limit,
        )
    return {
        "tasks": [public_task(task) for task in tasks],
        "flowPolicy": {"wipLimit": wip_limit(), "scope": "user"},
    }


@router.post("/tasks", status_code=201, openapi_extra=openapi_body(TaskCreateBody))
def create_task(
    request: Request, ctx: AppContextDep, *, _request_body: TaskCreateBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    title = _request_body.task_title()
    if not title:
        raise HTTPException(400, "title is required.")
    body = _request_body.as_dict()
    owner = owner_user_id_for_create(actor, body)
    assignee = assignee_user_id_for_task(actor, body, owner)
    project_id = _request_body.project_id or None
    project = project_for_owner(ctx, project_id, owner, require_enabled=True)
    with task_request_errors():
        task = create_task_record(
            ctx,
            actor,
            TaskCreateRequest(
                body=body,
                reader=request_reader(),
                title=title,
                owner=owner,
                assignee=assignee,
                project=project,
                project_session_fields=lambda selected: project_session_fields(ctx, selected),
            ),
        )
    return public_task(task)


@router.get("/tasks/{task_id}")
def get_task(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    return public_task(get_task_for_actor(ctx.task_store, task_id, actor))


@router.patch("/tasks/{task_id}", openapi_extra=openapi_body(TaskPatchBody))
def update_task(
    task_id: str, request: Request, ctx: AppContextDep, *, _request_body: TaskPatchBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    ensure_task_project_writable(ctx, current)
    # The services judge the PATCH by which fields it names, so they read the
    # body as sent; absent and null stay distinct.
    body = _request_body.as_dict()
    move_project = project_move_target(ctx, current, _request_body)
    requested_assignee = (
        assignee_user_id_for_task(actor, body, current.get("assigneeUserId"))
        if _request_body.names_assignee()
        else None
    )
    with task_request_errors():
        task = update_task_record(
            ctx,
            actor,
            current,
            TaskPatchRequest(
                body=body,
                reader=request_reader(),
                requested_assignee=requested_assignee,
                move_project=move_project,
                reload=lambda: get_task_for_actor(ctx.task_store, task_id, actor),
                automation_store=ctx.automation_store,
            ),
        )
    return public_task(task)


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_or_404(ctx.task_store, task_id)
    if not actor.get("isAdmin") and current.get("ownerUserId") != actor.get("userId"):
        raise HTTPException(403, "task_delete_forbidden")
    if not current.get("deletedAt"):
        ensure_task_project_writable(ctx, current)
    try:
        lifecycle = ctx.execution_lifecycle
        with ctx.registry.dispatch_lock, lifecycle.admission_scope():
            result = delete_task_record(ctx, task_id, actor, execution_lifecycle=lifecycle)
    except TaskDeletionError as error:
        status_code = {
            "task_not_found": 404,
            "task_delete_forbidden": 403,
            "task_execution_active": 409,
        }.get(error.code, 409)
        raise HTTPException(status_code, error.code) from error
    logger.info(
        "Task deleted",
        task_id=task_id,
        actor=actor.get("userId") or actor.get("username"),
        outcome=result["outcome"],
    )
    return public_task_envelope(result)


@router.put("/tasks/{task_id}/assignment")
def assign_task(
    task_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    ensure_task_project_writable(ctx, current)
    with task_request_errors():
        return _assign_task(ctx, actor, current, _request_body)


def _assign_task(
    ctx: AppContext, actor: Actor, current: dict[str, Any], body: dict[str, Any]
) -> dict[str, Any]:
    task_id = current["id"]
    ensure_issue_in_project(current)
    if task_has_active_linked_session(ctx.session_store, current):
        raise HTTPException(409, "task_execution_active")
    assigned_agent_id = (
        string_field(body, "agentId") or string_field(body, "assignedAgentId") or None
    )
    assigned_team_id = (
        string_field(body, "teamId") or string_field(body, "assignedTeamId") or None
    )
    if assigned_agent_id and assigned_team_id:
        raise HTTPException(400, "task_agent_and_team_conflict")
    validate_project_task_assignment(
        ctx,
        current,
        assigned_agent_id=assigned_agent_id,
        assigned_team_id=assigned_team_id,
    )
    if assigned_team_id:
        team_for_assignment(
            ctx,
            actor,
            assigned_team_id,
            expected_user_id=current.get("assigneeUserId")
            or current.get("ownerUserId")
            or actor["userId"],
        )
        try:
            task_thread_ownership(
                {**current, "assignedTeamId": assigned_team_id},
                team_store=ctx.team_store,
                agent_store=ctx.agent_store,
            )
        except TeamDispatchError as error:
            raise HTTPException(409, error.code) from error
        return public_task_envelope(update_task_unless_dispatching(
            ctx,
            task_id,
            {
                "status": "assigned",
                "assignedAgentId": None,
                "assignedTeamId": assigned_team_id,
            },
        ))
    logical_agent = logical_agent_for_assignment(
        ctx,
        actor,
        assigned_agent_id,
        expected_user_id=current.get("assigneeUserId")
        or current.get("ownerUserId")
        or actor["userId"],
    )
    if not logical_agent or not assigned_agent_id:
        raise HTTPException(400, "agentId is required for task assignment.")
    return public_task_envelope(update_task_unless_dispatching(
        ctx,
        task_id,
        {
            "status": "assigned",
            "assignedAgent": logical_agent["executorKind"],
            "assignedAgentId": assigned_agent_id,
            "assignedTeamId": None,
        },
    ))
