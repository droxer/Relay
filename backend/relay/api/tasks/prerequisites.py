"""A task's prerequisites: which tasks in its project must be done first.

The set is written whole (``PUT``); the store validates it against the
project under its write lock. ``waitingOn`` and ``unblocks`` are derived on
read and never stored.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...tasks.prerequisites import PrerequisiteError, prerequisite_ids
from ...security.actor import Actor
from ..actors import actor_can_access_record, get_task_for_actor, request_actor
from ..bodies import JsonBodyDep
from ..deps import AppContext, AppContextDep
from ..projects.access import ensure_task_project_writable
from .payloads import public_task

router = APIRouter()


def with_waiting_on(ctx: AppContext, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each task with ``waitingOn``: its prerequisites not yet done, in the
    order the task names them. Only tasks that name any are looked up."""
    linked = [task["id"] for task in tasks if task.get("prerequisiteTaskIds")]
    open_by_task = ctx.task_store.open_prerequisites_for(linked) if linked else {}
    return [
        {
            **task,
            "waitingOn": [
                prerequisite_id
                for prerequisite_id in task.get("prerequisiteTaskIds") or []
                if prerequisite_id in open_by_task.get(task["id"], ())
            ],
        }
        for task in tasks
    ]


def task_with_prerequisite_view(ctx: AppContext, task: dict[str, Any]) -> dict[str, Any]:
    """One task's full view: ``waitingOn`` plus the tasks it ``unblocks``."""
    [viewed] = with_waiting_on(ctx, [task])
    return {**viewed, "unblocks": ctx.task_store.task_dependents(task["id"])}


@router.put("/tasks/{task_id}/prerequisites")
def set_task_prerequisites(
    task_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    ensure_task_project_writable(ctx, current)
    if current.get("deletedAt"):
        raise HTTPException(404, "task_not_found")
    try:
        ids = prerequisite_ids(_request_body.get("prerequisiteTaskIds"))
        task = ctx.task_store.set_task_prerequisites(
            task_id, ids, actor_user_id=actor.get("userId")
        )
    except PrerequisiteError as error:
        raise HTTPException(error.status, error.code) from error
    return task_with_prerequisite_view(ctx, public_task(task))


def with_dependency_summaries(
    ctx: AppContext, actor: Actor, tasks: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Only direct, unfinished prerequisites in an accessible live project.

    A dependency does not grant detail access. The allowlist below deliberately
    excludes descriptions, evidence, history and runtime/workspace details.
    Fetch compact snapshots in batches, never reconstruct event histories.
    """
    ids = list(dict.fromkeys(key for task in tasks for key in task.get("waitingOn") or []))
    summaries: dict[str, dict[str, Any]] = {}
    for offset in range(0, len(ids), 500):
        for task in ctx.task_store.list_task_summaries(task_ids=ids[offset:offset + 500]):
            summaries[task["id"]] = task
    projects: dict[str, bool] = {}
    result: list[dict[str, Any]] = []
    for task in tasks:
        project_id = task.get("projectId")
        if task.get("waitingOn") and project_id and project_id not in projects:
            project = ctx.project_store.get_project(project_id)
            projects[project_id] = bool(
                project and not project.get("archivedAt")
                and (actor["isAdmin"] or project.get("ownerUserId") == actor["userId"])
            )
        visible: list[dict[str, Any]] = []
        if project_id and projects.get(project_id):
            for key in task.get("waitingOn") or []:
                source = summaries.get(key)
                if not source or source.get("projectId") != project_id or source.get("status") == "done":
                    continue
                visible.append({
                    **{name: source[name] for name in ("id", "number", "title", "status", "ownerUserId", "assigneeUserId") if name in source},
                    "canOpen": actor_can_access_record(actor, source),
                })
        result.append({**task, "waitingOnSummaries": visible})
    user_ids = list({
        summary.get("assigneeUserId") or summary.get("ownerUserId")
        for task in result for summary in task["waitingOnSummaries"]
    } - {None})
    names: dict[str, str] = {}
    for offset in range(0, len(user_ids), 500):
        for user in ctx.auth_store.list_users(user_ids=user_ids[offset:offset + 500]):
            names[user["id"]] = user.get("displayName") or user.get("handle") or ""
    for task in result:
        for summary in task["waitingOnSummaries"]:
            person = summary.get("assigneeUserId") or summary.get("ownerUserId")
            if name := names.get(person):
                summary["responsibleName"] = name
    return result
