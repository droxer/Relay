"""One tick of automation work: event matching, then the schedule clock."""

from __future__ import annotations

import os
from datetime import date
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from loguru import logger

from .clock import ScheduleClock
from .firing import in_flight_occurrence
from .matcher import AutomationMatcher

if TYPE_CHECKING:
    from ..api.deps import AppContext


class AutomationService:
    def __init__(self, *, matcher: AutomationMatcher | None, clock: ScheduleClock) -> None:
        self.matcher = matcher
        self.clock = clock

    def tick(self, today: date) -> tuple[int, int, int]:
        """Return (fired, promoted, skipped)."""
        fired = self._fire()
        promoted, skipped = self.clock.run(today)
        return fired, promoted, skipped

    def _fire(self) -> int:
        if self.matcher is None:
            return 0
        try:
            return self.matcher.run()
        except Exception:
            logger.exception("Automation matching failed")
            return 0


def request_manual_occurrence(automation_store: Any, ctx: AppContext, task: dict[str, Any], actor: dict[str, Any]) -> dict[str, Any]:
    if not actor["isAdmin"] and task.get("ownerEmployeeId") != actor.get("employeeId"):
        raise HTTPException(403, "Only the automation's owner or an admin can run it.")
    if not task.get("routineEnabled"):
        return {"task": task, "session": None, "dispatch": {
            "state": "rejected", "code": task.get("routineDisabledReason") or "automation_disabled",
            "message": "Enable this automation before running it.",
        }}
    # A run already queued or running answers the click. Queueing a manual
    # event behind it would start a second run the user never asked for.
    active = in_flight_occurrence(ctx.task_store, task)
    if active:
        return _active_occurrence_result(ctx, task, active)
    automation_store.enqueue_manual(task["id"])
    # Use the same transactional matcher and lock as scheduler ticks. Running
    # it here preserves the endpoint's immediate-dispatch response when free.
    matcher = AutomationMatcher(task_store=ctx.task_store, session_store=ctx.session_store,
        automation_store=automation_store, today=ctx.today,
        max_runs_per_hour=max(1, int(os.environ.get("RELAY_AUTOMATION_MAX_RUNS_PER_HOUR", "6"))))
    matcher.run()
    refreshed = ctx.task_store.get_task(task["id"])
    previous = set(task.get("occurrenceIds") or [])
    new_ids = [item for item in refreshed.get("occurrenceIds", []) if item not in previous]
    if new_ids:
        return ctx.task_store.get_task(new_ids[-1])
    return {"task": refreshed, "session": None, "dispatch": {
        "state": "queued" if refreshed.get("routineEnabled") else "rejected",
        "code": refreshed.get("routineDisabledReason") or "automation_pending",
        "message": "Run now is coalesced with pending automation events." if refreshed.get("routineEnabled") else "Automation paused by its hourly run limit.",
    }}


def _active_occurrence_result(
    ctx: AppContext, routine: dict[str, Any], active: dict[str, Any]
) -> dict[str, Any]:
    """Answer Run now with the occurrence already in flight. A queued one may
    need waking after its computer comes online; its assignment is immutable
    even if the definition was edited later."""
    if active.get("linkedSessionIds"):
        # Deferred: services.task_dispatch imports relay.tasks, which imports this module.
        from ..services.task_dispatch import existing_routine_occurrence_result

        existing = existing_routine_occurrence_result(ctx, routine, active)
        if existing:
            return existing
    if active.get("status") in ("backlog", "assigned"):
        return active
    return {"task": routine, "session": None, "dispatch": {
        "state": "queued", "code": "automation_running",
        "message": "This automation is already running.",
    }}
