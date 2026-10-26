"""A task's prerequisites: which tasks in its project must be done first.

The set is written whole (``PUT``); the store validates it against the
project under its write lock. ``waitingOn`` and ``unblocks`` are derived on
read and never stored.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...tasks.prerequisites import PrerequisiteError, prerequisite_ids
from ..actors import get_task_for_actor, request_actor
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
