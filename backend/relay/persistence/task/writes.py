"""Creating tasks and appending their events under the per-task write scope.

A mixin of ``DatabaseTaskStore``; it shares the store's engine and tables
(declared on ``TaskStoreState``) and is not used on its own.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from contextlib import contextmanager
from functools import partial
from typing import Any
from loguru import logger
from sqlalchemy import (
    and_,
    delete,
    func,
    insert,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError
from ...core.ids import new_relay_id
from ...notifications.rules import task_notification_rows
from ..automation.store import insert_outbox_rows, task_outbox_rows
from ..notification.store import insert_notification_rows
from .reducer import materialize_task_events
from ...core.ids import new_database_id, now_iso
from ..events import relay_task_event
from ..engine import store_transaction
from .execution import prepare_execution_events
from .numbering import number_task_events
from .lifecycle import flow_scope, needs_wip_admission, wip_limit
from .rules import (
    TaskExecutionActiveError,
    _HYDRATE_TASK_WRITES,
    _TaskWriteConflict,
    apply_task_events,
    dispatch_claim_active,
)
from .events import (
    task_creation_events,
    task_update_events,
    validate_project_move_events,
)
from .rows import (
    compact_task_snapshot,
    task_event_to_row,
    task_to_row,
)
from .state import TaskStoreState


class TaskWriteRows(TaskStoreState):
    @contextmanager
    def task_write_scope(self, task_id: str):
        with store_transaction(self.engine) as conn:
            if self.engine.dialect.name == "sqlite":
                conn.execute(
                    update(self.tasks)
                    .where(self.tasks.c.id == task_id)
                    .values(version=self.tasks.c.version)
                )
            self._task_pk(conn, task_id, lock=True)
            if _HYDRATE_TASK_WRITES.get():
                yield self.get_task(task_id)
            else:
                row = (
                    conn.execute(
                        select(
                            self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version
                        ).where(self.tasks.c.id == task_id)
                    )
                    .mappings()
                    .one()
                )
                yield self._current_snapshot(conn, row)

    def create_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(3):
            try:
                return self._create_task_once(payload)
            except IntegrityError:
                # A concurrent create took this scope's next number.
                if attempt == 2:
                    raise
                time.sleep(0.01 * (attempt + 1))
        raise RuntimeError("unreachable")

    def _next_task_number(self, conn: Any, scope: str) -> int:
        if self.engine.dialect.name == "postgresql":
            conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:scope, 4127730619))"),
                {"scope": scope},
            )
        # A counter, not max(live numbers): a number a task moved away from
        # stays spent.
        number = conn.scalar(
            update(self.number_counters)
            .where(self.number_counters.c.scope == scope)
            .values(last_number=self.number_counters.c.last_number + 1)
            .returning(self.number_counters.c.last_number)
        )
        if number is None:
            number = 1
            conn.execute(
                insert(self.number_counters).values(scope=scope, last_number=number)
            )
        return int(number)

    def _create_task_once(self, payload: dict[str, Any]) -> dict[str, Any]:
        task_id = new_database_id()
        logger.debug(
            "Creating database task", task_id=task_id, title=payload.get("title")
        )
        with store_transaction(self.engine) as conn:
            events = number_task_events(
                task_creation_events(task_id, payload),
                partial(self._next_task_number, conn),
            )
            task = materialize_task_events(events)
            task_row = task_to_row(task, version=len(events))
            conn.execute(insert(self.tasks).values(**task_row))
            for sequence, event in enumerate(events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(task_row["id"], sequence, event)
                    )
                )
            if self.emit_automation_events:
                insert_outbox_rows(conn, task_outbox_rows(None, task))
        return task

    def append_event(self, task_id: str, event: dict[str, Any], *, execution_owner: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.append_events(task_id, [event], execution_owner=execution_owner)

    def append_events(
        self,
        task_id: str,
        events: list[dict[str, Any]],
        *,
        skip_linked_session_id: str | None = None,
        reject_active_claim: bool = False,
        active_linked_session: Callable[[dict[str, Any]], bool] | None = None,
        execution_owner: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        for attempt in range(3):
            try:
                task = self._append_events_once(
                    task_id,
                    events,
                    skip_linked_session_id=skip_linked_session_id,
                    reject_active_claim=reject_active_claim,
                    active_linked_session=active_linked_session,
                    execution_owner=execution_owner,
                )
                return self._hydrate_task(task) if _HYDRATE_TASK_WRITES.get() else task
            except (IntegrityError, _TaskWriteConflict):
                if attempt == 2:
                    raise
                time.sleep(0.01 * (attempt + 1))
        raise RuntimeError("unreachable")

    def _append_events_once(
        self,
        task_id: str,
        events: list[dict[str, Any]],
        *,
        skip_linked_session_id: str | None = None,
        reject_active_claim: bool = False,
        active_linked_session: Callable[[dict[str, Any]], bool] | None = None,
        execution_owner: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            # Acquire SQLite's writer lock before reading. PostgreSQL locks
            # only this row; WIP admission later locks the destination scope.
            if self.engine.dialect.name == "sqlite":
                conn.execute(
                    update(self.tasks)
                    .where(self.tasks.c.id == task_id)
                    .values(version=self.tasks.c.version)
                )
            if skip_linked_session_id:
                self._lock_session_for_link(conn, skip_linked_session_id)
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                    .where(self.tasks.c.id == task_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(task_id)
            task_pk = row["id"]
            sequence = int(row["version"] or 0)
            current = row["snapshot"] or {}
            current = self._current_snapshot(conn, row)
            events = prepare_execution_events(current, events, execution_owner)
            if not events:
                return current
            deleting = any(event.get("type") == "task.deleted" for event in events)
            if deleting and current.get("deletedAt"):
                return current
            if skip_linked_session_id and current.get("deletedAt"):
                return current
            if reject_active_claim and dispatch_claim_active(current):
                raise TaskExecutionActiveError("task_execution_active")
            if active_linked_session and active_linked_session(current):
                raise TaskExecutionActiveError("task_execution_active")
            if skip_linked_session_id and skip_linked_session_id in current.get(
                "linkedSessionIds", []
            ):
                return current
            validate_project_move_events(current, events)
            events = number_task_events(events, partial(self._next_task_number, conn))
            task = apply_task_events(current, events, version=sequence)
            if needs_wip_admission(current, task):
                if self.engine.dialect.name == "postgresql":
                    conn.execute(
                        text(
                            "SELECT pg_advisory_xact_lock(hashtextextended(:scope, 7265193401))"
                        ),
                        {"scope": flow_scope(task)},
                    )
                scope = flow_scope(task)
                scope_filter = (
                    and_(
                        self.tasks.c.assignee_user_id.is_(None),
                        self.tasks.c.owner_user_id.is_(None),
                    )
                    if scope == "unowned"
                    else or_(
                        self.tasks.c.assignee_user_id == scope,
                        and_(
                            self.tasks.c.assignee_user_id.is_(None),
                            self.tasks.c.owner_user_id == scope,
                        ),
                    )
                )
                count = conn.scalar(
                    select(func.count())
                    .select_from(self.tasks)
                    .where(
                        self.tasks.c.id != task_pk,
                        scope_filter,
                        self.tasks.c.status != "done",
                        self.tasks.c.is_routine.is_(False),
                        self.tasks.c.deleted_at.is_(None),
                        or_(
                            self.tasks.c.snapshot["startedAt"].as_string().is_not(None),
                            self.tasks.c.status.in_(
                                ("running", "review", "waiting_for_human")
                            ),
                        ),
                    )
                )
                if count >= wip_limit():
                    raise ValueError(
                        "task_wip_limit: Finish existing work before starting another task."
                    )
            claimed = conn.execute(
                update(self.tasks)
                .where(
                    self.tasks.c.id == task_pk,
                    self.tasks.c.version == sequence,
                )
                .values(
                    **task_to_row(
                        task,
                        version=sequence + len(events),
                        database_id=task_pk,
                    )
                )
            )
            if claimed.rowcount != 1:
                raise _TaskWriteConflict(task_id)
            for offset, event in enumerate(events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(task_pk, sequence + offset, event)
                    )
                )
                if event.get("type") == "task.session_linked":
                    self._ensure_task_session(
                        conn, task_pk, event["sessionId"], event["timestamp"]
                    )
                elif event.get("type") == "task.session_unlinked":
                    conn.execute(
                        delete(self.task_sessions)
                        .where(self.task_sessions.c.task_id == task_pk)
                        .where(self.task_sessions.c.session_id == event["sessionId"])
                    )
            if self.emit_automation_events:
                insert_outbox_rows(conn, task_outbox_rows(current, task))
            insert_notification_rows(conn, task_notification_rows(current, task, events))
        logger.debug(
            "Database task events appended",
            task_id=task_id,
            event_types=[event.get("type") for event in events],
        )
        return task

    def _current_snapshot(self, conn: Any, row: Any) -> dict[str, Any]:
        task_pk = row["id"]
        sequence = int(row["version"] or 0)
        current = row["snapshot"] or {}
        if current.get("eventCount") != sequence:
            current = compact_task_snapshot(
                materialize_task_events(self._events_for_task(conn, task_pk)),
                event_count=sequence,
            )
        # Execution ownership remains an authoritative event fact even if
        # an older writer omitted it from the snapshot.
        owner_event = conn.scalar(
            select(self.events.c.payload)
            .where(
                self.events.c.task_id == task_pk,
                self.events.c.type == "task.execution.claimed",
            )
            .order_by(self.events.c.sequence.desc())
            .limit(1)
        )
        current = dict(current)
        current.pop("executionOwner", None)
        if owner_event:
            current["executionOwner"] = {
                "requestId": owner_event["requestId"],
                "revision": owner_event["revision"],
            }
        return current

    def _hydrate_task(self, task: dict[str, Any]) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            events = list(
                conn.execute(
                    select(self.events.c.payload)
                    .where(
                        self.events.c.task_id == task["id"],
                        self.events.c.sequence < int(task.get("eventCount") or 0),
                    )
                    .order_by(self.events.c.sequence)
                ).scalars()
            )
        return {
            **{
                k: v
                for k, v in task.items()
                if k not in {"eventCount", "activityCount", "lastActivity"}
            },
            "events": events,
            "activity": [e["activity"] for e in events if e["type"] == "task.activity"],
        }

    def delete_task(
        self,
        task_id: str,
        *,
        deleted_by: str | None = None,
        reject_active_claim: bool = False,
        active_linked_session: Callable[[dict[str, Any]], bool] | None = None,
    ) -> dict[str, Any]:
        task = self.get_task(task_id)
        if task.get("deletedAt"):
            return task
        logger.info("Database task deleted", task_id=task_id, deleted_by=deleted_by)
        return self.append_events(
            task_id,
            [
                relay_task_event(
                    "task.deleted",
                    task_id,
                    {"actorUserId": deleted_by} if deleted_by else {},
                )
            ],
            reject_active_claim=reject_active_claim,
            active_linked_session=active_linked_session,
        )

    def update_task(
        self,
        task_id: str,
        payload: dict[str, Any],
        *,
        assignment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.append_events(
            task_id,
            task_update_events(task_id, payload, assignment=assignment),
        )

    def update_task_if_not_dispatching(
        self,
        task_id: str,
        payload: dict[str, Any],
        *,
        assignment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.append_events(
            task_id,
            task_update_events(task_id, payload, assignment=assignment),
            reject_active_claim=True,
        )

    def record_activity(
        self, task_id: str, message: str, payload: dict[str, Any] | None = None,
        *, execution_owner: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        extras = payload or {}
        logger.debug(
            "Database task activity recorded", task_id=task_id, message=message
        )
        return self.append_event(
            task_id,
            relay_task_event(
                "task.activity",
                task_id,
                {
                    "activity": {
                        "id": new_relay_id("act"),
                        "createdAt": now_iso(),
                        "message": message,
                        **({"agent": extras["agent"]} if extras.get("agent") else {}),
                        **(
                            {"sessionId": extras["sessionId"]}
                            if extras.get("sessionId")
                            else {}
                        ),
                    }
                },
            ),
            execution_owner=execution_owner,
        )

    def _events_for_task(self, conn: Any, task_pk: str) -> list[dict[str, Any]]:
        rows = (
            conn.execute(
                select(self.events.c.payload)
                .where(self.events.c.task_id == task_pk)
                .order_by(self.events.c.sequence)
            )
            .mappings()
            .all()
        )
        return [row["payload"] for row in rows]
