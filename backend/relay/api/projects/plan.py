"""Applying a drafted proposal's tasks to the project in one request.

The tasks are created through the ordinary task path with their prerequisites.
They stay in the backlog until the owner starts them separately.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...core.ids import now_iso
from ...projects.plan_apply import (
    applicable_setup,
    assignee_overrides,
    prerequisites_for,
    selected_tasks,
    task_create_body,
)
from ...projects.runtime import project_work_error
from ...projects.setup import ProjectSetupError
from ...persistence.project.store import ProjectVersionConflict
from ...security.actor import Actor
from ...tasks.creation import TaskCreateRequest
from ...tasks.creation import create_task as create_task_record
from ...tasks.prerequisites import PrerequisiteError
from ...tasks.requests import TaskRequestError
from ..actors import assignee_user_id_for_task, request_actor
from ..bodies import JsonBodyDep
from ..deps import AppContext, AppContextDep
from ..tasks.payloads import public_task, request_reader
from ..tasks.prerequisites import with_waiting_on
from .access import project_for_owner, project_session_fields
from .setup_task import close_setup_task

router = APIRouter()


@router.post("/projects/{project_id}/setup/tasks")
def apply_setup_tasks(
    project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    """Create the proposal's tasks (or the ``taskKeys`` subset) with their
    prerequisites, ready for the owner to review and start separately."""
    actor = request_actor(request, ctx.auth_store)
    body = _request_body
    if project_for_owner(ctx, project_id, actor["userId"], require_enabled=True) is None:
        raise HTTPException(404, "Project not found.")

    def apply(project: dict[str, Any]) -> dict[str, Any]:
        # mutate_setup holds the project row lock and a shared transaction.
        # Every nested store write joins it: no task can commit without its
        # apply key, and another replica rechecks the keys after taking the lock.
        if code := project_work_error(project):
            raise HTTPException(409, code)
        setup = applicable_setup(project, body.get("draftId"))
        chosen = selected_tasks(setup, body.get("taskKeys"))
        overrides = assignee_overrides(body.get("assignedAgentIds"))
        applied = _create_missing(ctx, actor, project, setup, chosen, overrides)
        _link_prerequisites(ctx, project, chosen, applied)
        return {
            **setup,
            "appliedTasks": applied,
            **(
                {"state": "applied", "resolvedAt": now_iso()}
                if setup.get("mode") == "plan" and setup.get("state") == "proposed"
                else {}
            ),
        }

    try:
        project = _mutate(ctx, project_id, apply)
    except ProjectSetupError as error:
        raise HTTPException(error.status, error.code) from error
    setup = applicable_setup(project, body.get("draftId"))
    if setup.get("state") == "applied":
        # The plan is in the backlog now; its drafting task is finished.
        close_setup_task(ctx, setup)
    chosen = selected_tasks(setup, body.get("taskKeys"))
    applied = setup["appliedTasks"]
    tasks = [ctx.task_store.get_task(applied[task["key"]]) for task in chosen]
    return {
        "project": project,
        "tasks": with_waiting_on(ctx, [public_task(task) for task in tasks]),
    }


def _create_missing(
    ctx: AppContext,
    actor: Actor,
    project: dict[str, Any],
    setup: dict[str, Any],
    chosen: list[dict[str, Any]],
    overrides: dict[str, str | None],
) -> dict[str, str]:
    applied = dict(setup.get("appliedTasks") or {})
    owner = project["ownerUserId"]
    for task in chosen:
        if task["key"] in applied:
            continue
        create_body = task_create_body(task, project["id"], overrides)
        try:
            record = create_task_record(
                ctx,
                actor,
                TaskCreateRequest(
                    body=create_body,
                    reader=request_reader(),
                    title=create_body["title"],
                    owner=owner,
                    assignee=assignee_user_id_for_task(actor, create_body, owner),
                    project=project,
                    project_session_fields=lambda selected: project_session_fields(ctx, selected),
                ),
            )
        except TaskRequestError as error:
            raise HTTPException(
                error.status,
                {"code": "project_setup_task_failed", "key": task["key"], "message": error.detail},
            ) from error
        applied[task["key"]] = record["id"]
    return applied


def _link_prerequisites(
    ctx: AppContext,
    project: dict[str, Any],
    chosen: list[dict[str, Any]],
    applied: dict[str, str],
) -> None:
    project_task_ids = {
        task["id"]
        for task in ctx.task_store.list_task_summaries(user_id=project["ownerUserId"])
        if task.get("projectId") == project["id"] and not task.get("deletedAt")
    }
    for task in chosen:
        ids = prerequisites_for(task, applied, project_task_ids)
        if not ids:
            continue
        try:
            ctx.task_store.set_task_prerequisites(applied[task["key"]], ids)
        except PrerequisiteError as error:
            raise HTTPException(
                error.status,
                {"code": error.code, "key": task["key"]},
            ) from error


def _mutate(ctx: AppContext, project_id: str, change: Any) -> dict[str, Any]:
    try:
        return ctx.project_store.mutate_setup(project_id, change)
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except ProjectVersionConflict as error:
        raise HTTPException(409, "project_version_conflict") from error
