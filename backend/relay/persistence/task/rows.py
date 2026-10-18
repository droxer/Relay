"""Task rows, compact snapshots, and the ordering expressions task queries use.
"""

from __future__ import annotations

from datetime import date as _date
from datetime import datetime, UTC
from typing import Any
from sqlalchemy import (
    case,
)
from ...automations.model import listens, schedule_triggers, state_of
from ..store_common import (
    _parse_iso,
    new_database_id,
)
from ..tables import tasks as tasks_tables


def compact_task_summary(
    task: dict[str, Any],
    *,
    event_count: int | None = None,
    activity_count: int | None = None,
) -> dict[str, Any]:
    """Return an explicit task-list projection without authoritative histories."""
    events = task.get("events") or []
    activity = task.get("activity") or []
    summary = {
        key: value
        for key, value in task.items()
        if key not in {"events", "activity"}
    }
    summary["eventCount"] = len(events) if event_count is None else event_count
    summary["activityCount"] = (
        len(activity) if activity_count is None else activity_count
    )
    if activity:
        summary["lastActivity"] = activity[-1]
    return summary


def compact_task_snapshot(
    task: dict[str, Any], *, event_count: int | None = None
) -> dict[str, Any]:
    """Persist current task state without duplicating event/activity history."""
    snapshot = {
        key: value
        for key, value in task.items()
        if key not in {"events", "activity", "eventCount", "activityCount"}
    }
    events = task.get("events") or []
    activity = task.get("activity") or []
    snapshot["eventCount"] = len(events) if event_count is None else event_count
    snapshot["activityCount"] = (
        len(activity) if "activity" in task else int(task.get("activityCount") or 0)
    )
    if activity:
        snapshot["lastActivity"] = activity[-1]
    elif "activity" in task:
        snapshot.pop("lastActivity", None)
    return snapshot


def task_to_row(
    task: dict[str, Any], *, version: int, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or task["id"],
        "title": task["title"],
        "description": task.get("description", ""),
        "priority": task.get("priority", "normal"),
        "status": task["status"],
        "assigned_agent": task.get("assignedAgent"),
        "assigned_agent_id": task.get("assignedAgentId"),
        "assigned_team_id": task.get("assignedTeamId"),
        "project_id": task.get("projectId"),
        "owner_user_id": task.get("ownerUserId"),
        "assignee_user_id": task.get("assigneeUserId"),
        "due_date": _parse_date(task.get("dueDate")),
        "is_routine": bool(task.get("isRoutine")),
        # Legacy columns: nothing reads them since the v2 clock; they are
        # written empty until a later migration drops them.
        "routine_type": None,
        "routine_cadence": None,
        "routine_next_run_date": None,
        "routine_enabled": bool(task.get("isRoutine")) and state_of(task) == "active",
        "routine_trigger_kind": None,
        "routine_next_run_at": _parse_datetime(task.get("routineNextRunAt")),
        "routine_state": state_of(task) if task.get("isRoutine") else None,
        "routine_listens": bool(task.get("isRoutine")) and listens(task),
        "routine_has_schedule": bool(task.get("isRoutine")) and bool(schedule_triggers(task)),
        "number_scope": task.get("numberScope"),
        "number": task.get("number"),
        "dispatch_failure_count": int(
            (task.get("dispatchRetry") or {}).get("failureCount") or 0
        ),
        "dispatch_next_attempt_at": _parse_iso(
            (task.get("dispatchRetry") or {}).get("nextAttemptAt")
        ),
        "snapshot": compact_task_snapshot(task, event_count=version),
        "version": version,
        "created_at": _parse_iso(task["createdAt"]),
        "updated_at": _parse_iso(task["updatedAt"]),
        "deleted_at": _parse_iso(task.get("deletedAt")),
    }


def task_event_to_row(
    task_pk: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "task_id": task_pk,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": _parse_iso(event["timestamp"]),
        "payload": event,
    }


def _parse_date(value: str | None) -> Any:
    if not value:
        return None
    return _date.fromisoformat(value)


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _priority_rank(priority: Any) -> int:
    return {"high": 0, "normal": 1, "low": 2}.get(priority, 1)


def task_claim_sort_key(task: dict[str, Any]) -> tuple[int, str, str, str]:
    priority_rank = _priority_rank(task.get("priority"))
    due_date = task.get("dueDate") or "9999-12-31"
    return (priority_rank, due_date, task.get("createdAt") or "", task["id"])


def _priority_order_expression() -> Any:
    return case(
        (tasks_tables.tasks.c.priority == "high", 0),
        (tasks_tables.tasks.c.priority == "normal", 1),
        (tasks_tables.tasks.c.priority == "low", 2),
        else_=1,
    )


def _due_date_missing_expression() -> Any:
    return case((tasks_tables.tasks.c.due_date.is_(None), 1), else_=0)
