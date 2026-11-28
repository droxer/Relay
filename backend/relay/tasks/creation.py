"""Creating a task, and the thread it opens when asked to."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from loguru import logger

from ..core.validation import task_priority, task_status
from ..core.task_verification import CHECK_FIELD, check_definition
from ..sessions.controller import SessionController
from .flow import NEW_TASK_ACCEPTANCE_POLICY
from .issue_triage import ISSUE_NEEDS_PROJECT, issue_needs_project
from .assignment import (
    validate_task_owner_assignment,
    validate_task_computer,
    validate_computer_assignment,
    validate_standalone_assignment,
    logical_agent_for_assignment,
    team_for_assignment,
    validate_task_workflow,
    validate_project_assignment,
    validate_trigger_scope,
)
from .placement import task_goal_text
from .workspace import task_workspace_nodes, task_workspace_subpath
from .requests import (
    TaskRequestError,
    TaskRequestReader,
    acceptance_policy_field,
    collaboration_style_field,
    permission_mode_field,
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
    # Where an imported task came from (``github_import``); never read from
    # a request body, so ``POST /tasks`` cannot forge one.
    external_source: dict[str, Any] | None = None


@dataclass(frozen=True)
class _Assignment:
    assignee: str
    agent_id: str | None
    team_id: str | None
    agent: str | None


@dataclass(frozen=True)
class _Plan:
    acceptance_policy: Any
    collaboration_style: str | None
    routine: dict[str, Any]
    creates_thread: bool
    verification_check: dict[str, str] | None


def create_task(ctx: Any, actor: Actor, request: TaskCreateRequest) -> dict[str, Any]:
    permission_mode = permission_mode_field(request.body)
    if permission_mode == "yolo" and actor["userId"] != request.owner:
        raise TaskRequestError(403, "task_permission_mode_owner_required")
    identity = request.reader.string(request.body, "computerId")
    if identity:
        if request.project:
            raise TaskRequestError(400, "task_workspace_scope_conflict")
        validate_task_computer(ctx, identity, request.owner)
    assignment = _resolve_assignment(ctx, actor, request)
    if identity:
        validate_computer_assignment(ctx, identity, assignment.agent_id, assignment.team_id)
    plan = _plan_creation(ctx, request, assignment)
    if plan.verification_check and actor["userId"] != request.owner:
        raise TaskRequestError(403, "task_verification_owner_required")
    task = _create_record(ctx, request, assignment, plan, permission_mode=permission_mode)
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
            ctx, request.project, assigned_agent_id=agent_id, assigned_team_id=team_id,
            workflow_id=body.get("assignedWorkflowId")
        )
    else:
        validate_standalone_assignment(
            ctx, assigned_agent_id=agent_id, assigned_team_id=team_id,
        )
    team_for_assignment(ctx, actor, team_id, expected_user_id=assignee,
                        project_id=(request.project or {}).get("id"))
    validate_task_workflow(
        ctx, {**body, "ownerUserId": request.owner, "assignedTeamId": team_id}, new_selection=True,
    )
    validate_task_owner_assignment(request.owner, assignee)
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
    if status and status != "backlog":
        raise TaskRequestError(400, "New tasks must enter Backlog.")
    routine = request.reader.routine(body, current=None)
    if routine.get("isRoutine") and not (project or request.reader.string(body, "computerId")):
        raise TaskRequestError(409, "task_workspace_required")
    if "routineTriggers" in body:
        validate_trigger_scope(ctx, routine.get("routineTriggers"), owner=request.owner)
    creates_thread = body.get("createSession") is True or isinstance(
        body.get("assignments"), list
    )
    assigned = bool(assignment.agent_id or assignment.team_id or body.get("assignedWorkflowId"))
    scope = {
        **routine, "projectId": project and project["id"],
        "computerId": request.reader.string(body, "computerId"),
    }
    if issue_needs_project(scope) and (
        assigned or creates_thread
    ):
        raise TaskRequestError(409, ISSUE_NEEDS_PROJECT)
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
    check = check_definition(body.get(CHECK_FIELD))
    if CHECK_FIELD in body:
        if check is None:
            raise TaskRequestError(400, "verificationCheck requires a full Git commit and repository-relative path.")
        if (not project or routine.get("isRoutine") or creates_thread
                or acceptance_policy == "automatic" or assignment.agent_id or assignment.team_id
                or body.get("assignedWorkflowId") != "preset:build_review"):
            raise TaskRequestError(409, "task_verification_requires_project_build_review")
    return _Plan(acceptance_policy, collaboration_style, routine, creates_thread, check)


def _create_record(
    ctx: Any, request: TaskCreateRequest, assignment: _Assignment, plan: _Plan,
    *, permission_mode: str | None,
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
            **({"computerId": request.reader.string(body, "computerId")} if body.get("computerId") else {}),
            "dueDate": request.reader.date(body, "dueDate"),
            "status": "backlog",
            "acceptancePolicy": plan.acceptance_policy or NEW_TASK_ACCEPTANCE_POLICY,
            **({CHECK_FIELD: plan.verification_check} if plan.verification_check else {}),
            **({"permissionMode": permission_mode} if permission_mode else {}),
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
            **({"assignedWorkflowId": body["assignedWorkflowId"]} if body.get("assignedWorkflowId") else {}),
            **({"externalSource": request.external_source} if request.external_source else {}),
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
    if task.get("computerId") and not project:
        nodes = [
            node for node in task_workspace_nodes(task, ctx.registry.monitor_nodes())
            if not node.get("retiredAt")
        ]
        node = min(nodes, key=lambda item: (not item.get("online"), item["id"]), default={})
        workspace_path = node.get("workspacePath") or "/workspace"
        session_fields.update(
            workspace_layout="task", workspace_subpath=task_workspace_subpath(task),
            computer_id=task["computerId"],
        )
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
