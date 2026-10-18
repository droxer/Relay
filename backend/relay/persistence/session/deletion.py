"""Deleting threads: tombstones, pending deletions, and task unlinks.

A mixin of ``DatabaseSessionStore``; it shares the store's engine and tables
(declared on ``SessionStoreState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from sqlalchemy import (
    delete,
    insert,
    select,
)
from ..artifact_blobs import (
    delete_session_blobs,
)
from ..store_common import (
    _parse_iso,
    after_store_commit,
    new_database_id,
    now_iso,
    store_transaction,
)
from ..sql import metadata as shared_metadata
from ..tables.daemon import ACTIVE_RUN_REQUEST_STATUSES
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
                deleted_at=_parse_iso(now_iso()),
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
            requests = shared_metadata.tables.get("daemon_run_requests")
            if requests is not None and conn.execute(
                select(requests.c.id).where(requests.c.session_id == session_id)
                .where(requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES)).limit(1)
            ).first():
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
                        delete_orphan=True, deleted_by=deleted_by,
                    )
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

    def list_pending_deletions(self, *, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(self.sessions.c.snapshot)
                .where(self.sessions.c.deletion_requested_at.is_not(None))
                .order_by(self.sessions.c.updated_at, self.sessions.c.id).offset(offset).limit(limit)
            ).scalars().all()
        return list(rows)
