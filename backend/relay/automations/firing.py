"""Fire one occurrence per pending automation.

The matcher parks matched events as pending state per automation; this
module turns that state into at most one triggered occurrence per tick,
subject to the in-flight, expiry, target, and hourly rate-cap rules. An
automation Relay cannot run — no target, or runaway volume — is paused
rather than left holding events.
"""

from __future__ import annotations

from datetime import datetime, timedelta, UTC
from typing import Any, overload

from loguru import logger

from ..services.project_runtime import project_work_error
from .context import trigger_context_block
from .matcher import listens_for
from .model import has_webhook, is_active
from .schedule import resolve_timezone

PENDING_TTL = timedelta(hours=24)
RATE_WINDOW = timedelta(hours=1)
IN_FLIGHT_STATUSES = frozenset({"backlog", "assigned", "running"})
# Occurrences are appended in creation order, so an in-flight one is among the
# newest. Bounding the scan keeps a long-lived routine's check constant-time.
IN_FLIGHT_LOOKBACK = 10
RATE_LIMITED = "rate_limited"
# Consecutive failed occurrences before Relay pauses the automation.
FAILURE_LIMIT = 3
FAILING = "failing"
NO_TARGET_RUN_NOW = "Run now could not start: the automation has no agent, team, or open project."


@overload
def _aware(value: datetime) -> datetime: ...
@overload
def _aware(value: None) -> None: ...
def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


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
        project_store: Any = None,
        max_runs_per_hour: int = 6,
    ) -> None:
        self.task_store = task_store
        self.automation_store = automation_store
        self.project_store = project_store
        self.max_runs_per_hour = max_runs_per_hour

    def fire(self, now: datetime) -> int:
        fired = 0
        for state in self.automation_store.list_pending_states():
            if self._fire_one(state, now):
                fired += 1
        return fired

    def fire_one(self, routine_id: str, now: datetime) -> bool:
        state = self.automation_store.get_state(routine_id)
        return bool(state["pending"] and self._fire_one(state, now))

    def _fire_one(self, state: dict[str, Any], now: datetime) -> bool:
        routine_id = state["routine_id"]
        routine = self._load(routine_id)
        events = [event for event in state["pending_events"] if routine and still_listened(routine, event)]
        manual = any(event.get("eventType") == "manual" for event in events)
        scheduled_only = all(event.get("eventType") == "schedule" for event in events)
        # Run now speaks for itself, even on a paused automation — but not
        # when Relay paused it for runaway volume.
        runnable = routine and events and (
            is_active(routine) or (manual and routine.get("routinePauseReason") != RATE_LIMITED)
        )
        # ``runnable`` already implies ``routine``; the check only narrows it.
        if not routine or not runnable:
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
        if not triggered_target(routine, self.project_store):
            if not is_active(routine):
                # Run now on a paused automation never changes its state.
                self.task_store.record_activity(routine_id, NO_TARGET_RUN_NOW)
                self.automation_store.clear_state(routine_id)
                return False
            self.pause(routine_id, "no_target", "Automation paused: it has no agent, team, or open project to run on.")
            return False
        window_start = _aware(state["fired_window_start"])
        count = int(state["fired_count"])
        if window_start is None or now - window_start >= RATE_WINDOW:
            window_start, count = now, 0
        # A schedule fires at most once per slot, so only event, webhook, and
        # manual firings count toward the hourly cap.
        if not scheduled_only and count >= self.max_runs_per_hour:
            self.pause(routine_id, RATE_LIMITED, f"Automation paused: more than {self.max_runs_per_hour} runs in an hour.")
            return False
        kind = fired_kind(events, manual)
        occurrence = self.task_store.create_triggered_occurrence(
            routine_id,
            # The occurrence's calendar day is the server's.
            run_date=now.astimezone(resolve_timezone(None)).date().isoformat(),
            trigger_kind=kind,
            summary={"eventType": "manual" if manual else events[0]["eventType"],
                     "eventCount": len(events) + int(state["pending_dropped"]),
                     **({"toStatus": events[0]["toStatus"]} if events[0].get("toStatus") else {})},
            # A manual click must not reset a chain's depth: coalesced chain
            # events would otherwise start counting again from zero.
            depth=max(int(event.get("depth") or 0) for event in events),
            context=trigger_context_block(events, int(state["pending_dropped"]),
                                          fired_by="manual" if manual else None),
            allow_paused=manual,
        )
        if not occurrence:
            logger.info("Automation could not start", routine_id=routine_id)
            return False
        self.automation_store.save_state(routine_id, {
            **state, "pending": False, "pending_events": [], "pending_dropped": 0, "pending_since": None,
            "fired_window_start": window_start, "fired_count": count if scheduled_only else count + 1,
        })
        logger.info("Automation fired", routine_id=routine_id, occurrence_id=occurrence["id"], kind=kind,
                    events=len(events))
        return True

    def record_outcome(self, routine_id: str, occurrence_id: str, failed: bool) -> None:
        """Count one finished occurrence, once. ``FAILURE_LIMIT`` failed
        occurrences in a row pause the automation; a done one ends the streak."""
        count = self.automation_store.record_outcome(routine_id, occurrence_id, failed)
        if not failed or count is None or count < FAILURE_LIMIT:
            return
        routine = self._load(routine_id)
        if routine and is_active(routine):
            self.pause(routine_id, FAILING, f"Automation paused: its last {FAILURE_LIMIT} runs failed.")

    def pause(self, routine_id: str, reason: str, message: str) -> None:
        self.task_store.update_task(routine_id, {"routineState": "paused_by_relay", "routinePauseReason": reason,
                                                 "routineNextRunAt": None})
        self.task_store.record_activity(routine_id, message)
        logger.warning("Automation paused", routine_id=routine_id, reason=reason)
        self.automation_store.clear_state(routine_id)

    def _load(self, task_id: str) -> dict[str, Any] | None:
        try:
            task = self.task_store.get_task(task_id)
        except (KeyError, FileNotFoundError):
            return None
        return None if task.get("deletedAt") or not task.get("isRoutine") else task


def still_listened(routine: dict[str, Any], event: dict[str, Any]) -> bool:
    """Whether a pending event still belongs to the routine's triggers. An
    event or webhook left over after its trigger was removed is stale; Run
    now and the clock's own schedule slots always stand."""
    event_type = event.get("eventType")
    if event_type in ("manual", "schedule"):
        return True
    if event_type == "webhook":
        return has_webhook(routine)
    return listens_for(routine, event)


def fired_kind(events: list[dict[str, Any]], manual: bool) -> str:
    if manual:
        return "manual"
    event_type = events[0]["eventType"]
    if event_type in ("schedule", "webhook"):
        return event_type
    return "task_event" if event_type.startswith("task.") else "run_event"


def triggered_target(routine: dict[str, Any], project_store: Any) -> bool:
    """Whether the routine has somewhere to run: an open project, or an
    assigned agent or team."""
    if routine.get("projectId"):
        project = project_store.get_project(routine["projectId"]) if project_store else None
        return not project_work_error(project)
    return bool(routine.get("assignedAgent") or routine.get("assignedTeamId"))
