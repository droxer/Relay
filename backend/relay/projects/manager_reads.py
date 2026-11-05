"""Live, owner-scoped project records exposed to the manager."""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any
from ..core.ids import now_iso
from ..persistence.engine import store_transaction
from ..tasks.review import task_review
from .manager import ManagerError


def project_tasks(ctx: Any, project: dict[str, Any]) -> list[dict[str, Any]]:
    return [t for t in ctx.task_store.list_task_summaries(user_id=project["ownerUserId"])
            if t.get("projectId") == project["id"] and not t.get("deletedAt")
            and t.get("ownerUserId") == project["ownerUserId"]]


def scoped_task(ctx: Any, project: dict[str, Any], task_id: str) -> dict[str, Any]:
    try:
        task = ctx.task_store.get_task(task_id)
    except KeyError as error:
        raise ManagerError("task_not_found", 404) from error
    if not task or task.get("deletedAt") or task.get("projectId") != project["id"] or task.get("ownerUserId") != project["ownerUserId"]:
        raise ManagerError("task_not_found", 404)
    return task


def task_link(project_id: str, task_id: str) -> str:
    return f"/projects/{project_id}?task={task_id}"


def task_revision(task: dict[str, Any]) -> str:
    # Event count protects against several writes sharing the same timestamp.
    return f"{task.get('updatedAt')}:{task.get('eventCount', len(task.get('events', [])))}"


def _compact(project: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
    return {**{k: task[k] for k in (
        "id", "number", "title", "status", "priority", "dueDate", "assignedAgentId", "assignedTeamId",
        "tags", "updatedAt", "waitingRequest", "awaiting", "blockerReason", "prerequisiteTaskIds", "waitingOn",
    ) if k in task}, "url": task_link(project["id"], task["id"]), "revision": task_revision(task)}


def manager_overview(ctx: Any, project: dict[str, Any]) -> dict[str, Any]:
    with store_transaction(ctx.project_store.engine):
        project = ctx.project_store.get_project(project["id"])
        tasks = project_tasks(ctx, project)
        ordinary = [t for t in tasks if t.get("routineType") != "routine"]
        counts = Counter(t["status"] for t in ordinary)
        recent = sorted(ordinary, key=lambda t: (t.get("updatedAt", ""), t["id"]), reverse=True)[:20]
        return {
            "project": {k: project.get(k) for k in ("id", "name", "goal", "description", "context", "contextRevision", "version", "members", "leadAgentId", "managerAgentId", "computerId")},
            "readAt": now_iso(), "counts": dict(counts), "total": len(ordinary),
            "automationCount": len(tasks) - len(ordinary),
            "recentTasks": [_compact(project, t) for t in recent],
            "coverage": {"total": len(ordinary), "shown": len(recent), "complete": len(recent) == len(ordinary)},
        }


def read_manager_tool(ctx: Any, project: dict[str, Any], tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if tool == "overview":
        return manager_overview(ctx, project)
    if tool in ("task", "review"):
        task = scoped_task(ctx, project, arguments.get("taskId", ""))
        if tool == "review":
            return task_review(ctx, task)
        return {"task": {**task, "url": task_link(project["id"], task["id"]), "revision": task_revision(task)}}
    if tool == "threads":
        sessions = [s for s in ctx.session_store.list_sessions() if s.get("projectId") == project["id"] and s.get("ownerUserId") == project["ownerUserId"]]
        return {"threads": [{"id": s["id"], "taskGoal": s.get("taskGoal"), "url": f"/threads/{s['id']}"} for s in sessions[:100]], "total": len(sessions)}
    if tool == "thread":
        thread_id = arguments.get("threadId", "")
        try:
            session = ctx.session_store.get_session(thread_id)
        except KeyError as error:
            raise ManagerError("thread_not_found", 404) from error
        if not session or session.get("projectId") != project["id"] or session.get("ownerUserId") != project["ownerUserId"]:
            raise ManagerError("thread_not_found", 404)
        messages = session.get("messages", [])
        return {"messages": messages[-50:], "coverage": {"total": len(messages), "shown": min(len(messages), 50)}, "url": f"/threads/{thread_id}"}
    tasks = project_tasks(ctx, project)
    if tool == "tasks":
        tasks = [t for t in tasks if not arguments.get("status") or t["status"] == arguments["status"]]
        query = str(arguments.get("query", "")).casefold()
        tasks = [t for t in tasks if query in t["title"].casefold()]
        tasks.sort(key=lambda t: t["id"])
        cursor = arguments.get("cursor", "")
        limit = arguments.get("limit", 50)
        if not isinstance(cursor, str) or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ManagerError("manager_pagination_invalid", 400)
        remaining = [t for t in tasks if t["id"] > cursor]
        page = remaining[:limit]
        return {"tasks": [_compact(project, t) for t in page], "total": len(tasks),
                "nextCursor": page[-1]["id"] if len(remaining) > limit else None, "readAt": now_iso()}
    if tool == "activity":
        cutoff = arguments.get("cutoff") or now_iso()
        since = arguments.get("since", "")
        try:
            datetime.fromisoformat(cutoff.replace("Z", "+00:00"))
            if since:
                datetime.fromisoformat(since.replace("Z", "+00:00"))
        except (ValueError, TypeError, AttributeError) as error:
            raise ManagerError("manager_time_invalid", 400) from error
        events = []
        for summary in tasks:
            task = scoped_task(ctx, project, summary["id"])
            for i, event in enumerate(task.get("events", [])):
                if since <= event.get("timestamp", "") <= cutoff:
                    events.append({"taskId": task["id"], "sequence": i, "event": event, "url": task_link(project["id"], task["id"])})
        events.sort(key=lambda e: (e["event"].get("timestamp", ""), e["taskId"], e["sequence"]))
        cursor = arguments.get("cursor", 0)
        if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
            raise ManagerError("manager_pagination_invalid", 400)
        return {"events": events[cursor:cursor + 50], "cutoff": cutoff, "total": len(events),
                "nextCursor": cursor + 50 if len(events) > cursor + 50 else None}
    raise ManagerError("manager_tool_unknown", 400)
