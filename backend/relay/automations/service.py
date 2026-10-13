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
from .clock import ScheduleClock, next_run_at
from .firing import AutomationFiring, in_flight_occurrence, triggered_target
from .matcher import AutomationMatcher
from .model import LEGACY_FIELDS, TriggerError, normalize_triggers, state_of, triggers_of

if TYPE_CHECKING:
    from ..api.deps import AppContext

DEFAULT_MAX_RUNS_PER_HOUR = 6
DEFAULT_OUTBOX_BATCH = 200


OWNER_STATES = ("active", "paused")


def automation_triggers_enabled() -> bool:
    """``RELAY_AUTOMATION_TRIGGERS_ENABLED=0`` limits new triggers to schedules."""
    return os.environ.get("RELAY_AUTOMATION_TRIGGERS_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")


def routine_fields_v2(body: dict[str, Any], *, current: dict[str, Any] | None, now: datetime) -> dict[str, Any]:
    """The routine slice of a ``task.created`` / ``task.updated`` payload.

    Pure: raises ``TriggerError`` for the API to answer 400. A body that
    touches no routine field returns ``{}``; one that leaves the state alone
    keeps it, including a ``paused_by_relay`` only Relay sets.
    """
    legacy = [field for field in LEGACY_FIELDS if field in body]
    if legacy:
        raise TriggerError(f"{legacy[0]} was replaced by routineTriggers and routineState; see docs/api.md.")
    if not {"isRoutine", "routineTriggers", "routineState"} & set(body):
        return {}
    if "isRoutine" in body and not isinstance(body["isRoutine"], bool):
        raise TriggerError("isRoutine must be a boolean.")
    is_routine = body["isRoutine"] if "isRoutine" in body else bool((current or {}).get("isRoutine", True))
    if not is_routine:
        return {"isRoutine": False}
    if "routineState" in body and body["routineState"] not in OWNER_STATES:
        raise TriggerError("routineState must be active or paused; only Relay pauses an automation.")
    triggers = normalize_triggers(body["routineTriggers"]) if "routineTriggers" in body else triggers_of(current or {})
    state = body.get("routineState") or (state_of(current) if current else "paused")
    fields: dict[str, Any] = {"isRoutine": True, "routineTriggers": triggers, "routineState": state}
    if state == "active":
        fields["routinePauseReason"] = None
        fields["routineNextRunAt"] = next_run_at({"routineTriggers": triggers}, now)
    else:
        fields["routineNextRunAt"] = None
    return fields


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
                                       project_store=project_store, max_runs_per_hour=max_runs_per_hour)

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


def _run_now_refusal(task: dict[str, Any]) -> str | None:
    """Run now works in every state but a rate-limit pause (spec §2)."""
    if not task.get("isRoutine") or task.get("deletedAt"):
        return "automation_disabled"
    if state_of(task) == "paused_by_relay" and task.get("routinePauseReason") == "rate_limited":
        return "rate_limited"
    return None


REFUSAL_MESSAGES = {
    "rate_limited": "Automation paused by its hourly run limit. Resume it before running it again.",
    "automation_disabled": "This automation was deleted or is no longer an automation.",
}


def request_manual_occurrence(automation_store: Any, ctx: AppContext, task: dict[str, Any], actor: dict[str, Any]) -> dict[str, Any]:
    if not actor["isAdmin"] and task.get("ownerEmployeeId") != actor.get("employeeId"):
        raise HTTPException(403, "Only the automation's owner or an admin can run it.")
    refusal = _run_now_refusal(task)
    if refusal:
        return {"task": task, "session": None, "dispatch": {
            "state": "rejected", "code": refusal,
            "message": REFUSAL_MESSAGES[refusal],
        }}
    if not triggered_target(task, ctx.project_store):
        return {"task": task, "session": None, "dispatch": {
            "state": "rejected", "code": "no_target",
            "message": "Assign an agent, team, or open project before running this automation.",
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
    refusal = _run_now_refusal(refreshed)
    return {"task": refreshed, "session": None, "dispatch": {
        "state": "rejected" if refusal else "queued",
        "code": refusal or "automation_pending",
        "message": REFUSAL_MESSAGES[refusal] if refusal else "Run now is coalesced with pending automation events.",
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
