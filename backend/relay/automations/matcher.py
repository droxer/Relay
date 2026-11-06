"""Turn outbox rows into pending automation events.

Each tick drains the outbox, matches every row against the active event and
webhook automations, and parks matches as pending state per automation.
Firing (``firing.py``) then starts at most one occurrence per pending
automation: events that arrive while a run is in flight collapse into the
next run's Trigger context instead of each starting their own.
"""

from __future__ import annotations

from datetime import datetime, timedelta, UTC
from dataclasses import dataclass
from typing import Any

from loguru import logger
from sqlalchemy import insert, text

from ..persistence.automation.store import AUTOMATION_LOCK_KEY, automation_outbox, subject_of
from ..core.ids import new_database_id
from ..persistence.engine import store_transaction
from .model import EVENT_KINDS, event_matches, has_webhook, is_active, triggers_of

MAX_AUTOMATION_DEPTH = 3
OUTBOX_RETENTION = timedelta(days=7)

# An outcome has no trigger event; ordinary rows carry their enriched event.
Delivery = tuple[dict[str, Any], dict[str, Any] | None]
Deliveries = dict[str, list[Delivery]]


@dataclass(frozen=True)
class PreparedBatch:
    rows: list[dict[str, Any]]
    deliveries: Deliveries
    continuing_ids: list[str]


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

    def prepare(self, now: datetime) -> PreparedBatch:
        """Claim bounded work; persist broadcast progress with its deliveries.

        The caller keeps prepare, deliver, and finish in one automation-locked
        transaction. Targeted rows never read the catalog. Broadcasts share a
        per-tick projection budget and resume at their committed keyset cursor.
        """
        rows = self.automation_store.claim_outbox(self.batch, now)
        deliveries: Deliveries = {}
        continuing: list[str] = []
        remaining = self.batch
        for row in rows:
            if row["kind"] == "occurrence_outcome":
                origin = row.get("origin_automation_id")
                if origin:
                    deliveries.setdefault(origin, []).append((row, None))
                continue
            event = self._enrich(row)
            if event is None:
                continue
            automations = {}
            if not row.get("target_routine_id"):
                if remaining == 0:
                    continuing.append(row["id"])
                    continue
                before = row.get("routing_before") or datetime.now(UTC)
                page = self.automation_store.routing_page(
                    limit=remaining,
                    before=before,
                    after_created_at=row.get("routing_after_created_at"),
                    after_id=row.get("routing_after_id"),
                )
                if len(page) == remaining:
                    self.automation_store.advance_routing(row["id"], before, page[-1])
                    continuing.append(row["id"])
                remaining -= len(page)
                automations = {task["id"]: task for task in page}
            for automation in self._targets(row, event, automations):
                if self._is_loop(automation, event):
                    logger.info(
                        "Automation event dropped as a loop",
                        routine_id=automation["id"],
                        event_type=event["eventType"],
                        depth=event["depth"],
                    )
                    continue
                deliveries.setdefault(automation["id"], []).append((row, event))
        return PreparedBatch(rows, deliveries, continuing)

    def deliver(self, routine_id: str, deliveries: list[Delivery], now: datetime) -> None:
        """Apply one recipient's rows inside its schedule/firing savepoint."""
        cutoff = self.automation_store.get_state(routine_id)["events_after"]
        if cutoff is not None and cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=UTC)
        for row, event in deliveries:
            if event is None:
                self._record_outcome(row)
                continue
            # An earlier outcome may have paused this recipient. Recheck the
            # current definition before parking the following event.
            routine = self._load(routine_id)
            created = row.get("created_at")
            if cutoff is not None and created is not None:
                # SQLite returns naive database timestamps; both values are UTC.
                created = created if created.tzinfo else created.replace(tzinfo=UTC)
                if created <= cutoff:
                    continue
            if routine and self._targets({**row, "target_routine_id": routine_id}, event, {routine_id: routine}):
                self.automation_store.mark_pending(routine_id, event, now)

    def finish(self, batch: PreparedBatch, failed: Deliveries, now: datetime) -> None:
        """Replace broadcast rows by retries for only their failed recipients.

        The outer transaction atomically deletes the claimed originals and
        inserts these retries. Original timestamps and provenance survive,
        so retries cannot extend retention or redeliver to healthy recipients.
        """
        with store_transaction(self.automation_store.engine) as conn:
            for routine_id, deliveries in failed.items():
                for row, _ in deliveries:
                    values = {
                        key: value
                        for key, value in row.items()
                        if key
                        not in (
                            "id",
                            "target_routine_id",
                            "claimed_at",
                            "routing_before",
                            "routing_after_created_at",
                            "routing_after_id",
                            "routed_at",
                        )
                    }
                    conn.execute(
                        insert(automation_outbox).values(
                            **values,
                            id=new_database_id(),
                            claimed_at=None,
                            target_routine_id=routine_id,
                        )
                    )
            self.automation_store.delete_outbox(
                [row["id"] for row in batch.rows if row["id"] not in batch.continuing_ids]
            )
            self.automation_store.release_outbox(batch.continuing_ids)
            self.automation_store.prune_outbox(now - OUTBOX_RETENTION, limit=self.batch)

    def drain(self, now: datetime) -> None:
        """Match a batch without firing (also used by pending-state tooling)."""
        with store_transaction(self.automation_store.engine) as conn:
            if conn.dialect.name == "postgresql":
                conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": AUTOMATION_LOCK_KEY})
            elif not conn.connection.driver_connection.in_transaction:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            batch = self.prepare(now)
            for routine_id, events in batch.deliveries.items():
                self.deliver(routine_id, events, now)
            self.finish(batch, {}, now)

    def _record_outcome(self, row: dict[str, Any]) -> None:
        """An automation's own occurrence reaching a verdict feeds its failure
        streak, once per occurrence (see ``occurrence_outcome``): ``done``
        resets it and a terminal failure extends it. Agent runs inside an
        occurrence never count: a round may fail a run and still succeed."""
        origin = row.get("origin_automation_id")
        occurrence_id = (row.get("payload") or {}).get("occurrenceId") or row.get("source_id")
        if origin and occurrence_id and self.firing is not None:
            self.firing.record_outcome(origin, occurrence_id, failed=row["event_type"] == "occurrence.failed")

    def _targets(
        self, row: dict[str, Any], event: dict[str, Any], automations: dict[str, dict[str, Any]]
    ) -> list[dict[str, Any]]:
        target_id = row.get("target_routine_id")
        if target_id:
            target = self._load(target_id)
            if not target:
                return []
            if row["kind"] == "manual":
                # Run now speaks for itself, even on a paused automation — but not
                # when Relay paused it for runaway volume.
                return [] if target.get("routinePauseReason") == "rate_limited" else [target]
            if row["kind"] == "webhook":
                return [target] if is_active(target) and has_webhook(target) else []
            # A targeted event row is a retry of a broadcast delivery. Apply
            # the same state, ownership, and current trigger checks again.
            automations = {target_id: target} if is_active(target) else {}
        matched = []
        for task in automations.values():
            owner = task.get("ownerUserId")
            subject = event.get("subject") or {}
            if owner and owner not in (subject.get("ownerUserId"), subject.get("assigneeUserId")):
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
            return {
                "eventType": row["event_type"],
                "subject": payload.get("subject") or {},
                "fromStatus": payload.get("from"),
                "toStatus": payload.get("to"),
                "originAutomationId": row.get("origin_automation_id"),
                "depth": int(row.get("depth") or 0),
            }
        return self._enrich_run(row, payload)

    def _enrich_run(self, row: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any] | None:
        session_id = row.get("source_id") or payload.get("sessionId")
        if "subject" in payload:
            return {
                "eventType": row["event_type"],
                "subject": payload["subject"],
                "sessionId": session_id,
                "error": payload.get("error"),
                "originAutomationId": row.get("origin_automation_id"),
                "depth": int(row.get("depth") or 0),
            }
        # Compatibility with undrained rows written before completion snapshots.
        try:
            session = self.session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            return None
        run: dict[str, Any] = next(
            (item for item in session.get("agentRuns", []) if item.get("id") == payload.get("runId")), {}
        )
        linked = [task for task in self.task_store.list_tasks_for_session(session_id) if not task.get("isRoutine")]
        task = linked[0] if linked else None
        subject = (
            subject_of(task)
            if task
            else {"projectId": session.get("projectId"), "ownerUserId": session.get("ownerUserId")}
        )
        if not subject.get("assignedAgentId") and run.get("logicalAgentId"):
            subject = {**subject, "assignedAgentId": run["logicalAgentId"]}
        origin = task.get("sourceRoutineId") if task else None
        depth = int(task.get("routineTriggerDepth") or 0) + 1 if task and origin else 0
        return {
            "eventType": row["event_type"],
            "subject": subject,
            "sessionId": session_id,
            "error": payload.get("error"),
            "originAutomationId": origin,
            "depth": depth,
        }

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
            logger.warning(
                "Invalid stored automation trigger", routine_id=task.get("id"), trigger_index=index, error=str(error)
            )
    return False
