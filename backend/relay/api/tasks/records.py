from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from loguru import logger

from ...tasks.review import task_review
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
    get_task_header_for_actor,
    get_task_or_404,
    owner_user_id_for_create,
    request_actor,
)
from ..bodies import JsonBodyDep, string_field
from ..conditional_get import private_conditional_json
from ..deps import AppContext, AppContextDep
from ..projects.access import ensure_task_project_writable, project_for_owner, project_session_fields
from ..schemas import (
    TaskCreateBody,
    TaskCreateBodyDep,
    TaskPatchBody,
    TaskPatchBodyDep,
    openapi_body,
)
from .prerequisites import task_with_prerequisite_view, with_waiting_on, with_dependency_summaries
from .automation_lists import read_automation_page
from .issues import read_issue_page, task_page_number
from .thread_tasks import read_thread_tasks
from ..connections.routes import connection_errors, service as connection_service
from ...persistence.engine import store_transaction
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

# Home uses the same links, waits and assignment as the full Task list but
# does not render descriptions, schedules, artifact metadata or histories.
HOME_TASK_FIELDS = frozenset({
    "id", "number", "title", "priority", "status", "isRoutine", "ownerUserId", "assigneeUserId",
    "projectId", "computerId", "sourceRoutineId", "linkedSessionIds", "createdAt", "updatedAt",
    "startedAt", "finishedAt", "dueDate", "scheduledFor", "routineState", "routineNextRunAt",
    "assignedAgentId", "assignedTeamId", "assignedWorkflowId", "workspaceBinding", "workspaceWaiting", "dispatchClaim",
    "dispatchOutcome", "prerequisiteTaskIds", "waitingOn", "waitingOnSummaries", "blockerReason", "awaiting",
})


def task_list_limit(raw_limit: str | None) -> int | None:
    if raw_limit is None:
        return None
    try:
        requested_limit = int(raw_limit)
    except ValueError as error:
        raise HTTPException(400, "limit must be an integer.") from error
    return min(max(1, requested_limit), TASK_LIST_MAX_LIMIT)


def _user_task_flow(ctx: AppContext, user_id: str) -> dict[str, Any]:
    return {
        "flowPolicy": {"wipLimit": ctx.task_store.wip_limit_for_user(user_id), "scope": "user"},
        "flowUsage": {"userId": user_id, "occupied": ctx.task_store.count_wip(user_id)},
    }


@router.get("/tasks")
def list_tasks(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    view = request.query_params.get("view")
    if view == "summary" and (thread_id := request.query_params.get("threadId")):
        return read_thread_tasks(ctx, actor, thread_id)
    scope = request.query_params.get("scope")
    layout = request.query_params.get("layout")
    if view == "summary" and scope in ("issues", "board") and layout in ("list", "board"):
        return read_issue_page(ctx, actor, request, layout, workspace_board=scope == "board")
    if view == "summary" and scope == "automations" and layout == "list":
        return read_automation_page(ctx, actor, request)
    if view == "summary" and scope == "project-dashboard":
        project_id = request.query_params.get("projectId", "")
        if not project_id:
            raise HTTPException(400, "projectId is required.")
        raw_today = request.query_params.get("today")
        try:
            today = date.fromisoformat(raw_today) if raw_today else datetime.now(UTC).date()
        except ValueError as error:
            raise HTTPException(400, "Invalid calendar date.") from error
        return {
            "tasks": [], "projectDashboard": ctx.task_store.project_dashboard(actor["userId"], project_id, today),
            **_user_task_flow(ctx, actor["userId"]),
        }
    if view == "prerequisite-choices":
        project_id = request.query_params.get("projectId", "")
        project = project_for_owner(ctx, project_id, actor["userId"], require_enabled=False)
        if project and (task_id := request.query_params.get("taskId")):
            task = get_task_header_for_actor(ctx.task_store, task_id, actor)
            if task.get("projectId") != project["id"] or task.get("isRoutine"):
                raise HTTPException(404, "Task not found in this Project.")
            query = request.query_params.get("q", "").strip().lower()
            if "\x00" in query:
                raise HTTPException(400, "Invalid prerequisite search.")
            return ctx.task_store.prerequisite_choice_page(
                actor["userId"], project["id"], task_id, query, task_page_number(request.query_params.get("page", "")),
            )
        return {"tasks": ctx.task_store.prerequisite_choices(actor["userId"], project["id"])} if project else {"tasks": []}
    if view == "summary" and scope == "home":
        rows, projects, untriaged = ctx.task_store.home_tasks(actor["userId"])
        tasks = with_dependency_summaries(ctx, actor, with_waiting_on(ctx, [public_task(task) for task in rows]))
        return {
            "tasks": [{"description": "", **{name: value for name, value in task.items() if name in HOME_TASK_FIELDS}}
                      for task in tasks],
            "homeProjects": projects,
            "homeUntriaged": untriaged,
        }
    summary_view = view == "summary"
    limit = task_list_limit(request.query_params.get("limit"))
    if summary_view and hasattr(ctx.task_store, "list_task_summaries"):
        computer_id = request.query_params.get("computerId") or None
        if computer_id and "\x00" in computer_id:
            raise HTTPException(400, "Invalid Computer id.")
        tasks = ctx.task_store.list_task_summaries(
            user_id=actor["userId"],
            limit=limit,
            project_id=request.query_params.get("projectId") or None,
            scope=scope,
            computer_id=computer_id,
        )
    else:
        tasks = ctx.task_store.list_tasks(
            user_id=actor["userId"],
            limit=limit,
        )
    return {
        "tasks": with_dependency_summaries(ctx, actor, with_waiting_on(ctx, [public_task(task) for task in tasks])),
        **_user_task_flow(ctx, actor["userId"]),
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
    with task_request_errors(), connection_errors(), store_transaction(ctx.task_store.engine):
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
        if "connectionGrants" in body:
            connection_service(ctx).set_grants(owner, "automation" if task.get("isRoutine") else "task", task["id"], body["connectionGrants"])
        if task.get("isRoutine") and task.get("routineState") == "active":
            connection_service(ctx).check_target(owner, "automation", task["id"])
    return public_task(task)


@router.get("/tasks/{task_id}", response_model=None)
def get_task(task_id: str, request: Request, ctx: AppContextDep) -> Response | dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    record_view = request.query_params.get("view") == "record"
    task = get_task_for_actor(ctx.task_store, task_id, actor, record_view=record_view)
    if (record_view and task.get("ownerUserId") and not task.get("projectId") and not task.get("computerId")
            and not (task.get("workspaceBinding") or {}).get("computerId") and task.get("linkedSessionIds")):
        identity = ctx.task_store.linked_computer(task["ownerUserId"], task["linkedSessionIds"])
        if identity:
            task = {**task, "linkedComputerId": identity}
    if record_view and (task.get("isRoutine") or task.get("sourceRoutineId")):
        task = {**task, **ctx.task_store.automation_record_context(actor["userId"], task)}
    result = task_with_prerequisite_view(ctx, public_task(task), include_summaries=record_view)
    if not record_view:
        return result
    # The record's Runs and Activity tabs read their own pages.
    result.pop("occurrenceIds", None)
    result.pop("lastActivity", None)
    return private_conditional_json(request, result)


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
    with task_request_errors(), connection_errors(), store_transaction(ctx.task_store.engine):
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
        if "connectionGrants" in body:
            if task.get("sourceRoutineId"):
                raise HTTPException(409, "connection_generated_task_read_only")
            connection_service(ctx).set_grants(actor["userId"], "automation" if task.get("isRoutine") else "task", task["id"], body["connectionGrants"])
        if task.get("isRoutine") and task.get("routineState") == "active":
            connection_service(ctx).check_target(actor["userId"], "automation", task["id"])
    return public_task(task)


@router.get("/tasks/{task_id}/review")
def review_task(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    return task_review(ctx, task)


@router.get("/tasks/{task_id}/workflow-history")
def task_workflow_history(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor, record_view=True)
    return {"threads": ctx.session_store.list_session_workflows(task.get("linkedSessionIds") or [], actor["userId"])}


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_or_404(ctx.task_store, task_id)
    if current.get("ownerUserId") != actor.get("userId"):
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
