"""One tick of automation work: the schedule clock, outbox matching, then
firing — each automation isolated within one locked transaction."""

from __future__ import annotations

import os
from datetime import datetime, UTC
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from loguru import logger
from sqlalchemy import text

from ..persistence.automation.store import AUTOMATION_LOCK_KEY
from ..persistence.engine import store_transaction
from .clock import ScheduleClock, next_run_at
from .firing import AutomationFiring, in_flight_occurrence, triggered_target
from .matcher import AutomationMatcher
from .model import (
    LEGACY_FIELDS,
    TriggerError,
    normalize_triggers,
    state_of,
    triggers_of,
)
from .schedule import next_fire_after
from ..tasks.dispatch_outcome import DispatchResult
from ..tasks.routine_occurrences import existing_routine_occurrence_result
from ..security.actor import Actor

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
        # An unchanged, completed one-off remains editable. New schedules and
        # a transition back to active must still have their one-off in the future.
        if (not current or not current.get("isRoutine") or state_of(current) != "active"
                or triggers != triggers_of(current)):
            validate_future_once(triggers, now)
        fields["routinePauseReason"] = None
        fields["routineNextRunAt"] = next_run_at({"routineTriggers": triggers}, now)
    else:
        fields["routineNextRunAt"] = None
    return fields


def validate_future_once(triggers: list[dict[str, Any]], now: datetime) -> None:
    """Reject an expired one-off when saving or activating a schedule."""
    for index, trigger in enumerate(triggers):
        if trigger["kind"] != "schedule":
            continue
        schedule = trigger["schedule"]
        if "once" in schedule["repeat"] and next_fire_after(schedule, now) is None:
            raise TriggerError(f"routineTriggers[{index}].schedule.repeat.once must be in the future.")


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
        self.firing = AutomationFiring(task_store=task_store, automation_store=automation_store,
                                       project_store=project_store, max_runs_per_hour=max_runs_per_hour)
        self.matcher = AutomationMatcher(task_store=task_store, session_store=session_store,
                                         automation_store=automation_store, firing=self.firing, batch=batch)

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
                # SQLite legacy transaction mode does not BEGIN on reads.
                # Begin explicitly before a savepoint, whose release must
                # never commit independently of this outer transaction.
                if conn.dialect.name == "sqlite" and not conn.connection.driver_connection.in_transaction:
                    conn.exec_driver_sql("BEGIN")
                rows, deliveries = self.matcher.prepare(now)
                routine_ids = dict.fromkeys([
                    *(task["id"] for task in self.task_store.list_unseeded_schedules()),
                    *(task["id"] for task in self.task_store.list_due_schedules(now)),
                    *deliveries,
                    *(state["routine_id"] for state in self.automation_store.list_pending_states()),
                ])
                fired = 0
                failed = {}
                for routine_id in routine_ids:
                    try:
                        # State/outcome writes, schedule advance, and occurrence
                        # creation either all commit or all roll back together.
                        with conn.begin_nested():
                            self.matcher.deliver(routine_id, deliveries.get(routine_id, []), now)
                            self.clock.run_one(routine_id, now)
                            did_fire = self.firing.fire_one(routine_id, now)
                        fired += int(did_fire)
                    except Exception:  # noqa: BLE001 - isolate a failed automation after savepoint rollback
                        logger.exception("Automation processing failed", routine_id=routine_id)
                        failed[routine_id] = deliveries.get(routine_id, [])
                self.matcher.finish(rows, failed, now)
                return fired
        except Exception:  # noqa: BLE001 - tick supervisor: a failed tick logs and retries next interval
            logger.exception("Automation tick failed")
            return 0

    def resume(self, task_id: str, actor: Actor, now: datetime) -> dict[str, Any]:
        """Turn a paused automation back on. Owner or admin only
        (``PermissionError`` otherwise); an active one is returned as is."""
        with store_transaction(self.task_store.engine) as conn:
            lock_automation_state(conn)
            task = self.task_store.get_task(task_id)
            if not actor.get("isAdmin") and task.get("ownerUserId") != actor.get("userId"):
                raise PermissionError("Only the automation's owner or an admin can resume it.")
            if state_of(task) == "active":
                return task
            validate_future_once(triggers_of(task), now)
            prepare_resume(conn, self.automation_store, self.task_store, task, actor)
            return self.task_store.update_task(task_id, {
                "routineState": "active", "routinePauseReason": None,
                "routineNextRunAt": next_run_at(task, now),
            })


def lock_automation_state(conn: Any) -> None:
    """Serialize user automation state changes with scheduler ticks."""
    if conn.dialect.name == "postgresql":
        conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": AUTOMATION_LOCK_KEY})


def prepare_resume(conn: Any, automation_store: Any, task_store: Any, task: dict[str, Any],
                   actor: Actor) -> None:
    """The automation-state side of every resume, run inside the transaction
    that flips ``routineState`` back to ``active``.

    Takes the automation lock so the tick cannot rewrite the state row
    between the reset and the flip. Any resume starts the failure count over
    and drops pending events, so stale events cannot fire the moment it
    turns back on. Resuming what Relay paused also starts a fresh rate
    window; an owner's own pause/resume does not, so the hourly cap cannot be
    bypassed. Records who resumed it, as a pause records why.
    """
    task_id, previous_state = task["id"], state_of(task)
    if previous_state == "active":
        return
    lock_automation_state(conn)
    if previous_state == "paused_by_relay":
        automation_store.reset_rate_window(task_id)
    else:
        automation_store.clear_state(task_id)
        automation_store.reset_failures(task_id)
    task_store.record_activity(task_id, f"Automation resumed by {_resumer(task, actor)}.")


def _resumer(task: dict[str, Any], actor: Actor) -> str:
    """Who resumed, by role: activity names no raw user ids."""
    user = actor.get("userId")
    if user and user == task.get("ownerUserId"):
        return "its owner"
    if actor.get("isAdmin"):
        return "an admin"
    # PATCH lets an assignee edit the automation too.
    return "its assignee"


def automation_service(automation_store: Any, ctx: AppContext) -> AutomationService:
    """The service an API request runs, built from the app's stores."""
    return AutomationService(task_store=ctx.task_store, session_store=ctx.session_store,
                             automation_store=automation_store, project_store=ctx.project_store,
                             max_runs_per_hour=max_runs_per_hour_from_env())


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


def request_manual_occurrence(
    automation_store: Any, ctx: AppContext, task: dict[str, Any], actor: Actor
) -> dict[str, Any] | DispatchResult:
    if not actor["isAdmin"] and task.get("ownerUserId") != actor.get("userId"):
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
    automation_service(automation_store, ctx).tick(datetime.now(UTC))
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
) -> dict[str, Any] | DispatchResult:
    """Answer Run now with the occurrence already in flight. A queued one may
    need waking after its computer comes online; its assignment is immutable
    even if the definition was edited later."""
    if active.get("linkedSessionIds"):
        existing = existing_routine_occurrence_result(ctx, routine, active)
        if existing:
            return existing
    if active.get("status") in ("backlog", "assigned"):
        return active
    return {"task": routine, "session": None, "dispatch": {
        "state": "queued", "code": "automation_running",
        "message": "This automation is already running.",
    }}
