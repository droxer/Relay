"""Turn outbox rows into pending automation events.

Each tick drains the outbox, matches every row against the active event and
webhook automations, and parks matches as pending state per automation.
Firing (``firing.py``) then starts at most one occurrence per pending
automation: events that arrive while a run is in flight collapse into the
next run's Trigger context instead of each starting their own.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from loguru import logger

from ..persistence.automation_store import subject_of
from .model import EVENT_KINDS, event_matches, has_webhook, is_active, triggers_of

MAX_AUTOMATION_DEPTH = 3
OUTBOX_RETENTION = timedelta(days=7)


class AutomationMatcher:
    def __init__(
        self,
        *,
        task_store: Any,
        session_store: Any,
        automation_store: Any,
        firing: Any = None,
        max_depth: int = MAX_AUTOMATION_DEPTH,
        batch: int = 200,
    ) -> None:
        self.task_store = task_store
        self.session_store = session_store
        self.automation_store = automation_store
        # The ``AutomationFiring`` that counts occurrence outcomes and pauses
        # an automation whose runs keep failing.
        self.firing = firing
        self.max_depth = max_depth
        self.batch = batch

    def drain(self, now: datetime) -> None:
        """Match one batch of outbox rows. Run inside the tick's transaction
        so a failed tick loses no outbox events."""
        rows = self.automation_store.claim_outbox(self.batch, now)
        if rows:
            automations = {task["id"]: task for task in self.task_store.list_trigger_automations()}
            for row in rows:
                event = self._enrich(row)
                if event is None:
                    continue
                self._record_outcome(row, event)
                for automation in self._targets(row, event, automations):
                    if self._is_loop(automation, event):
                        logger.info("Automation event dropped as a loop", routine_id=automation["id"],
                                    event_type=event["eventType"], depth=event["depth"])
                        continue
                    self.automation_store.mark_pending(automation["id"], event, now)
            self.automation_store.delete_outbox([row["id"] for row in rows])
        self.automation_store.prune_outbox(now - OUTBOX_RETENTION)

    def _record_outcome(self, row: dict[str, Any], event: dict[str, Any]) -> None:
        """A finished run of an automation's own occurrence feeds its failure
        streak. Only completed and failed runs reach the outbox, so a human
        cancel neither counts nor resets."""
        origin = event.get("originAutomationId")
        if row["kind"] == "run_event" and origin and self.firing is not None:
            self.firing.record_outcome(origin, failed=row["event_type"] == "run.failed")

    def _targets(self, row: dict[str, Any], event: dict[str, Any],
                 automations: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        target_id = row.get("target_routine_id")
        if target_id:
            target = self._load(target_id)
            if not target:
                return []
            if row["kind"] == "manual":
                # Run now speaks for itself, even on a paused automation — but not
                # when Relay paused it for runaway volume.
                return [] if target.get("routinePauseReason") == "rate_limited" else [target]
            return [target] if is_active(target) and has_webhook(target) else []
        matched = []
        for task in automations.values():
            owner = task.get("ownerEmployeeId")
            subject = event.get("subject") or {}
            if owner and owner not in (subject.get("ownerEmployeeId"), subject.get("assigneeEmployeeId")):
                continue
            if listens_for(task, event):
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

    def _load(self, task_id: str) -> dict[str, Any] | None:
        try:
            task = self.task_store.get_task(task_id)
        except (KeyError, FileNotFoundError):
            return None
        return None if task.get("deletedAt") or not task.get("isRoutine") else task


def listens_for(task: dict[str, Any], event: dict[str, Any]) -> bool:
    """Whether any of the task's event triggers matches; duplicates match
    once. A stored trigger that no longer evaluates counts as no match, so
    one bad trigger silences neither its siblings nor other automations."""
    for index, trigger in enumerate(triggers_of(task)):
        if trigger.get("kind") not in EVENT_KINDS:
            continue
        try:
            if event_matches(trigger, event):
                return True
        except (AttributeError, TypeError) as error:
            logger.warning("Invalid stored automation trigger", routine_id=task.get("id"),
                           trigger_index=index, error=str(error))
    return False
