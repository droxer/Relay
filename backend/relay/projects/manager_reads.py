"""Live, owner-scoped project records exposed to the manager."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, UTC
from typing import Any
from ..core.ids import now_iso
from ..core.computer_identity import computer_id
from ..tasks.review import task_review
from .manager import ManagerError, manager_candidates


def project_tasks(ctx: Any, project: dict[str, Any]) -> list[dict[str, Any]]:
    tasks = [t for t in ctx.task_store.list_task_summaries(user_id=project["ownerUserId"])
            if t.get("projectId") == project["id"] and not t.get("deletedAt")
            and t.get("ownerUserId") == project["ownerUserId"]]
    waiting = ctx.task_store.open_prerequisites_for([t["id"] for t in tasks if t.get("prerequisiteTaskIds")])
    return [{**t, "waitingOn": waiting.get(t["id"], [])} for t in tasks]


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
        tasks = project_tasks(ctx, project)
        ordinary = [t for t in tasks if not t.get("isRoutine")]
        counts = Counter(t["status"] for t in ordinary)
        recent = sorted(ordinary, key=lambda t: (t.get("updatedAt", ""), t["id"]), reverse=True)[:20]
        return {
            "project": {k: project.get(k) for k in ("id", "name", "goal", "description", "context", "contextRevision", "version", "members", "leadAgentId", "managerAgentId", "computerId")},
            "readAt": now_iso(), "counts": dict(counts), "total": len(ordinary),
            "automationCount": len(tasks) - len(ordinary),
            "agents": [{"id": a["id"], "name": a["displayName"], "role": a.get("defaultRole")} for a in manager_candidates(ctx, project)],
            "teams": [{"id": team["id"], "name": team.get("name") or team.get("displayName")}
                      for team in ctx.team_store.list_teams(project["ownerUserId"]) if team.get("computerId") == project["computerId"]],
            "flowPolicy": {"wipLimit": ctx.task_store.wip_limit_for_user(project["ownerUserId"]),
                           "occupied": ctx.task_store.count_wip(project["ownerUserId"])},
            "computers": [{k: n.get(k) for k in ("id", "computerId", "online", "dispatchable", "status")}
                          for n in ctx.registry.monitor_nodes() if computer_id(n) == project["computerId"]],
            "recentTasks": [_compact(project, t) for t in recent],
            "coverage": {"total": len(ordinary), "shown": len(recent), "complete": len(recent) == len(ordinary)},
        }


def read_manager_tool(ctx: Any, project: dict[str, Any], tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    for key in ("taskId", "threadId", "query", "status", "since", "cutoff"):
        if key in arguments and (not isinstance(arguments[key], str) or len(arguments[key]) > 500):
            raise ManagerError("manager_arguments_invalid", 400)
    if tool == "overview":
        return manager_overview(ctx, project)
    if tool in ("task", "review"):
        task = scoped_task(ctx, project, arguments.get("taskId", ""))
        if tool == "review":
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
        return {"task": {**task, "events": events[-50:], "url": task_link(project["id"], task["id"]), "revision": task_revision(task)},
                "coverage": {"totalEvents": len(events), "shownEvents": min(len(events), 50)}}
    if tool == "threads":
        sessions = ctx.session_store.list_session_snapshots(owner_user_id=project["ownerUserId"], project_id=project["id"])
        return {"threads": [{"id": s["id"], "taskGoal": s.get("taskGoal"), "url": f"/threads/{s['id']}"} for s in sessions[:100]], "total": len(sessions)}
    if tool == "thread":
        thread_id = arguments.get("threadId", "")
        try:
            session = ctx.session_store.get_session(thread_id)
        except KeyError as error:
            raise ManagerError("thread_not_found", 404) from error
        if not session or session.get("projectId") != project["id"] or session.get("ownerUserId") != project["ownerUserId"]:
            raise ManagerError("thread_not_found", 404)
        messages = _thread_messages(session, project)
        cursor = arguments.get("cursor", max(0, len(messages) - 50))
        if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
            raise ManagerError("manager_pagination_invalid", 400)
        page = messages[cursor:cursor + 50]
        return {"messages": [{**m, "text": m["text"][:8000], "truncated": len(m["text"]) > 8000} for m in page],
                "nextCursor": cursor + 50 if len(messages) > cursor + 50 else None,
                "previousCursor": max(0, cursor - 50) if cursor else None,
                "coverage": {"total": len(messages), "shown": len(page), "maxMessageChars":8000}, "url": f"/threads/{thread_id}"}
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
            cutoff_at = datetime.fromisoformat(cutoff.replace("Z", "+00:00"))
            cutoff_at = cutoff_at.replace(tzinfo=cutoff_at.tzinfo or UTC)
            since_at = None
            if since:
                since_at = datetime.fromisoformat(since.replace("Z", "+00:00"))
                since_at = since_at.replace(tzinfo=since_at.tzinfo or UTC)
            if since_at and since_at > cutoff_at:
                raise ValueError("Reversed time range")
        except (ValueError, TypeError, AttributeError) as error:
            raise ManagerError("manager_time_invalid", 400) from error
        events = []
        for summary in tasks:
            task = scoped_task(ctx, project, summary["id"])
            for i, event in enumerate(task.get("events", [])):
                at = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
                at = at.replace(tzinfo=at.tzinfo or UTC)
                if (since_at is None or since_at <= at) and at <= cutoff_at:
                    events.append({"taskId": task["id"], "sequence": i, "event": event, "url": task_link(project["id"], task["id"])})
        for i, event in enumerate(ctx.project_store.events(project["id"])):
            at = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
            if (since_at is None or since_at <= at) and at <= cutoff_at:
                # Exclude the full Project snapshots carried by these events.
                facts = {k:event[k] for k in ("id", "type", "timestamp", "patch") if k in event}
                events.append({"projectId":project["id"], "sequence":i, "event":facts, "url":f"/projects/{project['id']}"})
        for thread in ctx.session_store.list_session_snapshots(owner_user_id=project["ownerUserId"], project_id=project["id"]):
            source = None
            for i, run in enumerate(thread.get("agentRuns", [])):
                timestamp = run.get("completedAt")
                if not timestamp:
                    continue
                at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                if (since_at is not None and at < since_at) or at > cutoff_at:
                    continue
                # Headers intentionally omit agentLog. Hydrate only a Thread
                # that has a report in the requested window.
                if source is None:
                    try:
                        source = ctx.session_store.get_session(thread["id"])
                    except KeyError:
                        break  # A concurrently deleted Thread contributes no report.
                report = next((e for e in source.get("events", []) if e["type"] == "agent.completed" and e.get("runId") == run["id"]), None)
                if report:
                    facts = {k:report[k] for k in ("id", "type", "timestamp", "runId", "agent", "logicalAgentId", "exitCode") if k in report}
                    text = str(report.get("agentLog") or "")
                    facts.update(agentLog=text[:8000], reportTruncated=len(text) > 8000, evidenceKind="agent_report")
                    events.append({"threadId":thread["id"], "sequence":i, "event":facts, "url":f"/threads/{thread['id']}"})
        events.sort(key=lambda e: (e["event"].get("timestamp", ""), e.get("taskId") or e.get("threadId") or project["id"], e["sequence"]))
        cursor = arguments.get("cursor", 0)
        limit = arguments.get("limit", 50)
        if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
            raise ManagerError("manager_pagination_invalid", 400)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 50:
            raise ManagerError("manager_pagination_invalid", 400)
        return {"events": events[cursor:cursor + limit], "cutoff": cutoff, "total": len(events),
                "nextCursor": cursor + limit if len(events) > cursor + limit else None}
    raise ManagerError("manager_tool_unknown", 400)


def _thread_messages(session: dict[str, Any], project: dict[str, Any]) -> list[dict[str, Any]]:
    """Conversation facts come from events, not a nonexistent messages field."""
    messages = []
    if session["id"] != project.get("managerThreadId"):
        messages.append({"id": f"{session['id']}:goal", "kind": "user", "timestamp": session["createdAt"], "text": session.get("taskGoal", "")})
    output: dict[str, list[str]] = {}
    complete = set()
    for event in session.get("events", []):
        kind = event["type"]
        if kind == "user.message":
            messages.append({"id": event["id"], "kind": "user", "timestamp": event["timestamp"], "text": event.get("text", "")})
        elif kind == "agent.completed":
            complete.add(event["runId"])
            messages.append({"id": event["id"], "kind": "agent_report", "timestamp": event["timestamp"],
                             "runId": event["runId"], "text": event.get("agentLog") or ""})
        elif kind in ("agent.output", "agent.output.batch"):
            chunks = [event] if kind == "agent.output" else event.get("entries", [])
            output.setdefault(event["runId"], []).extend(str(chunk.get("text", "")) for chunk in chunks)
    for run in session.get("agentRuns", []):
        if run["id"] not in complete:
            messages.append({"id": run["id"], "kind": "agent_report", "timestamp": run["startedAt"],
                             "runId": run["id"], "text": "".join(output.get(run["id"], []))})
    return sorted(messages, key=lambda m: (m["timestamp"], m["id"]))
