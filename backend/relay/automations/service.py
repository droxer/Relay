"""One tick of automation work: the schedule clock, outbox matching, then
firing — all in one locked transaction."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from loguru import logger
from sqlalchemy import text

from ..persistence.automation_store import AUTOMATION_LOCK_KEY
from ..persistence.store_common import store_transaction
from .clock import ScheduleClock
from .firing import AutomationFiring, in_flight_occurrence
from .matcher import AutomationMatcher
from .model import is_active

if TYPE_CHECKING:
    from ..api.deps import AppContext

DEFAULT_MAX_RUNS_PER_HOUR = 6
DEFAULT_OUTBOX_BATCH = 200


def max_runs_per_hour_from_env() -> int:
    return max(1, int(os.environ.get("RELAY_AUTOMATION_MAX_RUNS_PER_HOUR", str(DEFAULT_MAX_RUNS_PER_HOUR))))


class AutomationService:
    def __init__(
        self,
        *,
        task_store: Any,
        session_store: Any,
        automation_store: Any,
        project_store: Any,
        max_runs_per_hour: int = DEFAULT_MAX_RUNS_PER_HOUR,
        batch: int = DEFAULT_OUTBOX_BATCH,
    ) -> None:
        self.task_store = task_store
        self.automation_store = automation_store
        self.project_store = project_store
        self.clock = ScheduleClock(task_store=task_store, automation_store=automation_store)
        self.matcher = AutomationMatcher(task_store=task_store, session_store=session_store,
                                         automation_store=automation_store, batch=batch)
        self.firing = AutomationFiring(task_store=task_store, automation_store=automation_store,
                                       max_runs_per_hour=max_runs_per_hour)

    def tick(self, now: datetime) -> int:
        """Return the number of occurrences fired."""
        try:
            # A failed tick must not lose outbox events, advance a schedule
            # past an unfired slot, or leave a partially fired run.
            with store_transaction(self.automation_store.engine) as conn:
                # Claims partition outbox rows, but pending states are shared
                # across ticks. One database-wide transaction lock keeps two
                # replicas from firing the same state; a busy one waits a tick.
                if conn.dialect.name == "postgresql" and not conn.scalar(
                    text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": AUTOMATION_LOCK_KEY}
                ):
                    return 0
                self.clock.run(now)
                self.matcher.drain(now)
                return self.firing.fire(now)
        except Exception:
            logger.exception("Automation tick failed")
            return 0


def _runnable(task: dict[str, Any]) -> bool:
    """Active in v2; a snapshot without ``routineState`` answers by its
    legacy ``routineEnabled``."""
    if "routineState" in task:
        return is_active(task)
    return bool(task.get("isRoutine") and task.get("routineEnabled") and not task.get("deletedAt"))


def _pause_reason(task: dict[str, Any]) -> str | None:
    return task.get("routinePauseReason") or task.get("routineDisabledReason")


def request_manual_occurrence(automation_store: Any, ctx: AppContext, task: dict[str, Any], actor: dict[str, Any]) -> dict[str, Any]:
    if not actor["isAdmin"] and task.get("ownerEmployeeId") != actor.get("employeeId"):
        raise HTTPException(403, "Only the automation's owner or an admin can run it.")
    if not _runnable(task):
        return {"task": task, "session": None, "dispatch": {
            "state": "rejected", "code": _pause_reason(task) or "automation_disabled",
            "message": "Enable this automation before running it.",
        }}
    # A run already queued or running answers the click. Queueing a manual
    # event behind it would start a second run the user never asked for.
    active = in_flight_occurrence(ctx.task_store, task)
    if active:
        return _active_occurrence_result(ctx, task, active)
    automation_store.enqueue_manual(task["id"])
    # Use the same locked tick as the scheduler. Running it here preserves the
    # endpoint's immediate-dispatch response when nothing else is in flight.
    AutomationService(task_store=ctx.task_store, session_store=ctx.session_store,
                      automation_store=automation_store, project_store=ctx.project_store,
                      max_runs_per_hour=max_runs_per_hour_from_env()).tick(datetime.now(timezone.utc))
    refreshed = ctx.task_store.get_task(task["id"])
    previous = set(task.get("occurrenceIds") or [])
    new_ids = [item for item in refreshed.get("occurrenceIds", []) if item not in previous]
    if new_ids:
        return ctx.task_store.get_task(new_ids[-1])
    return {"task": refreshed, "session": None, "dispatch": {
        "state": "queued" if _runnable(refreshed) else "rejected",
        "code": _pause_reason(refreshed) or "automation_pending",
        "message": "Run now is coalesced with pending automation events." if _runnable(refreshed) else "Automation paused by its hourly run limit.",
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
