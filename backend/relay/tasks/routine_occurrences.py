"""Routine occurrences: the one an automation is running, and its result."""
from __future__ import annotations

from typing import Any

from ..persistence.protocols import TaskStore
from .dispatch_outcome import DispatchResult, TaskDispatchContext, _result


def existing_routine_occurrence_result(
    ctx: TaskDispatchContext,
    routine: dict[str, Any],
    occurrence: dict[str, Any],
) -> DispatchResult | None:
    for session_id in reversed(occurrence.get("linkedSessionIds", [])):
        try:
            session = ctx.session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            continue
        if (
            occurrence.get("status") == "assigned"
            and session.get("status") in ("completed", "failed", "cancelled")
        ):
            continue
        if session_id not in routine.get("linkedSessionIds", []):
            ctx.task_store.link_session(routine["id"], session_id)
        return _result(occurrence, "started", session=session, code="already_started")
    return None


def active_routine_occurrence(
    task_store: TaskStore,
    routine: dict[str, Any],
) -> dict[str, Any] | None:
    for event in reversed(routine.get("events", [])):
        if event.get("type") != "task.occurrence_created":
            continue
        occurrence_id = event.get("occurrenceId")
        if not isinstance(occurrence_id, str) or not occurrence_id:
            continue
        try:
            occurrence = task_store.get_task(occurrence_id)
        except (KeyError, FileNotFoundError):
            continue
        if not occurrence.get("deletedAt") and occurrence.get("status") in {"backlog", "assigned", "running", "review", "blocked", "waiting_for_human"}:
            return occurrence
    return None
