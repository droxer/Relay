"""Durable pending workspace-artifact indexing and the worker's claim/status operations.

A mixin of ``DatabaseSessionStore``; it shares the store's engine and tables
(declared on ``SessionStoreState``) and is not used on its own.

A completed run enqueues its reported generated files here instead of indexing
each one inside the ``run.completed`` HTTP request. Each batch holds at most
``ARTIFACT_INDEX_BATCH_LIMIT`` items and carries the snapshot bytes inline, so
the background indexer can upload and index them without the report or a
daemon filesystem. Enqueue is idempotent per ``(session_id, run_id, sequence)``
so a receipt replay or a finalization retry never enqueues twice.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import (
    and_,
    func,
    insert,
    or_,
    select,
    update,
)

from ..db_time import require_db_time
from ..engine import store_transaction
from ...core.ids import new_database_id, now_iso
from .state import SessionStoreState


# Explicit worker claim size. Reports larger than this remain durable as
# additional batches; enqueue still joins the single completion transaction.
ARTIFACT_INDEX_BATCH_LIMIT = 200

_PENDING = "pending"
_INDEXING = "indexing"
_INDEXED = "indexed"
_FAILED = "failed"


def _db_now() -> datetime:
    return require_db_time(now_iso())


class SessionArtifactIndexingRows(SessionStoreState):
    def enqueue_workspace_artifacts(
        self,
        session_id: str,
        run_id: str,
        agent_id: str | None,
        items: list[dict[str, Any]],
    ) -> int:
        """Persist pending indexing batches for a run, idempotently.

        ``items`` are artifact dicts (already carrying a pre-minted ``id``,
        ``agentRunId``, ``workspaceRelativePath``, …) plus ``contentBase64`` for
        the snapshot bytes. They are split into batches of
        ``ARTIFACT_INDEX_BATCH_LIMIT``; overflow beyond the first batch stays
        queued as additional batches and is recorded as ``overflow_count`` on
        the first batch. Returns the number of new batch rows inserted (0 when
        a replay already enqueued this run's batches).
        """
        if not items:
            return 0
        batches = [
            items[index : index + ARTIFACT_INDEX_BATCH_LIMIT]
            for index in range(0, len(items), ARTIFACT_INDEX_BATCH_LIMIT)
        ]
        overflow_count = max(0, len(items) - ARTIFACT_INDEX_BATCH_LIMIT)
        inserted = 0
        with store_transaction(self.engine) as conn:
            session_pk = self._session_pk(conn, session_id)
            now = _db_now()
            for sequence, batch_items in enumerate(batches):
                exists = conn.scalar(
                    select(self.artifact_index_batches.c.id).where(
                        self.artifact_index_batches.c.session_id == session_pk,
                        self.artifact_index_batches.c.run_id == run_id,
                        self.artifact_index_batches.c.sequence == sequence,
                    )
                )
                if exists is not None:
                    continue
                conn.execute(
                    insert(self.artifact_index_batches).values(
                        session_id=session_pk,
                        run_id=run_id,
                        sequence=sequence,
                        agent_id=agent_id,
                        items=batch_items,
                        status=_PENDING,
                        attempts=0,
                        last_error=None,
                        claimed_at=None,
                        overflow_count=(overflow_count if sequence == 0 else 0),
                        created_at=now,
                        updated_at=now,
                    )
                )
                inserted += 1
        return inserted

    def claim_artifact_index_batches(
        self,
        *,
        limit: int = 1,
        lease_seconds: float = 300.0,
    ) -> list[dict[str, Any]]:
        """Claim pending batches (and stale in-flight ones) for this indexer.

        The claim predicate — ``pending``, or ``indexing`` whose lease expired —
        is evaluated in SQL, so a queue dominated by fresh in-flight leases can
        never hide its pending rows behind an over-fetch. Each claim mints a
        fresh ``lease_token``; the returned batches carry it so the worker's
        completion, requeue, and failure updates are fenced to the claim that
        still owns the row.

        A row is claimed atomically: ``FOR UPDATE SKIP LOCKED`` skips rows a
        concurrent claimer already holds on Postgres, and SQLite's ``BEGIN
        IMMEDIATE`` serializes writers, so two indexers never receive the same
        batch in a healthy claim.
        """
        now_dt = _db_now()
        cutoff = now_dt - timedelta(seconds=lease_seconds)
        claimable = or_(
            self.artifact_index_batches.c.status == _PENDING,
            and_(
                self.artifact_index_batches.c.status == _INDEXING,
                self.artifact_index_batches.c.claimed_at < cutoff,
            ),
        )
        with store_transaction(self.engine) as conn:
            candidate_ids = (
                conn.execute(
                    select(self.artifact_index_batches.c.id)
                    .where(claimable)
                    .order_by(
                        self.artifact_index_batches.c.created_at,
                        self.artifact_index_batches.c.id,
                    )
                    .limit(max(1, limit))
                    .with_for_update(skip_locked=True)
                )
                .scalars()
                .all()
            )
            claimed_ids: list[str] = []
            for batch_id in candidate_ids:
                token = new_database_id()
                # Re-assert the predicate in the write: a row a concurrent
                # claimer won between the read and this write stays theirs.
                updated = conn.execute(
                    update(self.artifact_index_batches)
                    .where(self.artifact_index_batches.c.id == batch_id)
                    .where(claimable)
                    .values(
                        status=_INDEXING,
                        claimed_at=now_dt,
                        lease_token=token,
                        updated_at=now_dt,
                    )
                )
                if updated.rowcount == 0:
                    continue
                claimed_ids.append(str(batch_id))
            if not claimed_ids:
                return []
            rows = (
                conn.execute(
                    select(self.artifact_index_batches)
                    .where(self.artifact_index_batches.c.id.in_(claimed_ids))
                    .order_by(
                        self.artifact_index_batches.c.created_at,
                        self.artifact_index_batches.c.id,
                    )
                )
                .mappings()
                .all()
            )
            return [self._batch_from_row(row, status=_INDEXING) for row in rows]

    def complete_artifact_index_batch(
        self, batch_id: str, *, lease_token: str
    ) -> bool:
        """Mark a batch indexed, only if the passed claim still owns the row.

        Returns ``False`` when a newer claim has superseded this one (the lease
        expired and another indexer re-claimed the batch), so a stale worker
        can never overwrite the newer claim's status.
        """
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                update(self.artifact_index_batches)
                .where(self.artifact_index_batches.c.id == batch_id)
                .where(self.artifact_index_batches.c.lease_token == lease_token)
                .values(status=_INDEXED, updated_at=_db_now())
            )
            return result.rowcount > 0

    def requeue_artifact_index_batch(
        self, batch_id: str, *, attempts: int, lease_token: str
    ) -> bool:
        """Return a failed batch to the queue for a bounded retry, if still owned."""
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                update(self.artifact_index_batches)
                .where(self.artifact_index_batches.c.id == batch_id)
                .where(self.artifact_index_batches.c.lease_token == lease_token)
                .values(
                    status=_PENDING,
                    attempts=attempts,
                    claimed_at=None,
                    lease_token=None,
                    updated_at=_db_now(),
                )
            )
            return result.rowcount > 0

    def fail_artifact_index_batch(
        self, batch_id: str, error: str, *, attempts: int, lease_token: str
    ) -> bool:
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                update(self.artifact_index_batches)
                .where(self.artifact_index_batches.c.id == batch_id)
                .where(self.artifact_index_batches.c.lease_token == lease_token)
                .values(
                    status=_FAILED,
                    attempts=attempts,
                    last_error=error[:2000],
                    claimed_at=None,
                    lease_token=None,
                    updated_at=_db_now(),
                )
            )
            return result.rowcount > 0

    def artifact_index_status(self, session_id: str) -> dict[str, int]:
        """Pending/indexed/failed batch counts and queued overflow for a thread."""
        with store_transaction(self.engine) as conn:
            session_pk = self._session_pk(conn, session_id)
            rows = conn.execute(
                select(
                    self.artifact_index_batches.c.status,
                    func.count().label("count"),
                    func.coalesce(
                        func.sum(self.artifact_index_batches.c.overflow_count), 0
                    ).label("overflow"),
                )
                .where(self.artifact_index_batches.c.session_id == session_pk)
                .group_by(self.artifact_index_batches.c.status)
            ).mappings().all()
        counts = {row["status"]: int(row["count"]) for row in rows}
        # pending includes batches currently being worked, so a reader never
        # sees a batch vanish between "queued" and "done".
        pending = counts.get(_PENDING, 0) + counts.get(_INDEXING, 0)
        return {
            "pending": pending,
            "indexed": counts.get(_INDEXED, 0),
            "failed": counts.get(_FAILED, 0),
            "overflow": int(sum(row["overflow"] for row in rows)),
        }

    def pending_artifact_index_batch_count(self) -> int:
        """How many batches are still waiting, for worker diagnostics."""
        with store_transaction(self.engine) as conn:
            return int(
                conn.scalar(
                    select(func.count())
                    .select_from(self.artifact_index_batches)
                    .where(
                        self.artifact_index_batches.c.status.in_((_PENDING, _INDEXING))
                    )
                )
                or 0
            )

    def run_indexed_relative_paths(
        self, session_id: str, run_id: str
    ) -> set[str]:
        """The run's already-indexed workspace-relative paths, for dedupe."""
        try:
            session = self.get_session(session_id)
        except KeyError:
            return set()
        return {
            artifact.get("workspaceRelativePath")
            for artifact in session.get("artifacts", [])
            if isinstance(artifact.get("workspaceRelativePath"), str)
            and artifact.get("agentRunId") == run_id
        }

    def _batch_from_row(
        self, row: Any, *, status: str | None = None
    ) -> dict[str, Any]:
        items = row["items"]
        if isinstance(items, str):
            items = json.loads(items)
        return {
            "id": str(row["id"]),
            "sessionId": str(row["session_id"]),
            "runId": row["run_id"],
            "sequence": int(row["sequence"] or 0),
            "agentId": row["agent_id"],
            "items": items if isinstance(items, list) else [],
            "status": status if status is not None else row["status"],
            "attempts": int(row["attempts"] or 0),
            "lastError": row["last_error"],
            "leaseToken": row["lease_token"],
            "claimedAt": row["claimed_at"],
        }
