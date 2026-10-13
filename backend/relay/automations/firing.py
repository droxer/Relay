"""Fire one occurrence per pending automation.

The matcher parks matched events as pending state per automation; this
module turns that state into at most one triggered occurrence per tick,
subject to the in-flight, expiry, and hourly rate-cap rules.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

from loguru import logger

from .clock import next_routine_date
from .context import trigger_context_block
from .model import trigger_kind

PENDING_TTL = timedelta(hours=24)
RATE_WINDOW = timedelta(hours=1)
IN_FLIGHT_STATUSES = frozenset({"backlog", "assigned", "running"})
# Occurrences are appended in creation order, so an in-flight one is among the
# newest. Bounding the scan keeps a long-lived routine's check constant-time.
IN_FLIGHT_LOOKBACK = 10
RATE_LIMITED = "rate_limited"


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def in_flight_occurrence(task_store: Any, routine: dict[str, Any]) -> dict[str, Any] | None:
    """The newest occurrence of ``routine`` still queued or running, if any."""
    for occurrence_id in reversed((routine.get("occurrenceIds") or [])[-IN_FLIGHT_LOOKBACK:]):
        try:
            occurrence = task_store.get_task(occurrence_id)
        except (KeyError, FileNotFoundError):
            continue
        if not occurrence.get("deletedAt") and occurrence.get("status") in IN_FLIGHT_STATUSES:
            return occurrence
    return None


class AutomationFiring:
    def __init__(
        self,
        *,
        task_store: Any,
        automation_store: Any,
        today: Callable[[], date] = date.today,
        max_runs_per_hour: int = 6,
    ) -> None:
        self.task_store = task_store
        self.automation_store = automation_store
        self._today = today
        self.max_runs_per_hour = max_runs_per_hour

    def fire(self, now: datetime) -> int:
        fired = 0
        for state in self.automation_store.list_pending_states():
            if self._fire_one(state, now):
                fired += 1
        return fired

    def _fire_one(self, state: dict[str, Any], now: datetime) -> bool:
        routine_id = state["routine_id"]
        routine = self._load(routine_id)
        events = state["pending_events"]
        manual = any(event.get("eventType") == "manual" for event in events)
        if not routine or not routine.get("routineEnabled") or (
            trigger_kind(routine) in ("schedule", "manual") and not manual
        ):
            self.automation_store.clear_state(routine_id)
            return False
        if now - _aware(state["pending_since"]) > PENDING_TTL:
            count = len(state["pending_events"]) + int(state["pending_dropped"])
            self.task_store.record_activity(routine_id, f"Automation dropped {count} pending events after 24 hours without a run.")
            logger.warning("Automation pending events expired", routine_id=routine_id, count=count)
            self.automation_store.clear_state(routine_id)
            return False
        if in_flight_occurrence(self.task_store, routine):
            return False
        window_start = _aware(state["fired_window_start"])
        count = int(state["fired_count"])
        if window_start is None or now - window_start >= RATE_WINDOW:
            window_start, count = now, 0
        if count >= self.max_runs_per_hour:
            self.task_store.update_task(routine_id, {"routineEnabled": False, "routineDisabledReason": RATE_LIMITED})
            self.task_store.record_activity(routine_id, f"Automation paused: more than {self.max_runs_per_hour} runs in an hour.")
            logger.warning("Automation paused by rate cap", routine_id=routine_id)
            self.automation_store.clear_state(routine_id)
            return False
        events = state["pending_events"]
        today = self._today()
        run_date = today.isoformat()
        due_date = routine.get("routineNextRunDate") if manual and trigger_kind(routine) == "schedule" else None
        if due_date and due_date <= run_date:
            run_date = due_date
        occurrence = self.task_store.create_triggered_occurrence(
            routine_id,
            run_date=run_date,
            trigger_kind="manual" if manual else trigger_kind(routine),
            summary={"eventType": "manual" if manual else events[0]["eventType"],
                     "eventCount": len(events) + int(state["pending_dropped"]),
                     **({"toStatus": events[0]["toStatus"]} if events[0].get("toStatus") else {})},
            # A manual click must not reset a chain's depth: coalesced chain
            # events would otherwise start counting again from zero.
            depth=max(int(event.get("depth") or 0) for event in events),
            context=trigger_context_block(events, int(state["pending_dropped"]),
                                          fired_by="manual" if manual else None),
        )
        if not occurrence:
            # No agent, team, or project yet: keep the events until one is
            # assigned or they expire, and say so once.
            logger.info("Automation could not start", routine_id=routine_id)
            return False
        if due_date and due_date <= today.isoformat():
            next_date = next_routine_date(date.fromisoformat(due_date), routine.get("routineCadence") or "weekly", today)
            self.task_store.update_task(routine_id, {"routineNextRunDate": next_date.isoformat() if next_date else ""})
        self.automation_store.save_state(routine_id, {
            "routine_id": routine_id, "pending": False, "pending_events": [], "pending_dropped": 0,
            "pending_since": None, "fired_window_start": window_start, "fired_count": count + 1,
        })
        logger.info("Automation fired", routine_id=routine_id, occurrence_id=occurrence["id"], events=len(events))
        return True

    def _load(self, task_id: str) -> dict[str, Any] | None:
        try:
            task = self.task_store.get_task(task_id)
        except (KeyError, FileNotFoundError):
            return None
        return None if task.get("deletedAt") or not task.get("isRoutine") else task
