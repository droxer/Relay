"""The Task context of a single open Thread."""

from __future__ import annotations

from typing import Any

from ...collaboration.awaiting import task_awaiting
from ...core.next_steps import sanitize_next_steps
from ...security.actor import Actor
from ..actors import get_session_header_for_actor
from ..deps import AppContext


_THREAD_TASK_FIELDS = frozenset({
    "id", "number", "title", "priority", "status", "isRoutine", "sourceRoutineId",
    "ownerUserId", "assigneeUserId", "projectId", "computerId", "createdAt", "updatedAt",
    "eventCount", "activityCount", "blockerReason", "permissionMode",
})


def read_thread_tasks(ctx: AppContext, actor: Actor, thread_id: str) -> dict[str, Any]:
    thread = get_session_header_for_actor(ctx.session_store, thread_id, actor)
    thread_id = thread["id"]
    active_round_id = thread.get("activeRoundId")
    scope = next((
        item.get("workScope") for item in thread.get("collaborationRounds") or []
        if item.get("roundId") == active_round_id
    ), None)
    active_task_id = scope.get("taskId") if isinstance(scope, dict) and scope.get("kind") == "task" else None
    next_steps = sanitize_next_steps(thread.get("nextSteps"))
    rows = ctx.task_store.thread_tasks(
        actor["userId"], thread_id, active_task_id=active_task_id,
        project_id=thread.get("projectId"), next_steps=next_steps,
    )
    return {
        "tasks": [_thread_task(row, thread_id) for row in rows],
        "threadTaskContext": {
            "threadId": thread_id,
            "eventCount": thread["eventCount"],
            "activeTaskId": active_task_id,
            "nextSteps": next_steps,
        },
    }


def _thread_task(task: dict[str, Any], thread_id: str) -> dict[str, Any]:
    links = task.get("linkedSessionIds") or []
    # The current Thread and the newest link answer ownership and whether the
    # chip can still act. Directory rows carry their own projected origins.
    selected_links = [thread_id] if thread_id in links else []
    if links and links[-1] != thread_id:
        selected_links.append(links[-1])
    return {
        **{key: task[key] for key in sorted(task.keys() & _THREAD_TASK_FIELDS)},
        "description": "",
        "linkedSessionIds": selected_links,
        "awaiting": task_awaiting(task),
    }
