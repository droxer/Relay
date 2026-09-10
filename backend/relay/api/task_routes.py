from __future__ import annotations

import asyncio
from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger

from ..core.ids import new_database_id
from ..persistence.stores import (
    task_priority,
    task_routine_cadence,
    task_routine_type,
    task_status,
    valid_agent,
)
from ..persistence.task_store import TaskExecutionActiveError
from ..services.task_deletion import (
    TaskDeletionError,
    task_has_active_linked_session,
)
from ..services.task_deletion import (
    delete_task as delete_task_record,
)
from ..services.task_dispatch import (
    implicit_group_assignments_for_task,
    start_task_on_ready_node,
)
from ..services.task_dispatch import (
    start_routine_occurrence_on_ready_node as dispatch_routine_occurrence,
)
from ..services.produced_files import file_currency, listing_directories, live_status
from ..services.task_workspace import (
    task_workspace_subpath,
    recorded_task_workspace,
)
from ..services.team_dispatch import (
    TeamDispatchError,
    task_thread_assignments,
    task_thread_ownership,
)
from ..sessions import SessionController
from ..tasks import (
    materialize_legacy_agent_assignment,
    materialize_legacy_task_assignment,
    next_routine_date,
    task_goal_text,
)
from .deps import AppContext, AppContextDep
from .helpers import (
    actor_can_access_record,
    artifact_index_item,
    assignee_employee_id_for_task,
    assignment_list,
    get_task_for_actor,
    json_body,
    owner_employee_id_for_create,
    participants_for_assignments,
    request_actor,
    string_field,
    workspace_artifact_key,
    workspace_artifacts,
)
from .project_helpers import project_for_owner, project_session_fields
from .workspace_transport import (
    dispatch_workspace_command,
    live_workspace_file,
    live_workspace_listing,
    raise_workspace_error,
    workspace_path,
)

router = APIRouter()


def update_task_unless_dispatching(
    ctx: AppContextDep, task_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    try:
        return ctx.task_store.update_task_if_not_dispatching(task_id, payload)
    except TaskExecutionActiveError as error:
        raise HTTPException(409, "task_execution_active") from error


def logical_agent_for_assignment(
    ctx: AppContextDep,
    actor: dict[str, Any],
    agent_id: str | None,
    *,
    expected_employee_id: str | None = None,
) -> dict[str, Any] | None:
    if not agent_id:
        return None
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Logical agent not found.")
    if not agent.get("enabled", True):
        raise HTTPException(409, "agent_disabled")
    allowed_employee_id = expected_employee_id or actor["employeeId"]
    if agent.get("supervisorEmployeeId") != allowed_employee_id:
        raise HTTPException(403, "Logical agent is not available to the task assignee.")
    if (
        not actor["isAdmin"]
        and agent.get("supervisorEmployeeId") != actor["employeeId"]
    ):
        raise HTTPException(403, "Logical agent access denied.")
    return agent


def team_for_assignment(
    ctx: AppContextDep,
    actor: dict[str, Any],
    team_id: str | None,
    *,
    expected_employee_id: str,
    require_actor_access: bool = True,
) -> dict[str, Any] | None:
    if not team_id:
        return None
    team = ctx.team_store.get_team(team_id)
    if not team or team.get("deletedAt"):
        raise HTTPException(404, "Team not found.")
    if not team.get("enabled", True):
        raise HTTPException(409, "team_disabled")
    if team.get("ownerEmployeeId") != expected_employee_id:
        raise HTTPException(403, "Team is not available to the task assignee.")
    if (
        require_actor_access
        and not actor["isAdmin"]
        and team.get("ownerEmployeeId") != actor["employeeId"]
    ):
        raise HTTPException(403, "Team access denied.")
    return team


def validate_project_task_assignment(
    ctx: AppContextDep,
    task: dict[str, Any],
    *,
    assigned_agent_id: str | None,
    assigned_team_id: str | None,
) -> None:
    project_id = task.get("projectId")
    if not project_id:
        return
    if assigned_team_id:
        raise HTTPException(400, "project_team_assignment_unsupported")
    if not assigned_agent_id:
        return
    project = ctx.project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    if assigned_agent_id not in {
        member.get("agentId") for member in project.get("members", [])
    }:
        raise HTTPException(400, "project_agent_not_member")


def date_field(body: dict[str, Any], key: str) -> str | None:
    if key not in body:
        return None
    raw = body.get(key)
    if raw in (None, ""):
        return ""
    if not isinstance(raw, str):
        raise HTTPException(400, f"{key} must be a YYYY-MM-DD date.")
    value = raw.strip()
    try:
        date.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, f"{key} must be a YYYY-MM-DD date.")
    return value


def bool_field(body: dict[str, Any], key: str) -> bool | None:
    if key not in body:
        return None
    raw = body.get(key)
    if isinstance(raw, bool):
        return raw
    raise HTTPException(400, f"{key} must be a boolean.")


def routine_fields(
    body: dict[str, Any],
    *,
    current: dict[str, Any] | None = None,
    calendar_date: date | None = None,
) -> dict[str, Any]:
    has_routine_input = any(
        key in body
        for key in (
            "isRoutine",
            "routineType",
            "routineCadence",
            "routineNextRunDate",
            "routineEnabled",
        )
    )
    if not has_routine_input:
        return {}
    is_routine = bool_field(body, "isRoutine")
    enabled = bool_field(body, "routineEnabled")
    routine_type = (
        task_routine_type(body.get("routineType")) if "routineType" in body else None
    )
    cadence = (
        task_routine_cadence(body.get("routineCadence"))
        if "routineCadence" in body
        else None
    )
    if "routineType" in body and body.get("routineType") and not routine_type:
        raise HTTPException(400, "routineType must be one of: task, job.")
    if "routineCadence" in body and body.get("routineCadence") and not cadence:
        raise HTTPException(
            400, "routineCadence must be one of: daily, weekly, monthly, custom."
        )
    has_next_run_input = "routineNextRunDate" in body
    next_run = date_field(body, "routineNextRunDate") if has_next_run_input else None
    next_is_routine = bool(
        is_routine
        if is_routine is not None
        else current.get("isRoutine")
        if current
        else True
    )
    next_enabled = (
        enabled
        if enabled is not None
        else (
            bool((current or {}).get("routineEnabled")) if current else next_is_routine
        )
    )
    resolved_cadence = cadence or (current or {}).get("routineCadence") or "weekly"
    cadence_changed = bool(
        current and cadence and cadence != current.get("routineCadence")
    )
    reenabled = bool(current and enabled is True and not current.get("routineEnabled"))
    if (
        next_is_routine
        and resolved_cadence != "custom"
        and (
            (current is None and not has_next_run_input) or cadence_changed or reenabled
        )
    ):
        today = calendar_date or datetime.now(timezone.utc).date()
        calculated_next_run = next_routine_date(today, resolved_cadence, today)
        next_run = calculated_next_run.isoformat() if calculated_next_run else None
    effective_next_run = (
        next_run
        if has_next_run_input or next_run is not None
        else (current or {}).get("routineNextRunDate")
    )
    if (
        next_is_routine
        and next_enabled
        and resolved_cadence == "custom"
        and not effective_next_run
    ):
        raise HTTPException(
            400, "routineNextRunDate is required for an enabled custom routine."
        )
    return {
        "isRoutine": is_routine if is_routine is not None else next_is_routine,
        "routineType": routine_type or (current or {}).get("routineType") or "task",
        "routineCadence": resolved_cadence,
        "routineNextRunDate": next_run,
        "routineEnabled": next_enabled,
    }


async def start_routine_occurrence_on_ready_node(
    ctx: AppContextDep,
    routine: dict[str, Any],
    actor: dict[str, Any],
    *,
    agent: str | None,
    assignments: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    return await dispatch_routine_occurrence(
        ctx,
        routine,
        actor,
        agent=agent,
        assignments=assignments,
        run_date=ctx.today(),
    )


def complete_linked_task_sessions(
    ctx: AppContextDep, task: dict[str, Any], outcome: str
) -> None:
    controller = SessionController(ctx.session_store)
    for session_id in task.get("linkedSessionIds", []):
        try:
            session = ctx.session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            continue
        except Exception:  # noqa: BLE001 - one unreadable linked session must not block the rest
            logger.warning(
                "Unexpected error reading linked session",
                session_id=session_id,
                exc_info=True,
            )
            continue
        if session.get("status") in ("completed", "failed", "cancelled"):
            continue
        run_request = ctx.registry.daemon_store.active_run_request_for_session_any_node(
            session_id
        )
        if run_request:
            terminal_reason = "Linked task completed before agent delivery finished."
            ctx.registry.cancel_run_request_before_delivery(
                run_request["id"], terminal_reason
            )
            if ctx.registry.get(run_request["nodeId"]):
                ctx.registry.cancel_active_run(
                    run_request["nodeId"], session_id, terminal_reason
                )
        controller.complete_session(session_id, outcome)


@router.get("/tasks")
def list_tasks(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    summary_view = request.query_params.get("view") == "summary"
    raw_limit = request.query_params.get("limit")
    limit: int | None = None
    if raw_limit is not None:
        try:
            requested_limit = int(raw_limit)
        except ValueError as error:
            raise HTTPException(400, "limit must be an integer.") from error
        limit = min(max(1, requested_limit), 500)
    if summary_view and hasattr(ctx.task_store, "list_task_summaries"):
        tasks = ctx.task_store.list_task_summaries(
            employee_id=None if actor["isAdmin"] else actor["employeeId"],
            limit=limit,
        )
    else:
        accessible = [
            task
            for task in ctx.task_store.list_tasks()
            if actor_can_access_record(actor, task)
        ]
        tasks = accessible if limit is None else accessible[:limit]
    return {"tasks": tasks}


@router.post("/tasks", status_code=201)
async def create_task(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await json_body(request)
    title = string_field(body, "title") or string_field(body, "taskGoal")
    if not title:
        raise HTTPException(400, "title is required.")
    owner = owner_employee_id_for_create(actor, body)
    assignee = assignee_employee_id_for_task(actor, body, owner)
    project_id = string_field(body, "projectId") or None
    project = project_for_owner(ctx, project_id, owner)
    if project and "assignments" in body:
        raise HTTPException(400, "project_assignment_override_unsupported")
    assigned_agent_id = string_field(body, "assignedAgentId") or None
    assigned_team_id = string_field(body, "assignedTeamId") or None
    if assigned_agent_id and assigned_team_id:
        raise HTTPException(400, "task_agent_and_team_conflict")
    if "assignedAgent" in body:
        raise HTTPException(400, "assignedAgent is read-only; use assignedAgentId.")
    logical_agent = logical_agent_for_assignment(
        ctx, actor, assigned_agent_id, expected_employee_id=assignee
    )
    if logical_agent:
        assignee = logical_agent["supervisorEmployeeId"]
    if (
        project
        and assigned_agent_id
        and assigned_agent_id
        not in {member["agentId"] for member in project.get("members", [])}
    ):
        raise HTTPException(400, "project_agent_not_member")
    if project and assigned_team_id:
        raise HTTPException(400, "project_team_assignment_unsupported")
    team_for_assignment(
        ctx,
        actor,
        assigned_team_id,
        expected_employee_id=assignee,
    )
    agent = logical_agent["executorKind"] if logical_agent else None
    status = task_status(body.get("status"))
    if "status" in body and not status:
        raise HTTPException(400, "status is not a recognized task status.")
    if status == "assigned" and not (project or assigned_agent_id or assigned_team_id):
        raise HTTPException(400, "assigned status requires an agent or team.")
    routine = routine_fields(body, calendar_date=ctx.today())
    if (
        routine.get("isRoutine")
        and not (project or assigned_agent_id or assigned_team_id)
        and "routineEnabled" not in body
    ):
        routine["routineEnabled"] = False
    if routine.get("routineEnabled") and not (
        project or assigned_agent_id or assigned_team_id
    ):
        raise HTTPException(400, "An enabled routine requires an agent or team.")
    creates_thread = body.get("createSession") is True or isinstance(
        body.get("assignments"), list
    )
    if creates_thread and assigned_team_id:
        try:
            task_thread_ownership(
                {
                    "ownerEmployeeId": owner,
                    "assigneeEmployeeId": assignee,
                    "assignedTeamId": assigned_team_id,
                },
                team_store=ctx.team_store,
                agent_store=ctx.agent_store,
            )
        except TeamDispatchError as error:
            raise HTTPException(409, error.code) from error
    task = ctx.task_store.create_task(
        {
            "title": title,
            "description": string_field(body, "description"),
            "priority": task_priority(body.get("priority")) or "normal",
            "ownerEmployeeId": owner,
            "assigneeEmployeeId": assignee,
            **({"projectId": project["id"]} if project else {}),
            "dueDate": date_field(body, "dueDate"),
            "status": status,
            **(
                {
                    "assignedAgent": agent,
                    "assignedAgentId": assigned_agent_id,
                }
                if agent and assigned_agent_id
                else {}
            ),
            **({"assignedTeamId": assigned_team_id} if assigned_team_id else {}),
            **routine,
        }
    )
    logger.info("Task created", task_id=task["id"], title=title, owner=owner)
    if agent:
        logger.info(
            "Task assigned", task_id=task["id"], agent=agent, agent_id=assigned_agent_id
        )
    if creates_thread:
        project_fields = project_session_fields(ctx, project) if project else {}
        workspace_path = project_fields.pop(
            "workspace_path", string_field(body, "workspacePath") or "/workspace"
        )
        try:
            thread_ownership = task_thread_ownership(
                task, team_store=ctx.team_store, agent_store=ctx.agent_store
            )
        except TeamDispatchError as error:
            raise HTTPException(409, error.code) from error
        assignments = task_thread_assignments(
            task,
            assignment_list(body.get("assignments")),
            team_store=ctx.team_store,
            agent_store=ctx.agent_store,
        )
        controller = SessionController(
            ctx.session_store,
            task_store=ctx.task_store,
            task_id=task["id"],
            workspace_path=workspace_path,
            **project_fields,
            **thread_ownership,
        )
        session = controller.create_session(
            task_goal_text(task),
            participants_for_assignments(assignments, None),
            True,
        )
        logger.info(
            "Session created from task",
            task_id=task["id"],
            session_id=session["id"],
            workspace_path=workspace_path,
        )
        if assignments:
            controller.assign_session(session["id"], assignments)
        task = ctx.task_store.link_session(task["id"], session["id"])
    return task


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    return get_task_for_actor(ctx.task_store, task_id, actor)


@router.patch("/tasks/{task_id}")
async def update_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    body = await json_body(request)
    title = string_field(body, "title") or None
    description = (
        body.get("description") if isinstance(body.get("description"), str) else None
    )
    priority = task_priority(body.get("priority"))
    status = task_status(body.get("status"))
    if "status" in body and not status:
        raise HTTPException(400, "status is not a recognized task status.")
    due_date = date_field(body, "dueDate")
    routine = routine_fields(body, current=current, calendar_date=ctx.today())
    assignee = (
        assignee_employee_id_for_task(actor, body, current.get("assigneeEmployeeId"))
        if "assigneeEmployeeId" in body or "assignee_employee_id" in body
        else None
    )
    agent = valid_agent(body.get("assignedAgent")) if "assignedAgent" in body else None
    assigned_agent_id = (
        string_field(body, "assignedAgentId") if "assignedAgentId" in body else None
    )
    assigned_team_id = (
        string_field(body, "assignedTeamId") if "assignedTeamId" in body else None
    )
    if assigned_agent_id and assigned_team_id:
        raise HTTPException(400, "task_agent_and_team_conflict")
    validate_project_task_assignment(
        ctx,
        current,
        assigned_agent_id=assigned_agent_id,
        assigned_team_id=assigned_team_id,
    )
    if "assignedAgent" in body:
        raise HTTPException(400, "assignedAgent is read-only; use assignedAgentId.")
    assignee_changed = bool(assignee and assignee != current.get("assigneeEmployeeId"))
    if (
        assignee_changed
        and (current.get("assignedAgentId") or current.get("assignedTeamId"))
        and "assignedAgentId" not in body
        and "assignedTeamId" not in body
    ):
        raise HTTPException(
            400,
            "Changing the assignee requires an assignment for the new employee, or an explicit empty assignment.",
        )
    if (
        assignee_changed
        and current.get("ownerEmployeeId") == current.get("assigneeEmployeeId")
        and assignee != current.get("ownerEmployeeId")
    ):
        raise HTTPException(
            403,
            "An employee-owned task cannot be reassigned to another employee.",
        )
    logical_agent = None
    if not (
        assigned_agent_id
        and assigned_agent_id == current.get("assignedAgentId")
        and not assignee_changed
    ):
        logical_agent = logical_agent_for_assignment(
            ctx,
            actor,
            assigned_agent_id,
            expected_employee_id=assignee
            or current.get("assigneeEmployeeId")
            or current.get("ownerEmployeeId"),
        )
    if logical_agent:
        if agent and agent != logical_agent["executorKind"]:
            raise HTTPException(
                400, "assignedAgent does not match assignedAgentId executor kind."
            )
        agent = logical_agent["executorKind"]
        assignee = logical_agent["supervisorEmployeeId"]
    expected_team_employee_id = (
        assignee
        or current.get("assigneeEmployeeId")
        or current.get("ownerEmployeeId")
        or actor["employeeId"]
    )
    unchanged_team_assignment = bool(
        assigned_team_id
        and assigned_team_id == current.get("assignedTeamId")
        and not assignee_changed
    )
    team_for_assignment(
        ctx,
        actor,
        assigned_team_id,
        expected_employee_id=expected_team_employee_id,
        require_actor_access=not unchanged_team_assignment,
    )
    if (
        not title
        and description is None
        and not priority
        and not status
        and due_date is None
        and assignee is None
        and not agent
        and "assignedAgentId" not in body
        and "assignedTeamId" not in body
        and not routine
    ):
        raise HTTPException(
            400,
            "PATCH requires title, description, priority, dueDate, assigneeEmployeeId, assignedAgentId, assignedTeamId, or status.",
        )
    next_routine_enabled = routine.get("routineEnabled", current.get("routineEnabled"))
    next_is_routine = routine.get("isRoutine", current.get("isRoutine"))
    next_agent_id = (
        assigned_agent_id
        if "assignedAgentId" in body
        else current.get("assignedAgentId")
    )
    next_team_id = (
        assigned_team_id if "assignedTeamId" in body else current.get("assignedTeamId")
    )
    if "assignedAgentId" in body and assigned_agent_id:
        next_team_id = None
    if "assignedTeamId" in body and assigned_team_id:
        next_agent_id = None
    assignment_changed = next_agent_id != current.get(
        "assignedAgentId"
    ) or next_team_id != current.get("assignedTeamId")
    if (assignment_changed or assignee_changed) and task_has_active_linked_session(
        ctx.session_store, current
    ):
        raise HTTPException(409, "task_execution_active")
    if (
        next_is_routine
        and next_routine_enabled
        and not (current.get("projectId") or next_agent_id or next_team_id)
    ):
        raise HTTPException(400, "An enabled routine requires an agent or team.")
    assignment_clear_requested = assignment_changed and not (
        next_agent_id or next_team_id
    )
    if (status or current.get("status")) == "assigned" and not (
        current.get("projectId") or next_agent_id or next_team_id
    ):
        if assignment_clear_requested:
            status = "backlog"
        else:
            raise HTTPException(400, "assigned status requires an agent or team.")
    assignment_patch: dict[str, Any] = {}
    if assignment_changed:
        assignment_patch = {
            "assignedAgentId": next_agent_id,
            "assignedTeamId": next_team_id,
            **(
                {
                    "assignedAgent": (
                        logical_agent["executorKind"]
                        if logical_agent
                        else current.get("assignedAgent")
                    )
                }
                if next_agent_id
                else {}
            ),
        }
    update_payload = {
        "title": title,
        "description": description,
        "priority": priority,
        "status": status,
        "dueDate": due_date,
        "assigneeEmployeeId": assignee,
        **routine,
        **assignment_patch,
    }
    task = (
        update_task_unless_dispatching(ctx, task_id, update_payload)
        if status or assignment_changed or assignee_changed
        else ctx.task_store.update_task(task_id, update_payload)
    )
    if status == "done":
        complete_linked_task_sessions(ctx, task, "Task marked done.")
        task = ctx.task_store.get_task(task_id)
    return task


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    try:
        result = delete_task_record(ctx, task_id, actor)
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
        actor=actor.get("employeeId") or actor.get("username"),
        outcome=result["outcome"],
    )
    return result


@router.put("/tasks/{task_id}/assignment")
async def assign_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    if task_has_active_linked_session(ctx.session_store, current):
        raise HTTPException(409, "task_execution_active")
    body = await json_body(request)
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
            expected_employee_id=current.get("assigneeEmployeeId")
            or current.get("ownerEmployeeId")
            or actor["employeeId"],
        )
        try:
            task_thread_ownership(
                {**current, "assignedTeamId": assigned_team_id},
                team_store=ctx.team_store,
                agent_store=ctx.agent_store,
            )
        except TeamDispatchError as error:
            raise HTTPException(409, error.code) from error
        return update_task_unless_dispatching(
            ctx,
            task_id,
            {
                "status": "assigned",
                "assignedAgentId": None,
                "assignedTeamId": assigned_team_id,
            },
        )
    logical_agent = logical_agent_for_assignment(
        ctx,
        actor,
        assigned_agent_id,
        expected_employee_id=current.get("assigneeEmployeeId")
        or current.get("ownerEmployeeId")
        or actor["employeeId"],
    )
    if not logical_agent or not assigned_agent_id:
        raise HTTPException(400, "agentId is required for task assignment.")
    return update_task_unless_dispatching(
        ctx,
        task_id,
        {
            "status": "assigned",
            "assignedAgent": logical_agent["executorKind"],
            "assignedAgentId": assigned_agent_id,
            "assignedTeamId": None,
        },
    )


@router.post("/tasks/{task_id}/runs", status_code=202)
async def start_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    body = await json_body(request)
    raw_assignments = body.get("assignments")
    assignments = assignment_list(raw_assignments)
    if body.get("agent") is not None:
        raise HTTPException(400, "agent is read-only; start through assignedAgentId.")
    if assignments and task.get("assignedTeamId"):
        assignments = []
    if (
        task.get("assignedAgentId")
        and isinstance(raw_assignments, list)
        and raw_assignments
    ):
        requested_agent_ids = [
            item.get("agentId") if isinstance(item, dict) else None
            for item in raw_assignments
        ]
        if requested_agent_ids != [task.get("assignedAgentId")]:
            raise HTTPException(409, "task_assignment_override")
        if not task.get("assignedAgent"):
            raise HTTPException(409, "task_assignment_invalid")
        assignments = [
            {
                "agentId": task["assignedAgentId"],
                "agent": task["assignedAgent"],
            }
        ]
    if (
        not task.get("assignedTeamId")
        and assignments
        and any(not assignment.get("agentId") for assignment in assignments)
    ):
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
                updated = ctx.task_store.record_dispatch_outcome(
                    task_id,
                    "rejected",
                    code="agent_not_found",
                    message="Every start assignment requires an available agent.",
                )
                return {
                    "task": updated,
                    "session": None,
                    "dispatch": {
                        "state": "rejected",
                        "code": "agent_not_found",
                        "message": "Every start assignment requires an available agent.",
                    },
                }
            materialized_assignments.append({**assignment, **materialized})
        assignments = materialized_assignments
    if (
        not assignments
        and task.get("assignedAgent")
        and not task.get("assignedAgentId")
    ):
        task = materialize_legacy_task_assignment(
            task,
            task_store=ctx.task_store,
            registry=ctx.registry,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        )
        if not task:
            updated = ctx.task_store.record_dispatch_outcome(
                task_id,
                "queued",
                code="agent_offline",
                message="No compatible runtime is currently available for this legacy task.",
            )
            return {
                "task": updated,
                "session": None,
                "dispatch": {
                    "state": "queued",
                    "code": "agent_offline",
                    "message": "No compatible runtime is currently available for this legacy task.",
                },
            }
    if not assignments and task.get("assignedAgentId") and task.get("assignedAgent"):
        assignments = [
            {
                "agentId": task["assignedAgentId"],
                "agent": task["assignedAgent"],
            }
        ]
    if not assignments and not task.get("assignedTeamId") and not task.get("projectId"):
        assignments = implicit_group_assignments_for_task(ctx, task)
    agent = valid_agent(task.get("assignedAgent"))
    if not agent and assignments:
        agent = assignments[0]["agent"]
    if not agent and not task.get("assignedTeamId") and not task.get("projectId"):
        updated = ctx.task_store.record_dispatch_outcome(
            task_id,
            "rejected",
            code="agent_not_found",
            message="Select a named agent before starting this task.",
        )
        return {
            "task": updated,
            "session": None,
            "dispatch": {
                "state": "rejected",
                "code": "agent_not_found",
                "message": "Select a named agent before starting this task.",
            },
        }
    if task.get("isRoutine"):
        if not (
            task.get("projectId")
            or task.get("assignedAgentId")
            or task.get("assignedTeamId")
        ):
            updated = ctx.task_store.record_dispatch_outcome(
                task_id,
                "rejected",
                code="agent_not_found",
                message="A routine requires a named agent before it can start.",
            )
            return {
                "task": updated,
                "session": None,
                "dispatch": {
                    "state": "rejected",
                    "code": "agent_not_found",
                    "message": "A routine requires a named agent before it can start.",
                },
            }
        result = await start_routine_occurrence_on_ready_node(
            ctx, task, actor, agent=agent, assignments=assignments or None
        )
    else:
        result = await start_task_on_ready_node(
            ctx, task, actor, assignments=assignments or None
        )
    if not result or not result.get("session"):
        return (
            result
            if result
            else {
                "task": task,
                "session": None,
                "dispatch": {
                    "state": "rejected",
                    "code": "invalid_state",
                    "message": "This task cannot be started in its current state.",
                },
            }
        )
    return result


@router.post("/tasks/{task_id}/pickups", status_code=202)
async def pickup_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await json_body(request)
    current = get_task_for_actor(ctx.task_store, task_id, actor)
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
        expected_employee_id=current.get("assigneeEmployeeId")
        or current.get("ownerEmployeeId")
        or actor["employeeId"],
    )
    if not logical_agent or not agent_id:
        raise HTTPException(400, "agentId is required to pick up a task.")
    agent = logical_agent["executorKind"]
    task = update_task_unless_dispatching(
        ctx,
        task_id,
        {
            "assigneeEmployeeId": logical_agent["supervisorEmployeeId"],
            "status": "assigned",
            "assignedAgent": agent,
            "assignedAgentId": agent_id,
            "assignedTeamId": None,
        },
    )
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
    return result


def occurrence_tasks(
    ctx: Any, task: dict[str, Any], actor: dict[str, Any]
) -> list[dict[str, Any]]:
    """The routine's promoted occurrences the actor may read.

    A routine never runs itself — the scheduler promotes an occurrence task and
    that occurrence carries the run. Rolling its records up to the routine is
    what makes the routine's own surface show what its runs produced. An
    occurrence that was deleted, or that this actor cannot read, is skipped
    rather than failing the whole rollup.
    """
    if not task.get("isRoutine"):
        return []
    occurrences: list[dict[str, Any]] = []
    for occurrence_id in task.get("occurrenceIds") or []:
        try:
            occurrences.append(get_task_for_actor(ctx.task_store, occurrence_id, actor))
        except HTTPException:
            continue
        except Exception:  # noqa: BLE001 - one unreadable occurrence must not block the rest
            logger.warning(
                "Unexpected error reading routine occurrence",
                task_id=task.get("id"),
                occurrence_id=occurrence_id,
                exc_info=True,
            )
            continue
    return occurrences


@router.get("/tasks/{task_id}/events")
async def task_events(
    task_id: str,
    request: Request,
    ctx: AppContextDep,
    include: str | None = None,
) -> dict[str, Any]:
    """The task's event log — the run history behind its current state.

    `include=occurrences` additionally folds in the event logs of a routine's
    promoted occurrences, merged by timestamp, so the routine shows the runs it
    caused. Each event keeps its own `taskId`, so the caller can still tell the
    routine's own entries from an occurrence's. The default answer stays the
    task's own log verbatim — an event-sourced replay must never silently
    receive another task's events.
    """
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    events = list(task["events"])
    if include == "occurrences":
        for occurrence in occurrence_tasks(ctx, task, actor):
            events.extend(occurrence["events"])
        events.sort(key=lambda event: event.get("timestamp") or "")
    return {"events": events}


def newest_artifacts_by_file(
    ctx: Any, sources: list[tuple[str, str]], *, all_versions: bool = False
) -> dict[str, dict[str, Any]]:
    """Workspace artifacts across `(taskId, sessionId)` pairs, newest per file.

    A file regenerated by a later run must surface once, at its latest state,
    attributed to the run that produced that state. Every surface that counts
    or lists a task's generated files goes through here so the ledger's counts
    and the artifact list can never disagree.
    """
    newest: dict[str, dict[str, Any]] = {}
    for origin_task_id, session_id in sources:
        try:
            session = ctx.session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            continue  # A linked session may have been deleted; skip it.
        except Exception:  # noqa: BLE001 - one unreadable linked session must not block the rest
            logger.warning(
                "Unexpected error reading linked session for artifact aggregation",
                session_id=session_id,
                exc_info=True,
            )
            continue
        for artifact in workspace_artifacts(session):
            key = (
                f"{session_id}:{artifact['id']}"
                if all_versions
                else workspace_artifact_key(session, artifact)
            )
            current = newest.get(key)
            if current is None or (artifact.get("createdAt") or "") >= (
                current.get("createdAt") or ""
            ):
                newest[key] = {
                    **artifact_index_item(session, artifact),
                    "taskId": origin_task_id,
                }
    return newest


@router.get("/tasks/{task_id}/artifacts")
async def task_artifacts(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Generated files (documents, decks, spreadsheets, …) produced while working the task.

    Aggregates workspace artifacts across the task's linked sessions and dedupes
    to the newest record per workspace file, so a file regenerated in a later
    session surfaces once at its latest state. For a routine the rollup also
    covers its promoted occurrences — the routine itself never runs, so its
    files are always produced by an occurrence's sessions.
    """
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    sources: list[tuple[str, str]] = [
        (task_id, session_id) for session_id in task.get("linkedSessionIds", [])
    ]
    for occurrence in occurrence_tasks(ctx, task, actor):
        sources.extend(
            (occurrence["id"], session_id)
            for session_id in occurrence.get("linkedSessionIds", [])
        )
    ordered = sorted(
        newest_artifacts_by_file(
            ctx, sources, all_versions=request.query_params.get("versions") == "all"
        ).values(),
        key=lambda item: item.get("createdAt") or "",
        reverse=True,
    )
    return {"taskId": task_id, "artifacts": ordered}


async def _task_directory_listings(
    ctx: AppContext,
    task: dict[str, Any],
    actor: dict[str, Any],
    directories: list[str],
) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, Any]]:
    """Read live directories without letting an unavailable computer hide the index."""
    try:
        node, layout, subpath = _task_workspace_target(ctx, task, actor)
    except HTTPException as error:
        return {}, {
            "status": live_status(error),
            "entries": [],
            "path": directories[0],
        }

    async def _one(
        path: str,
    ) -> tuple[str, list[dict[str, Any]] | None, str | None]:
        try:
            event = await dispatch_workspace_command(
                ctx,
                node,
                _task_workspace_command(
                    task,
                    command_id=new_database_id(),
                    command_type="workspace.list",
                    path=path,
                    workspace_layout=layout,
                    workspace_subpath=subpath,
                ),
            )
            raise_workspace_error(event)
        except HTTPException as error:
            return path, None, live_status(error)
        if not event.get("exists"):
            return path, None, "not-created"
        return path, event.get("entries") or [], None

    results = await asyncio.gather(*(_one(path) for path in directories))
    listings: dict[str, dict[str, dict[str, Any]]] = {}
    root_entries: list[dict[str, Any]] = []
    root_failure: str | None = None
    for path, entries, failure in results:
        if path == directories[0]:
            root_failure = failure
        if entries is None:
            continue
        listings[path] = {entry["name"]: entry for entry in entries}
        if path == directories[0]:
            root_entries = entries
    if root_failure:
        return listings, {
            "status": root_failure,
            "entries": [],
            "path": directories[0],
        }
    return listings, {
        "status": "ok",
        "entries": root_entries,
        "path": directories[0],
    }


@router.get("/tasks/{task_id}/files")
async def task_files(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Return what the task produced, enriched by live workspace state."""
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    sources: list[tuple[str, str]] = [
        (task_id, session_id) for session_id in task.get("linkedSessionIds", [])
    ]
    for occurrence in occurrence_tasks(ctx, task, actor):
        sources.extend(
            (occurrence["id"], session_id)
            for session_id in occurrence.get("linkedSessionIds", [])
        )
    produced = sorted(
        newest_artifacts_by_file(
            ctx, sources, all_versions=request.query_params.get("versions") == "all"
        ).values(),
        key=lambda item: item.get("createdAt") or "",
        reverse=True,
    )
    root = workspace_path(request.query_params.get("path"))
    listings, live = await _task_directory_listings(
        ctx, task, actor, listing_directories(produced, root=root)
    )
    claimed = {item.get("workspaceRelativePath") for item in produced}
    return {
        "taskId": task_id,
        "produced": [
            {**item, "currency": file_currency(item, listings)} for item in produced
        ],
        "live": {
            **live,
            "entries": [
                entry
                for entry in live["entries"]
                if entry.get("path") not in claimed
            ],
        },
    }


def _task_workspace_target(
    ctx: Any, task: dict[str, Any], actor: dict[str, Any]
) -> tuple[dict[str, Any], str, str]:
    """Resolve live reads from the same recorded identity used for execution."""
    from ..core.computer_identity import computer_id

    nodes = ctx.registry.monitor_nodes()
    binding = recorded_task_workspace(task, ctx.session_store, nodes)
    if task.get("isRoutine"):
        # A routine is a browse-only parent; each occurrence owns its binding.
        for occurrence in reversed(occurrence_tasks(ctx, task, actor)):
            binding = recorded_task_workspace(occurrence, ctx.session_store, nodes)
            if binding:
                if binding["layout"] == "task":
                    binding = {**binding, "subpath": task_workspace_subpath(task)}
                break
    if not binding:
        reason = (
            "workspace-not-created"
            if not task.get("linkedSessionIds")
            else "placement-unavailable"
        )
        raise HTTPException(
            409 if reason == "workspace-not-created" else 503,
            {"reason": reason, "code": reason},
        )
    candidates = [
        node
        for node in nodes
        if computer_id(node) == binding["computerId"]
        and node.get("online")
        and not node.get("stale")
        and not node.get("retiredAt")
    ]
    if not candidates:
        raise HTTPException(
            503, {"reason": "computer-offline", "code": "computer-offline"}
        )
    if binding.get("workspaceRoot"):
        candidates = [
            node
            for node in candidates
            if node.get("workspacePath") == binding["workspaceRoot"]
        ]
        if not candidates:
            raise HTTPException(
                503,
                {"reason": "placement-unavailable", "code": "placement-unavailable"},
            )
    layout = binding["layout"]
    required = {
        "task": "task-workspaces",
        "project": "project-workspaces",
        "thread": "thread-workspaces",
    }.get(layout)
    node = next(
        (
            node
            for node in candidates
            if "workspace-read-shared" in (node.get("capabilities") or [])
            and (not required or required in (node.get("capabilities") or []))
        ),
        None,
    )
    if not node:
        raise HTTPException(
            503, {"reason": "workspace-unsupported", "code": "workspace-unsupported"}
        )
    subpath = (
        binding.get("subpath")
        if layout in ("task", "project")
        else binding.get("sessionId")
    )
    if not isinstance(subpath, str) or not subpath:
        raise HTTPException(
            503, {"reason": "placement-unavailable", "code": "placement-unavailable"}
        )
    return node, layout, subpath


def _task_workspace_command(
    task: dict[str, Any],
    *,
    command_id: str,
    command_type: str,
    path: str,
    workspace_layout: str,
    workspace_subpath: str,
) -> dict[str, Any]:
    return {
        "id": command_id,
        "type": command_type,
        # Task ids use the same validated database-id alphabet as sessions. The
        # daemon treats this only as a routing identifier; workspaceSubpath is
        # what selects the durable task root.
        "sessionId": task["id"]
        if workspace_layout in ("task", "project")
        else workspace_subpath,
        "workspaceLayout": workspace_layout,
        "workspaceSubpath": workspace_subpath,
        "path": path,
    }


@router.get("/tasks/{task_id}/workspace/status")
async def task_workspace_status(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Small polling response; never dispatches a filesystem read just to show a wait."""
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    waiting = task.get("workspaceWaiting")
    active = ctx.daemon_store.list_active_runs() if waiting else []
    if not waiting or not any(run["runId"] == waiting["runId"] for run in active):
        return {"waiting": False}
    result: dict[str, Any] = {"waiting": True}
    blocker = waiting.get("blockingSessionId")
    if blocker and any(run["sessionId"] == blocker for run in active):
        try:
            session = ctx.session_store.get_session(blocker)
        except (KeyError, FileNotFoundError):
            session = None
        if session and actor_can_access_record(actor, session):
            result["blockingSessionId"] = blocker
            result["blockingTitle"] = session.get("taskGoal") or ""
    return result


@router.get("/tasks/{task_id}/workspace/files")
async def task_workspace_files(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Live listing of the directory this task's rounds share.

    Live reads need the computer to be up. The artifact index remains the
    durable record of what a task produced.
    """
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    path = workspace_path(request.query_params.get("path"))
    node, workspace_layout, workspace_subpath = _task_workspace_target(ctx, task, actor)
    event = await dispatch_workspace_command(
        ctx,
        node,
        _task_workspace_command(
            task,
            command_id=new_database_id(),
            command_type="workspace.list",
            path=path,
            workspace_layout=workspace_layout,
            workspace_subpath=workspace_subpath,
        ),
    )
    raise_workspace_error(event)
    return live_workspace_listing(
        event,
        path=path,
        metadata={
            "taskId": task["id"],
            "scope": "shared",
            "nodeId": node["id"],
            "workspaceLayout": workspace_layout,
            "sharedWithProject": workspace_layout == "project",
        },
    )


@router.get("/tasks/{task_id}/workspace/file")
async def task_workspace_file(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    path = workspace_path(request.query_params.get("path"), required=True)
    node, workspace_layout, workspace_subpath = _task_workspace_target(ctx, task, actor)
    event = await dispatch_workspace_command(
        ctx,
        node,
        _task_workspace_command(
            task,
            command_id=new_database_id(),
            command_type="workspace.read",
            path=path,
            workspace_layout=workspace_layout,
            workspace_subpath=workspace_subpath,
        ),
    )
    raise_workspace_error(event)
    return live_workspace_file(
        event,
        path=path,
        metadata={
            "taskId": task["id"],
            "scope": "shared",
            "nodeId": node["id"],
            "workspaceLayout": workspace_layout,
            "sharedWithProject": workspace_layout == "project",
        },
    )


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
    }


@router.get("/tasks/{task_id}/runs")
async def task_runs(
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
