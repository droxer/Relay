"""A task's prerequisites: which tasks in its project must be done first.

The set is written whole (``PUT``); the store validates it against the
project under its write lock. ``waitingOn`` and ``unblocks`` are derived on
read and never stored.
"""

from __future__ import annotations

from itertools import batched
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


def task_with_prerequisite_view(
    ctx: AppContext, task: dict[str, Any], *, include_summaries: bool = False,
) -> dict[str, Any]:
    """One task's full view: ``waitingOn`` plus the tasks it ``unblocks``."""
    [viewed] = with_waiting_on(ctx, [task])
    dependents = ctx.task_store.task_dependents(task["id"])
    viewed["unblocks"] = dependents
    if include_summaries and task.get("projectId") and task.get("ownerUserId") and not task.get("isRoutine"):
        ids = dict.fromkeys([*(task.get("prerequisiteTaskIds") or []), *dependents])
        viewed["prerequisiteSummaries"] = [
            row for batch in batched(ids, 500) for row in ctx.task_store.prerequisite_choices(
                task["ownerUserId"], task["projectId"], list(batch),
            )
        ]
    return viewed


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
    Reuse tasks already in the response and read missing prerequisites in batches.
    """
    project_ids = {task["projectId"] for task in tasks if task.get("waitingOn") and task.get("projectId")}
    projects = ctx.project_store.live_owned_project_ids(actor["userId"], project_ids) if project_ids else set()
    ids = dict.fromkeys(
        key for task in tasks if task.get("projectId") in projects for key in task.get("waitingOn") or []
    )
    summaries = {task["id"]: task for task in tasks if task.get("status") != "done"}
    missing = [key for key in ids if key not in summaries]
    for offset in range(0, len(missing), 500):
        for task in ctx.task_store.prerequisite_summaries(actor["userId"], missing[offset:offset + 500]):
            summaries[task["id"]] = task
    result: list[dict[str, Any]] = []
    for task in tasks:
        project_id = task.get("projectId")
        visible: list[dict[str, Any]] = []
        if project_id in projects:
            for key in task.get("waitingOn") or []:
                source = summaries.get(key)
                if (
                    not source or source.get("projectId") != project_id or source.get("status") == "done"
                    or not actor_can_access_record(actor, source)
                ):
                    continue
                visible.append({
                    **{name: source[name] for name in ("id", "number", "title", "status", "ownerUserId", "assigneeUserId") if name in source},
                    "canOpen": True,
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
