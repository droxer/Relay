"""Turn outbox rows into automation runs.

Each scheduler tick drains the outbox, matches every row against the
enabled event and webhook automations, and parks matches as pending state
per automation. It then fires at most one occurrence per pending automation:
events that arrive while a run is in flight collapse into the next run's
Trigger context instead of each starting their own.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

from loguru import logger
from sqlalchemy import text

from ..persistence.automation_store import AUTOMATION_LOCK_KEY, subject_of
from ..persistence.store_common import store_transaction
from ..tasks import next_routine_date
from .trigger import TriggerError, event_matches, normalize_trigger, trigger_context_block, trigger_kind, trigger_of

MAX_AUTOMATION_DEPTH = 3
MAX_PENDING_EVENTS = 20
PENDING_TTL = timedelta(hours=24)
OUTBOX_RETENTION = timedelta(days=7)
RATE_WINDOW = timedelta(hours=1)
IN_FLIGHT_STATUSES = frozenset({"backlog", "assigned", "running"})
RATE_LIMITED = "rate_limited"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


class AutomationMatcher:
    def __init__(
        self,
        *,
        task_store: Any,
        session_store: Any,
        automation_store: Any,
        now: Callable[[], datetime] = _utcnow,
        today: Callable[[], date] = date.today,
        max_depth: int = MAX_AUTOMATION_DEPTH,
        max_runs_per_hour: int = 6,
        batch: int = 200,
    ) -> None:
        self.task_store = task_store
        self.session_store = session_store
        self.automation_store = automation_store
        self._now = now
        self._today = today
        self.max_depth = max_depth
        self.max_runs_per_hour = max_runs_per_hour
        self.batch = batch

    def run(self) -> int:
        now = self._now()
        # A failed tick must not lose outbox events or leave a partially fired run.
        with store_transaction(self.automation_store.engine) as conn:
            # Claims partition outbox rows, but pending states are shared across
            # ticks. One database-wide transaction lock prevents two replicas
            # firing the same pending state; a busy replica leaves it for later.
            if conn.dialect.name == "postgresql" and not conn.scalar(
                text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": AUTOMATION_LOCK_KEY}
            ):
                return 0
            self._drain(now)
            return self._fire(now)

    # -- draining ---------------------------------------------------------

    def _drain(self, now: datetime) -> None:
        rows = self.automation_store.claim_outbox(self.batch, now)
        if rows:
            automations = {task["id"]: task for task in self.task_store.list_trigger_automations()}
            for row in rows:
                event = self._enrich(row)
                if event is None:
                    continue
                for automation in self._targets(row, event, automations):
                    if self._is_loop(automation, event):
                        logger.info("Automation event dropped as a loop", routine_id=automation["id"],
                                    event_type=event["eventType"], depth=event["depth"])
                        continue
                    self._mark_pending(automation["id"], event, now)
            self.automation_store.delete_outbox([row["id"] for row in rows])
        self.automation_store.prune_outbox(now - OUTBOX_RETENTION)

    def _targets(self, row: dict[str, Any], event: dict[str, Any],
                 automations: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        target_id = row.get("target_routine_id")
        if target_id:
            target = self._load(target_id)
            if not target or not target.get("routineEnabled"):
                return []
            if row["kind"] == "manual":
                return [target]
            return [target] if trigger_kind(target) == "webhook" else []
        matched = []
        for task in automations.values():
            owner = task.get("ownerEmployeeId")
            subject = event.get("subject") or {}
            if owner and owner not in (subject.get("ownerEmployeeId"), subject.get("assigneeEmployeeId")):
                continue
            try:
                trigger = normalize_trigger(trigger_of(task))
            except TriggerError as error:
                logger.warning("Invalid stored automation trigger", routine_id=task["id"], error=str(error))
                continue
            if event_matches(trigger, event):
                matched.append(task)
        return matched

    def _is_loop(self, automation: dict[str, Any], event: dict[str, Any]) -> bool:
        return event.get("originAutomationId") == automation["id"] or event["depth"] > self.max_depth

    def _enrich(self, row: dict[str, Any]) -> dict[str, Any] | None:
        payload = row.get("payload") or {}
        if row["kind"] == "manual":
            return {"eventType": "manual", "depth": 0}
        if row["kind"] == "webhook":
            return {"eventType": "webhook", "payload": payload.get("body"), "depth": 0}
        if row["kind"] == "task_event":
            return {"eventType": row["event_type"], "subject": payload.get("subject") or {},
                    "fromStatus": payload.get("from"), "toStatus": payload.get("to"),
                    "originAutomationId": row.get("origin_automation_id"), "depth": int(row.get("depth") or 0)}
        return self._enrich_run(row, payload)

    def _enrich_run(self, row: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any] | None:
        session_id = row.get("source_id") or payload.get("sessionId")
        try:
            session = self.session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            return None
        run = next((item for item in session.get("agentRuns", []) if item.get("id") == payload.get("runId")), {})
        linked = [task for task in self.task_store.list_tasks_for_session(session_id) if not task.get("isRoutine")]
        task = linked[0] if linked else None
        subject = subject_of(task) if task else {"projectId": session.get("projectId"), "ownerEmployeeId": session.get("ownerEmployeeId")}
        if not subject.get("assignedAgentId") and run.get("logicalAgentId"):
            subject = {**subject, "assignedAgentId": run["logicalAgentId"]}
        origin = task.get("sourceRoutineId") if task else None
        depth = int(task.get("routineTriggerDepth") or 0) + 1 if origin else 0
        return {"eventType": row["event_type"], "subject": subject, "sessionId": session_id,
                "error": payload.get("error"), "originAutomationId": origin, "depth": depth}

    def _mark_pending(self, routine_id: str, event: dict[str, Any], now: datetime) -> None:
        state = self.automation_store.get_state(routine_id)
        events = list(state["pending_events"])
        dropped = int(state["pending_dropped"])
        if len(events) < MAX_PENDING_EVENTS:
            events = [*events, event]
        else:
            dropped += 1
        self.automation_store.save_state(routine_id, {
            **state, "pending": True, "pending_events": events, "pending_dropped": dropped,
            "pending_since": state["pending_since"] or now,
        })

    # -- firing -----------------------------------------------------------

    def _fire(self, now: datetime) -> int:
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
        if self._in_flight(routine):
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
            depth=0 if manual else max(int(event.get("depth") or 0) for event in events),
            context=trigger_context_block(events, int(state["pending_dropped"])),
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

    def _in_flight(self, routine: dict[str, Any]) -> bool:
        for occurrence_id in reversed((routine.get("occurrenceIds") or [])):
            occurrence = self._load_any(occurrence_id)
            if occurrence and not occurrence.get("deletedAt") and occurrence.get("status") in IN_FLIGHT_STATUSES:
                return True
        return False

    def _load_any(self, task_id: str) -> dict[str, Any] | None:
        try:
            return self.task_store.get_task(task_id)
        except (KeyError, FileNotFoundError):
            return None
