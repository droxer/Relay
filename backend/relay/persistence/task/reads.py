"""Reading tasks: one task, lists, per-thread lists, and summaries.

A mixin of ``DatabaseTaskStore``; it shares the store's engine and tables
(declared on ``TaskStoreState``) and is not used on its own.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any
from sqlalchemy import (
    or_,
    select,
)
from .reducer import materialize_task_events
from ..engine import store_transaction
from ..sql import names_no_uuid_row
from .rows import (
    compact_task_summary,
)
from .state import TaskStoreState


class TaskReadRows(TaskStoreState):
    def get_task(self, task_id: str) -> dict[str, Any]:
        if names_no_uuid_row(self.engine, task_id):
            raise KeyError(task_id)
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot).where(
                        self.tasks.c.id == task_id
                    )
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(task_id)
            events = self._events_for_task(conn, row["id"])
            if not events:
                events = list((row["snapshot"] or {}).get("events", []))
            return materialize_task_events(events) if events else row["snapshot"]

    def list_tasks(
        self, *, user_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        statement = (
            select(self.tasks.c.id, self.tasks.c.snapshot)
            .where(self.tasks.c.deleted_at.is_(None))
            .order_by(self.tasks.c.updated_at.desc(), self.tasks.c.id.desc())
        )
        if user_id is not None:
            statement = statement.where(
                or_(
                    self.tasks.c.owner_user_id == user_id,
                    self.tasks.c.assignee_user_id == user_id,
                )
            )
        if limit is not None:
            statement = statement.limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
            histories = defaultdict(list)
            # Use the IDs actually selected above, so concurrent ordering
            # changes cannot substitute a different page between queries.
            ids = [row["id"] for row in rows]
            for offset in range(0, len(ids), 500):
                for row in conn.execute(
                    select(self.events.c.task_id, self.events.c.payload)
                    .where(self.events.c.task_id.in_(ids[offset : offset + 500]))
                    .order_by(self.events.c.task_id, self.events.c.sequence)
                ).mappings():
                    histories[row["task_id"]].append(row["payload"])
        return [
            materialize_task_events(histories[row["id"]])
            if histories[row["id"]]
            else row["snapshot"]
            for row in rows
        ]

    def list_tasks_for_session(self, session_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.tasks.c.snapshot)
                    .join(
                        self.task_sessions,
                        self.task_sessions.c.task_id == self.tasks.c.id,
                    )
                    .where(self.task_sessions.c.session_id == session_id)
                    .order_by(self.tasks.c.id)
                )
                .mappings()
                .all()
            )
            return [
                dict(row["snapshot"])
                for row in rows
                if not row["snapshot"].get("deletedAt")
            ]

    def list_task_summaries(
        self, *, user_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        statement = (
            select(
                self.tasks.c.snapshot.label("summary"),
                self.tasks.c.version,
            )
            .where(self.tasks.c.deleted_at.is_(None))
            # The id tiebreaker keeps a page stable when two tasks share an
            # instant; ``ix_tasks_live_recency`` serves this order directly.
            .order_by(self.tasks.c.updated_at.desc(), self.tasks.c.id.desc())
        )
        if user_id is not None:
            statement = statement.where(
                or_(
                    self.tasks.c.owner_user_id == user_id,
                    self.tasks.c.assignee_user_id == user_id,
                )
            )
        if limit is not None:
            statement = statement.limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [
            {
                **compact_task_summary(
                    row["summary"],
                    event_count=int(row["version"] or 0),
                    activity_count=int(row["summary"].get("activityCount") or 0),
                ),
                **(
                    {"lastActivity": row["summary"]["lastActivity"]}
                    if row["summary"].get("lastActivity")
                    else {}
                ),
            }
            for row in rows
        ]
