"""Durable plumbing for automations: the outbox, per-automation firing state,
and webhook secrets.

Outbox rows are written inside the task or session store's own transaction
(``store_transaction`` joins it), so an event and the automation's record of
it commit together or not at all. Only the database stores write them; the
file stores are test fixtures and run no automations. Routine ids are plain
text, not foreign keys: a row must outlive the routine it names.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, Table, Text, delete, insert, or_, select, update

from .store_common import (
    create_all_tables, database_id_column, json_type, new_database_id, shared_engine, store_transaction,
)
from .store_common import metadata as shared_metadata

STALE_CLAIM = timedelta(minutes=5)
SUBJECT_KEYS = ("id", "title", "status", "priority", "projectId", "assignedAgentId", "assignedTeamId")

automation_outbox = Table(
    "automation_outbox", shared_metadata,
    database_id_column(),
    Column("kind", Text, nullable=False),
    Column("event_type", Text, nullable=False),
    Column("source_type", Text, nullable=True),
    Column("source_id", Text, nullable=True),
    Column("target_routine_id", Text, nullable=True),
    Column("payload", json_type(), nullable=False),
    Column("origin_automation_id", Text, nullable=True),
    Column("depth", Integer, nullable=False, default=0),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("claimed_at", DateTime(timezone=True), nullable=True),
    Index("ix_automation_outbox_claim", "claimed_at", "created_at"),
)

automation_state = Table(
    "automation_state", shared_metadata,
    Column("routine_id", Text, primary_key=True),
    Column("pending", Boolean, nullable=False, default=False),
    Column("pending_events", json_type(), nullable=False),
    Column("pending_dropped", Integer, nullable=False, default=0),
    Column("pending_since", DateTime(timezone=True), nullable=True),
    Column("fired_window_start", DateTime(timezone=True), nullable=True),
    Column("fired_count", Integer, nullable=False, default=0),
    Index("ix_automation_state_pending", "pending"),
)

automation_webhook_secrets = Table(
    "automation_webhook_secrets", shared_metadata,
    Column("routine_id", Text, primary_key=True),
    Column("secret_hash", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)


def subject_of(task: dict[str, Any]) -> dict[str, Any]:
    return {key: task[key] for key in SUBJECT_KEYS if task.get(key) is not None}


def _row(kind: str, event_type: str, **fields: Any) -> dict[str, Any]:
    return {"kind": kind, "event_type": event_type, "payload": {}, "depth": 0, **fields}


def task_outbox_rows(before: dict[str, Any] | None, after: dict[str, Any]) -> list[dict[str, Any]]:
    """Rows a task write produces. Routine definitions never fire triggers;
    occurrences fire only status changes, stamped with where they came from."""
    if after.get("isRoutine") or after.get("deletedAt"):
        return []
    origin = after.get("sourceRoutineId")
    provenance = {
        "source_type": "task", "source_id": after["id"], "origin_automation_id": origin,
        "depth": int(after.get("routineTriggerDepth") or 0) + 1 if origin else 0,
    }
    if before is None:
        if origin:
            return []
        return [_row("task_event", "task.created", payload={"subject": subject_of(after)}, **provenance)]
    if before.get("status") == after.get("status"):
        return []
    payload = {"subject": subject_of(after), "from": before.get("status"), "to": after.get("status")}
    return [_row("task_event", "task.status_changed", payload=payload, **provenance)]


def session_outbox_rows(session_id: str, event: dict[str, Any]) -> list[dict[str, Any]]:
    if event.get("type") != "agent.completed" or event.get("status") not in ("completed", "failed"):
        return []
    payload = {"sessionId": session_id, "runId": event.get("runId"), "agent": event.get("agent")}
    if event["status"] == "failed" and event.get("error"):
        payload["error"] = str(event["error"])[:500]
    return [_row("run_event", f"run.{event['status']}", source_type="session", source_id=session_id, payload=payload)]


def insert_outbox_rows(conn: Any, rows: list[dict[str, Any]]) -> None:
    now = datetime.now(timezone.utc)
    for row in rows:
        conn.execute(insert(automation_outbox).values(id=new_database_id(), created_at=now, claimed_at=None, **row))


def _empty_state(routine_id: str) -> dict[str, Any]:
    return {"routine_id": routine_id, "pending": False, "pending_events": [], "pending_dropped": 0,
            "pending_since": None, "fired_window_start": None, "fired_count": 0}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class DatabaseAutomationStore:
    def __init__(self, database_url: str, *, create_schema: bool = False) -> None:
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def enqueue_webhook(self, routine_id: str, payload: Any) -> None:
        row = _row("webhook", "webhook", target_routine_id=routine_id, payload={"body": payload})
        with store_transaction(self.engine) as conn:
            insert_outbox_rows(conn, [row])

    def claim_outbox(self, limit: int, now: datetime) -> list[dict[str, Any]]:
        claimable = or_(automation_outbox.c.claimed_at.is_(None), automation_outbox.c.claimed_at < now - STALE_CLAIM)
        claimed: list[dict[str, Any]] = []
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(automation_outbox).where(claimable).order_by(automation_outbox.c.created_at).limit(limit)
            ).mappings().all()
            for row in rows:
                won = conn.execute(
                    update(automation_outbox).where(automation_outbox.c.id == row["id"], claimable).values(claimed_at=now)
                ).rowcount == 1
                if won:
                    claimed.append({key: row[key] for key in row.keys() if key != "claimed_at"})
        return claimed

    def delete_outbox(self, ids: list[str]) -> None:
        if ids:
            with store_transaction(self.engine) as conn:
                conn.execute(delete(automation_outbox).where(automation_outbox.c.id.in_(ids)))

    def prune_outbox(self, before: datetime) -> int:
        with store_transaction(self.engine) as conn:
            return conn.execute(delete(automation_outbox).where(automation_outbox.c.created_at < before)).rowcount

    def get_state(self, routine_id: str) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            row = conn.execute(
                select(automation_state).where(automation_state.c.routine_id == routine_id)
            ).mappings().first()
        return dict(row) if row else _empty_state(routine_id)

    def save_state(self, routine_id: str, state: dict[str, Any]) -> None:
        values = {key: value for key, value in state.items() if key != "routine_id"}
        with store_transaction(self.engine) as conn:
            updated = conn.execute(
                update(automation_state).where(automation_state.c.routine_id == routine_id).values(**values)
            )
            if updated.rowcount == 0:
                conn.execute(insert(automation_state).values(routine_id=routine_id, **values))

    def clear_state(self, routine_id: str) -> None:
        """Forget pending events but keep the rate window: a fired automation
        still counts toward its hourly cap."""
        current = self.get_state(routine_id)
        self.save_state(routine_id, {**_empty_state(routine_id),
                                     "fired_window_start": current["fired_window_start"],
                                     "fired_count": current["fired_count"]})

    def list_pending_states(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(automation_state).where(automation_state.c.pending.is_(True))).mappings().all()
        return [dict(row) for row in rows]

    def set_webhook_secret(self, routine_id: str) -> str:
        token = secrets.token_urlsafe(32)
        with store_transaction(self.engine) as conn:
            conn.execute(delete(automation_webhook_secrets).where(automation_webhook_secrets.c.routine_id == routine_id))
            conn.execute(insert(automation_webhook_secrets).values(
                routine_id=routine_id, secret_hash=_hash(token), created_at=datetime.now(timezone.utc)))
        return token

    def verify_webhook_secret(self, routine_id: str, token: str) -> bool:
        with store_transaction(self.engine) as conn:
            stored = conn.scalar(select(automation_webhook_secrets.c.secret_hash)
                                 .where(automation_webhook_secrets.c.routine_id == routine_id))
        return bool(stored) and hmac.compare_digest(stored, _hash(token))

    def has_webhook_secret(self, routine_id: str) -> bool:
        with store_transaction(self.engine) as conn:
            found = conn.scalar(select(automation_webhook_secrets.c.routine_id)
                                .where(automation_webhook_secrets.c.routine_id == routine_id))
        return found is not None

    def delete_webhook_secret(self, routine_id: str) -> None:
        with store_transaction(self.engine) as conn:
            conn.execute(delete(automation_webhook_secrets).where(automation_webhook_secrets.c.routine_id == routine_id))
