"""Live, owner-scoped project records exposed to the manager."""
from __future__ import annotations

from datetime import datetime, UTC
from typing import Any, TypeGuard
from ..core.ids import now_iso
from ..core.computer_identity import computer_id
from ..tasks.review import task_review
from .manager import ManagerError, manager_candidates


def project_task_page(ctx: Any, project: dict[str, Any], **query: Any) -> dict[str, Any]:
    page = ctx.project_store.project_task_page(project["id"], project["ownerUserId"], **query)
    tasks = page["tasks"]
    waiting = ctx.task_store.open_prerequisites_for([t["id"] for t in tasks if t.get("prerequisiteTaskIds")])
    return {**page, "tasks": [{**t, "waitingOn": waiting.get(t["id"], [])} for t in tasks]}


def scoped_task(ctx: Any, project: dict[str, Any], task_id: str) -> dict[str, Any]:
    if not isinstance(task_id, str) or not task_id:
        raise ManagerError("task_not_found", 404)
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
    with ctx.project_store.manager_read_scope():
        project = ctx.project_store.get_project(project["id"])
        counts = ctx.project_store.project_task_counts(project["id"], project["ownerUserId"])
        total = sum(counts["counts"].values())
        recent = project_task_page(ctx, project, limit=20, recent=True)["tasks"]
        return {
            "project": {k: project.get(k) for k in ("id", "name", "goal", "description", "context", "contextRevision", "version", "members", "leadAgentId", "managerAgentId", "computerId")},
            "readAt": now_iso(), **counts, "total": total,
            "agents": [{"id": a["id"], "name": a["displayName"], "role": a.get("defaultRole")} for a in manager_candidates(ctx, project)],
            "teams": [{"id": team["id"], "name": team.get("name") or team.get("displayName")}
                      for team in ctx.team_store.list_teams(project["ownerUserId"]) if team.get("projectId", project["id"]) == project["id"] and team.get("computerId") == project["computerId"]],
            "flowPolicy": {"wipLimit": ctx.task_store.wip_limit_for_user(project["ownerUserId"]),
                           "occupied": ctx.task_store.count_wip(project["ownerUserId"])},
            "computers": [{k: n.get(k) for k in ("id", "computerId", "online", "dispatchable", "status")}
                          for n in ctx.registry.monitor_nodes() if computer_id(n) == project["computerId"]],
            "recentTasks": [_compact(project, t) for t in recent],
            "coverage": {"total": total, "shown": len(recent), "complete": len(recent) == total},
        }


def _is_int(value: Any) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _parse_iso_utc(raw: str) -> datetime:
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=parsed.tzinfo or UTC)


def _read_task_or_review(
    ctx: Any, project: dict[str, Any], arguments: dict[str, Any], *, review: bool
) -> dict[str, Any]:
    task = scoped_task(ctx, project, arguments.get("taskId", ""))
    if review:
        ids = task.get("linkedSessionIds", [])
        if ids:
            try:
                source = ctx.session_store.get_session_header(ids[-1])
                if source.get("projectId") != project["id"] or source.get("ownerUserId") != project["ownerUserId"]:
                    raise ManagerError("thread_not_found", 404)
            except KeyError:
                pass  # Existing review behavior exposes missing evidence.
        return task_review(ctx, task)
    events = task.get("events", [])
    return {
        "task": {**task, "events": events[-50:], "url": task_link(project["id"], task["id"]), "revision": task_revision(task)},
        "coverage": {"totalEvents": len(events), "shownEvents": min(len(events), 50)},
    }


def _read_threads(ctx: Any, project: dict[str, Any]) -> dict[str, Any]:
    sessions, _ = ctx.session_store.list_workspace_threads(
        owner_user_id=project["ownerUserId"], project_id=project["id"], limit=100,
    )
    total = ctx.session_store.project_thread_count(project["ownerUserId"], project["id"])
    return {
        "threads": [{"id": s["id"], "taskGoal": s.get("taskGoal"), "url": f"/threads/{s['id']}"} for s in sessions],
        "total": total,
    }


def _read_thread_page(ctx: Any, project: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    thread_id = ctx.session_store.project_thread_id(
        arguments.get("threadId", ""), project["id"], project["ownerUserId"],
    )
    if not thread_id:
        raise ManagerError("thread_not_found", 404)
    cursor = arguments.get("cursor")
    if "cursor" in arguments and (not _is_int(cursor) or cursor < 0):
        raise ManagerError("manager_pagination_invalid", 400)
    page_size, max_chars = 50, 8000
    messages, total, start = ctx.session_store.thread_message_page(
        thread_id, include_goal=thread_id != project.get("managerThreadId"),
        offset=cursor, limit=page_size, max_chars=max_chars,
    )
    return {
        "messages": messages,
        "nextCursor": start + page_size if total > start + page_size else None,
        "previousCursor": max(0, start - page_size) if start else None,
        "coverage": {"total": total, "shown": len(messages), "maxMessageChars": max_chars},
        "url": f"/threads/{thread_id}",
    }


def _read_tasks_page(ctx: Any, project: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    cursor = arguments.get("cursor", "")
    limit = arguments.get("limit", 50)
    if not isinstance(cursor, str) or not _is_int(limit) or not 1 <= limit <= 100:
        raise ManagerError("manager_pagination_invalid", 400)
    page = project_task_page(
        ctx, project, cursor=cursor, limit=limit,
        status=arguments.get("status", ""), query=arguments.get("query", ""),
    )
    return {**page, "tasks": [_compact(project, t) for t in page["tasks"]], "readAt": now_iso()}


def _format_activity_entry(project_id: str, row: dict[str, Any]) -> dict[str, Any]:
    kind, entity_id, event = row["kind"], row["entityId"], row["event"]
    if kind == "project":
        event = {k: event[k] for k in ("id", "type", "timestamp", "patch") if k in event}
        url = f"/projects/{entity_id}"
    elif kind == "thread":
        text = str(event.get("agentLog") or "")
        event = {k: event[k] for k in ("id", "type", "timestamp", "runId", "agent", "logicalAgentId", "exitCode") if k in event}
        event.update(agentLog=text[:8000], reportTruncated=len(text) > 8000, evidenceKind="agent_report")
        url = f"/threads/{entity_id}"
    else:
        url = task_link(project_id, entity_id)
    return {f"{kind}Id": entity_id, "sequence": row["sequence"], "event": event, "url": url}


def _read_activity_page(ctx: Any, project: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    cutoff = arguments.get("cutoff") or now_iso()
    since = arguments.get("since", "")
    try:
        cutoff_at = _parse_iso_utc(cutoff)
        since_at = _parse_iso_utc(since) if since else None
        if since_at and since_at > cutoff_at:
            raise ValueError("Reversed time range")
    except (ValueError, TypeError, AttributeError) as error:
        raise ManagerError("manager_time_invalid", 400) from error
    cursor = arguments.get("cursor", 0)
    limit = arguments.get("limit", 50)
    if not _is_int(cursor) or cursor < 0 or not _is_int(limit) or not 1 <= limit <= 50:
        raise ManagerError("manager_pagination_invalid", 400)
    page = ctx.project_store.project_activity_page(
        project["id"], project["ownerUserId"],
        since=since_at, cutoff=cutoff_at, cursor=cursor, limit=limit,
    )
    entries = [_format_activity_entry(project["id"], row) for row in page["events"]]
    return {**page, "events": entries, "cutoff": cutoff}


def read_manager_tool(ctx: Any, project: dict[str, Any], tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    for key in ("taskId", "threadId", "query", "status", "since", "cutoff"):
        if key in arguments and (not isinstance(arguments[key], str) or len(arguments[key]) > 500):
            raise ManagerError("manager_arguments_invalid", 400)
    if tool == "overview":
        return manager_overview(ctx, project)
    if tool in ("task", "review"):
        return _read_task_or_review(ctx, project, arguments, review=tool == "review")
    if tool == "threads":
        return _read_threads(ctx, project)
    if tool == "thread":
        return _read_thread_page(ctx, project, arguments)
    if tool == "tasks":
        return _read_tasks_page(ctx, project, arguments)
    if tool == "activity":
        return _read_activity_page(ctx, project, arguments)
    raise ManagerError("manager_tool_unknown", 400)
