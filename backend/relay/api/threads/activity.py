"""The task information needed by the paged Thread directory and its Home badge."""

from __future__ import annotations

from typing import Any

from ...security.actor import Actor
from ...security.home_snoozes import normalize_home_snoozes
from ..deps import AppContext


ThreadListActivity = tuple[list[dict[str, Any]], set[str], dict[str, Any]]


def read_thread_list_activity(
    ctx: AppContext, actor: Actor, thread_ids: list[str], *, include_home_count: bool,
) -> ThreadListActivity:
    user_id = actor["userId"]
    links, waits = ctx.task_store.thread_list_task_links(thread_ids, user_id)
    count = {}
    if include_home_count:
        snoozed = {
            entry["key"].removeprefix("task:"): entry["stamp"]
            for entry in normalize_home_snoozes(actor.get("account", {}).get("homeSnoozes"))
            if entry["key"].startswith("task:")
        }
        count = {"homeTaskNeedsYou": ctx.task_store.count_home_tasks_needing_attention(user_id, snoozed)}
    return links, waits, count


def apply_thread_list_activity(rows: list[dict[str, Any]], activity: ThreadListActivity) -> dict[str, Any]:
    links, waits, count = activity
    by_session = {str(link["sessionId"]): link for link in links}
    for row in rows:
        task = by_session.get(row["id"])
        row["taskActivity"] = {
            "origin": _origin(task) if task else None,
            "awaitsHuman": row["id"] in waits or (
                task["status"] == "waiting_for_human" and not task["isRoutine"] and not task["waitingSessionId"]
                if task else row.get("workOutcome") == "blocked"
            ),
        }
    return count


def _origin(task: dict[str, Any]) -> dict[str, Any]:
    task_id = str(task["id"])
    prefix = "AUTO-" if task["isRoutine"] else "#"
    number = task["number"]
    return {
        "kind": "routine" if task["isRoutine"] or task["sourceRoutineId"] else "backlog",
        "taskId": task_id,
        "ref": task_id if number is None else f"{prefix}{number}",
        "title": task["sourceTitle"] or task["title"],
        "status": task["status"],
    }
