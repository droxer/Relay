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
from .firing import AutomationFiring
from .model import TriggerError, event_matches, normalize_trigger, trigger_kind, trigger_of

MAX_AUTOMATION_DEPTH = 3
MAX_PENDING_EVENTS = 20
OUTBOX_RETENTION = timedelta(days=7)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


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
        self.batch = batch
        self.firing = AutomationFiring(
            task_store=task_store,
            automation_store=automation_store,
            today=today,
            max_runs_per_hour=max_runs_per_hour,
        )

    @property
    def max_runs_per_hour(self) -> int:
        return self.firing.max_runs_per_hour

    @max_runs_per_hour.setter
    def max_runs_per_hour(self, value: int) -> None:
        self.firing.max_runs_per_hour = value

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
            return self.firing.fire(now)

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

    def _load(self, task_id: str) -> dict[str, Any] | None:
        try:
            task = self.task_store.get_task(task_id)
        except (KeyError, FileNotFoundError):
            return None
        return None if task.get("deletedAt") or not task.get("isRoutine") else task
