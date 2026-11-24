"""Deleting threads: tombstones, pending deletions, and task unlinks.

A mixin of ``DatabaseSessionStore``; it shares the store's engine and tables
(declared on ``SessionStoreState``) and is not used on its own.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from functools import partial
from sqlalchemy import (
    delete,
    insert,
    select,
    tuple_,
)
from .artifact_blobs import delete_session_blobs
from ..db_time import parse_db_time
from ..engine import after_store_commit, store_transaction
from ...core.ids import new_database_id, now_iso
from ..tables.attachments import attachments
from ..tables.daemon import active_run_request, run_requests
from .state import SessionStoreState


class SessionDeletionRows(SessionStoreState):
    def delete_session(self, session_id: str, *, deleted_by: str | None = None) -> None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.sessions.c.id, self.sessions.c.snapshot)
                    .where(self.sessions.c.id == session_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(session_id)
            session_pk = row["id"]
            self._schedule_attachment_cleanup(conn, session_pk)
            self._insert_tombstone(conn, session_pk, row["snapshot"] or {}, deleted_by)
            conn.execute(
                delete(self.artifacts).where(self.artifacts.c.session_id == session_pk)
            )
            conn.execute(
                delete(self.events).where(self.events.c.session_id == session_pk)
            )
            conn.execute(delete(self.sessions).where(self.sessions.c.id == session_pk))
            after_store_commit(
                self.engine, lambda: delete_session_blobs(self.blob_store, session_id)
            )

    def _insert_tombstone(
        self,
        conn: Any,
        session_pk: str,
        snapshot: dict[str, Any],
        deleted_by: str | None,
    ) -> None:
        conn.execute(
            delete(self.tombstones).where(self.tombstones.c.session_id == session_pk)
        )
        conn.execute(
            insert(self.tombstones).values(
                id=new_database_id(),
                session_id=session_pk,
                task_goal=snapshot.get("taskGoal") or "",
                title=snapshot.get("title"),
                owner_user_id=snapshot.get("ownerUserId"),
                deleted_by=deleted_by,
                deleted_at=parse_db_time(now_iso()),
            )
        )

    def delete_session_with_task_unlinks(
        self, session_id: str, task_store: Any, *, deleted_by: str | None = None
    ) -> bool:
        if str(self.engine.url) != str(task_store.engine.url):
            raise RuntimeError("Session and task stores must use the same database.")
        with store_transaction(self.engine) as conn:
            session_row = (
                conn.execute(
                    select(self.sessions.c.id, self.sessions.c.snapshot)
                    .where(self.sessions.c.id == session_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not session_row:
                raise KeyError(session_id)
            snapshot = session_row["snapshot"] or {}
            # Admission locks this same session row before reserving a run.
            # Inspect durable requests inside this transaction, not only in the
            # HTTP handler's replica-local dispatch lock.
            if conn.scalar(select(run_requests.c.id).where(
                run_requests.c.session_id == session_id, active_run_request,
            ).limit(1)) is not None:
                return False
            if snapshot.get("status") != "cancelled" and any(
                run.get("status") == "running" for run in snapshot.get("agentRuns", [])
            ):
                return False
            session_pk = session_row["id"]
            tasks = (
                conn.execute(
                    select(
                        task_store.tasks.c.id,
                        task_store.tasks.c.snapshot,
                    )
                    .select_from(
                        task_store.tasks.join(
                            task_store.task_sessions,
                            task_store.task_sessions.c.task_id == task_store.tasks.c.id,
                        )
                    )
                    .where(task_store.task_sessions.c.session_id == session_id)
                    .with_for_update(of=task_store.tasks)
                )
                .mappings()
                .all()
            )
            for task in tasks:
                if session_id in (task["snapshot"] or {}).get("linkedSessionIds", []):
                    task_store.unlink_session_in_transaction(
                        conn, task["id"], session_id,
                    )
            self._schedule_attachment_cleanup(conn, session_pk)
            self._insert_tombstone(conn, session_pk, snapshot, deleted_by)
            conn.execute(
                delete(self.artifacts).where(self.artifacts.c.session_id == session_pk)
            )
            conn.execute(
                delete(self.events).where(self.events.c.session_id == session_pk)
            )
            conn.execute(delete(self.sessions).where(self.sessions.c.id == session_pk))
            after_store_commit(
                self.engine, lambda: delete_session_blobs(self.blob_store, session_id)
            )
        return True

    def list_pending_deletion_ids(
        self, *, limit: int = 100, after: tuple[datetime, str] | None = None,
    ) -> list[tuple[datetime, str]]:
        sessions = self.sessions
        position = tuple_(sessions.c.updated_at, sessions.c.id)
        statement = select(sessions.c.updated_at, sessions.c.id).where(sessions.c.deletion_requested_at.is_not(None))
        if after is not None:
            statement = statement.where(position > after)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement.order_by(sessions.c.updated_at, sessions.c.id).limit(limit))
            return [(updated_at, session_id) for updated_at, session_id in rows]

    def _schedule_attachment_cleanup(self, conn: Any, session_id: str) -> None:
        keys = list(conn.execute(select(attachments.c.blob_key).where(
            attachments.c.session_id == session_id, attachments.c.blob_key.is_not(None)
        )).scalars())
        conn.execute(delete(attachments).where(attachments.c.session_id == session_id))
        for key in keys:
            after_store_commit(self.engine, partial(self._delete_attachment_blob, key))
