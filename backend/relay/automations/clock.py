"""The schedule clock: turns due schedule triggers into pending automation
events. It never promotes an occurrence — firing does — so schedules
coalesce behind an in-flight run and pause on a missing target exactly like
every other trigger. The clock is also the only writer of
``routineNextRunAt``'s advance, because only it may resolve the server
timezone (the reducer stays pure)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from loguru import logger

from .model import is_active, schedule_triggers
from .schedule import next_fire_after, resolve_timezone, summarize

_EPSILON = timedelta(seconds=1)
# A stored schedule that no longer evaluates (a ScheduleError, an unknown
# zone name, a malformed preset) pauses its automation instead of failing
# the whole tick for every other one.
_INVALID_SCHEDULE_ERRORS = (ValueError, KeyError, TypeError)


def next_run_at(task: dict[str, Any], after: datetime) -> str | None:
    """The earliest next fire across the task's schedule triggers, ISO UTC."""
    fires = [fire for trigger in schedule_triggers(task)
             if (fire := next_fire_after(trigger["schedule"], after)) is not None]
    return min(fires).isoformat() if fires else None


def seed_from_legacy(task: dict[str, Any], now: datetime) -> str | None:
    """A legacy routine keeps its next run date (start of day, server zone);
    anything else starts from the next fire after now."""
    try:
        day = date.fromisoformat(task["routineNextRunDate"]) if task.get("routineNextRunDate") else None
    except (TypeError, ValueError):
        day = None
    if day is not None:
        zone = resolve_timezone(None)
        return datetime(day.year, day.month, day.day, tzinfo=zone).astimezone(timezone.utc).isoformat()
    return next_run_at(task, now)


def _due_summary(task: dict[str, Any]) -> str:
    """Name the schedule whose slot came due; the first one otherwise."""
    triggers = schedule_triggers(task)
    due_at = task.get("routineNextRunAt")
    due = datetime.fromisoformat(due_at) if due_at else None
    if due is not None:
        probe = due.replace(microsecond=0) - _EPSILON
        for trigger in triggers:
            if next_fire_after(trigger["schedule"], probe) == due:
                return summarize(trigger["schedule"])
    return summarize(triggers[0]["schedule"]) if triggers else "Schedule"


class ScheduleClock:
    def __init__(self, *, task_store: Any, automation_store: Any) -> None:
        self.task_store = task_store
        self.automation_store = automation_store

    def run(self, now: datetime) -> int:
        """Seed unseeded schedules, then mark every due one pending. Returns
        the number of automations marked pending."""
        for routine in self.task_store.list_unseeded_schedules():
            self._seed(routine, now)
        marked = 0
        # Listed after seeding, so a legacy routine seeded into the past is
        # due in this same tick.
        for routine in self.task_store.list_due_schedules(now):
            marked += self._fire_slot(routine, now)
        return marked

    def run_one(self, routine_id: str, now: datetime) -> int:
        """Seed and advance one schedule inside its firing savepoint."""
        try:
            routine = self.task_store.get_task(routine_id)
        except (KeyError, FileNotFoundError):
            return 0
        if routine.get("deletedAt") or not routine.get("isRoutine") or not is_active(routine) or not schedule_triggers(routine):
            return 0
        if not routine.get("routineNextRunAt"):
            self._seed(routine, now)
            routine = self.task_store.get_task(routine_id)
        due = routine.get("routineNextRunAt")
        if due and datetime.fromisoformat(due) <= now:
            return self._fire_slot(routine, now)
        return 0

    def _seed(self, routine: dict[str, Any], now: datetime) -> None:
        try:
            seeded = seed_from_legacy(routine, now)
        except _INVALID_SCHEDULE_ERRORS as error:
            self._pause_invalid(routine, error)
            return
        # An exhausted schedule (a past one-off) stays unseeded; writing the
        # None back would append an event on every tick.
        if seeded is not None:
            self.task_store.update_task(routine["id"], {"routineNextRunAt": seeded})

    def _fire_slot(self, routine: dict[str, Any], now: datetime) -> int:
        try:
            following = next_run_at(routine, now)
            summary = _due_summary(routine)
        except _INVALID_SCHEDULE_ERRORS as error:
            self._pause_invalid(routine, error)
            return 0
        # Missed slots collapse into this one: the advance is from now, not
        # from the slot. Both writes share the caller's transaction, so a
        # failed pending write never advances past an unfired slot.
        self.task_store.update_task(routine["id"], {"routineNextRunAt": following})
        self.automation_store.mark_pending(
            routine["id"], {"eventType": "schedule", "summary": summary, "depth": 0}, now
        )
        logger.info("Automation schedule due", routine_id=routine["id"], next_run_at=following)
        return 1

    def _pause_invalid(self, routine: dict[str, Any], error: Exception) -> None:
        logger.warning("Automation schedule invalid", routine_id=routine["id"], error=str(error))
        self.task_store.update_task(routine["id"], {"routineState": "paused_by_relay",
                                                    "routinePauseReason": "invalid_schedule",
                                                    "routineNextRunAt": None})
