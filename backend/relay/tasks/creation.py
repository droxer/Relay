"""Creating a task, and the thread it opens when asked to."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from loguru import logger

from ..core.validation import task_priority, task_status
from ..sessions.controller import SessionController
from .issue_triage import ISSUE_NEEDS_PROJECT, issue_needs_project
from .assignment import (
    logical_agent_for_assignment,
    team_for_assignment,
    validate_project_assignment,
    validate_trigger_scope,
)
from .placement import task_goal_text
from .requests import (
    TaskRequestError,
    TaskRequestReader,
    acceptance_policy_field,
    collaboration_style_field,
    tags_field,
)
from ..teams.dispatch import TeamDispatchError, task_thread_assignments, task_thread_ownership
from ..security.actor import Actor


@dataclass(frozen=True)
class TaskCreateRequest:
    """A create request whose owner, assignee, and project are already authorized."""

    body: dict[str, Any]
    reader: TaskRequestReader
    title: str
    owner: str
    assignee: str
    project: dict[str, Any] | None
    # The project's thread fields, read only when a thread is opened.
    project_session_fields: Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class _Assignment:
    assignee: str
    agent_id: str | None
    team_id: str | None
    agent: str | None


@dataclass(frozen=True)
class _Plan:
    status: str | None
    acceptance_policy: Any
    collaboration_style: str | None
    routine: dict[str, Any]
    creates_thread: bool


def create_task(ctx: Any, actor: Actor, request: TaskCreateRequest) -> dict[str, Any]:
    assignment = _resolve_assignment(ctx, actor, request)
    plan = _plan_creation(ctx, request, assignment)
    task = _create_record(ctx, request, assignment, plan)
    if plan.creates_thread:
        task = _open_task_thread(ctx, task, request)
    return task


def _resolve_assignment(
    ctx: Any, actor: Actor, request: TaskCreateRequest
) -> _Assignment:
    body, string = request.body, request.reader.string
    if request.project and "assignments" in body:
        raise TaskRequestError(400, "project_assignment_override_unsupported")
    agent_id = string(body, "assignedAgentId") or None
    team_id = string(body, "assignedTeamId") or None
    if agent_id and team_id:
        raise TaskRequestError(400, "task_agent_and_team_conflict")
    if "assignedAgent" in body:
        raise TaskRequestError(400, "assignedAgent is read-only; use assignedAgentId.")
    assignee = request.assignee
    logical_agent = logical_agent_for_assignment(
        ctx, actor, agent_id, expected_user_id=assignee
    )
    if logical_agent:
        assignee = logical_agent["supervisorUserId"]
    if request.project:
        validate_project_assignment(
            ctx, request.project, assigned_agent_id=agent_id, assigned_team_id=team_id
        )
    team_for_assignment(ctx, actor, team_id, expected_user_id=assignee)
    agent = logical_agent["executorKind"] if logical_agent else None
    return _Assignment(assignee=assignee, agent_id=agent_id, team_id=team_id, agent=agent)


def _plan_creation(
    ctx: Any, request: TaskCreateRequest, assignment: _Assignment
) -> _Plan:
    body, project = request.body, request.project
    status = task_status(body.get("status"))
    acceptance_policy = acceptance_policy_field(body)
    collaboration_style = collaboration_style_field(body, allow_clear=False)
    if "status" in body and not status:
        raise TaskRequestError(400, "status is not a recognized task status.")
    routine = request.reader.routine(body, current=None)
    if "routineTriggers" in body:
        validate_trigger_scope(ctx, routine.get("routineTriggers"), owner=request.owner)
    creates_thread = body.get("createSession") is True or isinstance(
        body.get("assignments"), list
    )
    assigned = bool(assignment.agent_id or assignment.team_id)
    if issue_needs_project({**routine, "projectId": project and project["id"]}) and (
        status == "assigned" or assigned or creates_thread
    ):
        raise TaskRequestError(409, ISSUE_NEEDS_PROJECT)
    if status == "assigned" and not (project or assigned):
        raise TaskRequestError(400, "assigned status requires an agent or team.")
    if status and status not in ("backlog", "assigned"):
        raise TaskRequestError(400, "New tasks must enter Backlog or Ready.")
    if routine.get("routineState") == "active" and not (project or assigned):
        raise TaskRequestError(400, "An active automation requires an agent, team, or project.")
    if creates_thread and assignment.team_id:
        _thread_ownership(
            ctx,
            {
                "ownerUserId": request.owner,
                "assigneeUserId": assignment.assignee,
                "assignedTeamId": assignment.team_id,
            },
        )
    return _Plan(status, acceptance_policy, collaboration_style, routine, creates_thread)


def _create_record(
    ctx: Any, request: TaskCreateRequest, assignment: _Assignment, plan: _Plan
) -> dict[str, Any]:
    body, project, agent = request.body, request.project, assignment.agent
    task = ctx.task_store.create_task(
        {
            "title": request.title,
            "description": request.reader.string(body, "description"),
            "priority": task_priority(body.get("priority")) or "normal",
            **({"tags": tags} if (tags := tags_field(body)) else {}),
            "ownerUserId": request.owner,
            "assigneeUserId": assignment.assignee,
            **({"projectId": project["id"]} if project else {}),
            "dueDate": request.reader.date(body, "dueDate"),
            "status": plan.status,
            "acceptancePolicy": plan.acceptance_policy or "human",
            **(
                {"collaborationStyle": plan.collaboration_style}
                if plan.collaboration_style
                else {}
            ),
            **(
                {"assignedAgent": agent, "assignedAgentId": assignment.agent_id}
                if agent and assignment.agent_id
                else {}
            ),
            **({"assignedTeamId": assignment.team_id} if assignment.team_id else {}),
            **plan.routine,
        }
    )
    logger.info("Task created", task_id=task["id"], title=request.title, owner=request.owner)
    if agent:
        logger.info(
            "Task assigned", task_id=task["id"], agent=agent, agent_id=assignment.agent_id
        )
    return task


def _open_task_thread(
    ctx: Any, task: dict[str, Any], request: TaskCreateRequest
) -> dict[str, Any]:
    body, reader, project = request.body, request.reader, request.project
    project_fields = request.project_session_fields(project) if project else {}
    workspace_path = project_fields.get(
        "workspace_path", reader.string(body, "workspacePath") or "/workspace"
    )
    session_fields = {key: value for key, value in project_fields.items() if key != "workspace_path"}
    thread_ownership = _thread_ownership(ctx, task)
    assignments = task_thread_assignments(
        task,
        reader.assignments(body.get("assignments")),
        team_store=ctx.team_store,
        agent_store=ctx.agent_store,
    )
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        task_id=task["id"],
        workspace_path=workspace_path,
        **session_fields,
        **thread_ownership,
    )
    session = controller.create_session(
        task_goal_text(task), reader.participants(assignments, None)
    )
    logger.info(
        "Session created from task",
        task_id=task["id"],
        session_id=session["id"],
        workspace_path=workspace_path,
    )
    if assignments:
        controller.assign_session(session["id"], assignments)
    return ctx.task_store.link_session(task["id"], session["id"])


def _thread_ownership(ctx: Any, task: dict[str, Any]) -> dict[str, Any]:
    try:
        return task_thread_ownership(
            task, team_store=ctx.team_store, agent_store=ctx.agent_store
        )
    except TeamDispatchError as error:
        raise TaskRequestError(409, error.code) from error
