"""Appending thread events and reading them back in pages.

A mixin of ``DatabaseSessionStore``; it shares the store's engine and tables
(declared on ``SessionStoreState``) and is not used on its own.
"""

from __future__ import annotations

import time
from typing import Any
from loguru import logger
from sqlalchemy import (
    bindparam,
    delete,
    func,
    insert,
    literal_column,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError
from ..automation.store import insert_outbox_rows, session_outbox_rows
from .reducer import SNAPSHOT_NEUTRAL_SESSION_EVENTS, apply_session_event
from ...core.ids import new_database_id
from ..engine import publish_database_notification, store_transaction
from .rows import (
    compact_session_snapshot,
    session_event_cursor_expression,
    session_event_to_row,
    session_run_token_usage_to_row,
    session_to_row,
)
from .state import SessionStoreState


def _payload_field(pg: bool, key: str) -> str:
    """SQL text reading one scalar field of the event payload in either dialect."""
    return (
        f"session_events.payload->>'{key}'"
        if pg
        else f"json_extract(session_events.payload, '$.{key}')"
    )


class SessionEventRows(SessionStoreState):
    def append_event(
        self,
        session_id: str,
        event: dict[str, Any],
        *,
        hydrate_events: bool = True,
    ) -> dict[str, Any]:
        for attempt in range(3):
            try:
                session = self._append_event_once(session_id, event)
                self._notify_event(session_id)
                return self.get_session(session_id) if hydrate_events else session
            except IntegrityError:
                if attempt == 2:
                    raise
                time.sleep(0.01 * (attempt + 1))
        raise RuntimeError("unreachable")

    def _append_event_once(
        self, session_id: str, event: dict[str, Any]
    ) -> dict[str, Any]:
        if event.get("type") in SNAPSHOT_NEUTRAL_SESSION_EVENTS:
            return self._append_neutral_event(session_id, event)
        with store_transaction(self.engine) as conn:
            row = self._locked_session_row(conn, session_id)
            session_pk = row["id"]
            if event.get("type") == "session.deletion_requested" and (row["snapshot"] or {}).get("deletionRequestedAt"):
                return row["snapshot"]
            sequence = int(row["version"] or 0)
            conn.execute(
                insert(self.events).values(
                    **session_event_to_row(session_pk, sequence, event)
                )
            )
            session = apply_session_event(
                compact_session_snapshot(
                    row["snapshot"] or {}, event_count=sequence + 1
                ),
                event,
                retain_event=False,
            )
            conn.execute(
                update(self.sessions)
                .where(self.sessions.c.id == session_pk)
                .values(
                    **session_to_row(
                        session, version=sequence + 1, database_id=session_pk
                    )
                )
            )
            self._project_appended_event(conn, session_id, session_pk, session, event)
            publish_database_notification(
                conn,
                self.engine,
                self._event_changes.database_channel,
                f"session:{session_id}",
            )
        logger.debug(
            "Database session event appended",
            session_id=session_id,
            event_type=event.get("type"),
        )
        return session

    def _locked_session_row(self, conn: Any, session_id: str) -> Any:
        """The session's id, snapshot, and version, locked for this transaction."""
        row = (
            conn.execute(
                select(
                    self.sessions.c.id,
                    self.sessions.c.snapshot,
                    self.sessions.c.version,
                )
                .where(self.sessions.c.id == session_id)
                .with_for_update()
            )
            .mappings()
            .first()
        )
        if not row:
            raise KeyError(session_id)
        return row

    def _project_appended_event(
        self,
        conn: Any,
        session_id: str,
        session_pk: str,
        session: dict[str, Any],
        event: dict[str, Any],
    ) -> None:
        """Write what the event feeds besides the snapshot: outbox, files, runs, usage."""
        if self.emit_automation_events:
            insert_outbox_rows(conn, session_outbox_rows(session_id, event))
        if event.get("type") == "artifact.created":
            self._index_workspace_files(conn, session_pk, session, [event["artifact"]])
        if event.get("type") == "agent.completed":
            self._sync_run_token_usage(
                conn, session_pk, session, str(event.get("runId") or "")
            )
        elif event.get("type") == "agent.started":
            run = next(
                (
                    item
                    for item in session.get("agentRuns") or []
                    if item.get("id") == event.get("runId")
                ),
                None,
            )
            if run:
                self._insert_agent_run(conn, session_pk, run)

    def _append_neutral_event(
        self, session_id: str, event: dict[str, Any]
    ) -> dict[str, Any]:
        """Append an event that changes no projection field.

        Bumping ``version`` in place both reserves the sequence and takes the
        same row lock the full path takes, without reading or rewriting the
        snapshot. ``version`` is unindexed, so PostgreSQL can apply it as a HOT
        update. Returns only the identity and new event count; callers that
        want the session ask for it with ``hydrate_events``.
        """
        with store_transaction(self.engine) as conn:
            version = conn.scalar(
                update(self.sessions)
                .where(self.sessions.c.id == session_id)
                .values(version=self.sessions.c.version + 1)
                .returning(self.sessions.c.version)
            )
            if version is None:
                raise KeyError(session_id)
            conn.execute(
                insert(self.events).values(
                    **session_event_to_row(session_id, int(version) - 1, event)
                )
            )
            publish_database_notification(
                conn,
                self.engine,
                self._event_changes.database_channel,
                f"session:{session_id}",
            )
        return {"id": session_id, "eventCount": int(version)}

    def read_event_page(
        self,
        session_id: str,
        *,
        after_event_id: str | None = None,
        after_sequence: int | None = None,
        limit: int = 256,
    ) -> dict[str, Any]:
        """Read an event tail directly from the append-only event table."""
        with store_transaction(self.engine) as conn:
            session = (
                conn.execute(
                    select(
                        self.sessions.c.id,
                        self.sessions.c.status,
                        self.sessions.c.version,
                    ).where(self.sessions.c.id == session_id)
                )
                .mappings()
                .first()
            )
            if not session:
                raise KeyError(session_id)

            start = after_sequence if after_sequence is not None else 0
            if after_sequence is None and after_event_id:
                cursor = conn.scalar(
                    select(self.events.c.sequence).where(
                        self.events.c.session_id == session["id"],
                        session_event_cursor_expression(self.events) == after_event_id,
                    )
                )
                start = int(cursor) + 1 if cursor is not None else 0

            rows = (
                conn.execute(
                    select(self.events.c.sequence, self.events.c.payload)
                    .where(
                        self.events.c.session_id == session["id"],
                        self.events.c.sequence >= start,
                    )
                    .order_by(self.events.c.sequence)
                    .limit(max(1, limit))
                )
                .mappings()
                .all()
            )
            next_sequence = int(rows[-1]["sequence"]) + 1 if rows else start
            return {
                "events": [row["payload"] for row in rows],
                "nextSequence": next_sequence,
                "version": int(session["version"] or 0),
                "status": session["status"],
            }

    def run_output_sequences(self, session_id: str, run_id: str) -> dict[str, int]:
        """The highest streamed sequence per stream one run has already logged.

        ``agent.output`` and ``agent.collaboration`` carry one sequence each
        (the latter on the ``collaboration`` stream); ``agent.output.batch``
        carries one per entry. Aggregated in SQL so a run's dedupe cursor is
        one query over its own rows, never a replay of the whole thread.
        """
        pg = self.engine.dialect.name == "postgresql"
        seen: dict[str, int] = {}

        def note(stream: Any, sequence: Any) -> None:
            if isinstance(stream, str) and sequence is not None:
                seen[stream] = max(seen.get(stream, -1), int(sequence))

        with store_transaction(self.engine) as conn:
            for stream_expr, cursor_expr, event_type in (
                (_payload_field(pg, "stream"), _payload_field(pg, "sequence"), "agent.output"),
                ("'collaboration'", _payload_field(pg, "sequence"), "agent.collaboration"),
            ):
                for stream, sequence in conn.execute(
                    select(
                        literal_column(stream_expr),
                        func.max(literal_column(f"CAST({cursor_expr} AS BIGINT)")),
                    )
                    .where(
                        self.events.c.session_id == session_id,
                        self.events.c.type == event_type,
                        literal_column(_payload_field(pg, "runId")) == run_id,
                    )
                    .group_by(literal_column(stream_expr))
                ):
                    note(stream, sequence)
            entries = (
                "jsonb_array_elements(session_events.payload->'entries')"
                if pg
                else "json_each(json_extract(session_events.payload, '$.entries'))"
            )
            entry_field = (
                "e.value->>'{0}'" if pg else "json_extract(e.value, '$.{0}')"
            )
            batch_rows = conn.execute(
                text(
                    f"SELECT {entry_field.format('stream')} AS stream, "
                    f"MAX(CAST({entry_field.format('sequence')} AS BIGINT)) AS sequence "
                    f"FROM session_events, {entries} AS e "
                    "WHERE session_events.session_id = :session_id "
                    "AND session_events.type = 'agent.output.batch' "
                    f"AND {_payload_field(pg, 'runId')} = :run_id "
                    f"GROUP BY {entry_field.format('stream')}"
                ).bindparams(
                    bindparam("session_id", session_id, type_=self.events.c.session_id.type),
                    bindparam("run_id", run_id),
                )
            )
            for stream, sequence in batch_rows:
                note(stream, sequence)
        return seen

    def has_agent_run(self, logical_agent_id: str, placement_ids: set[str]) -> bool:
        """Use indexed run projections rather than scanning session snapshots."""
        predicates = [self.agent_runs.c.logical_agent_id == logical_agent_id]
        if placement_ids:
            predicates.append(self.agent_runs.c.placement_id.in_(placement_ids))
        with store_transaction(self.engine) as conn:
            return (
                conn.execute(
                    select(self.agent_runs.c.id).where(or_(*predicates)).limit(1)
                ).first()
                is not None
            )

    def _insert_agent_run(
        self, conn: Any, session_pk: str, run: dict[str, Any]
    ) -> None:
        if not run.get("logicalAgentId") and not run.get("placementId"):
            return
        exists = conn.execute(
            select(self.agent_runs.c.id)
            .where(self.agent_runs.c.session_id == session_pk)
            .where(self.agent_runs.c.run_id == run["id"])
        ).first()
        if exists:
            return
        conn.execute(
            insert(self.agent_runs).values(
                id=new_database_id(),
                session_id=session_pk,
                run_id=run["id"],
                logical_agent_id=run.get("logicalAgentId"),
                placement_id=run.get("placementId"),
            )
        )

    def _events_for_session(self, conn: Any, session_pk: str) -> list[dict[str, Any]]:
        rows = (
            conn.execute(
                select(self.events.c.payload)
                .where(self.events.c.session_id == session_pk)
                .order_by(self.events.c.sequence)
            )
            .mappings()
            .all()
        )
        return [row["payload"] for row in rows]

    def _sync_run_token_usage(
        self, conn: Any, session_pk: str, session: dict[str, Any], run_id: str
    ) -> None:
        row = session_run_token_usage_to_row(session_pk, session, run_id)
        existing_id = conn.scalar(
            select(self.run_token_usage.c.id)
            .where(self.run_token_usage.c.session_id == session_pk)
            .where(self.run_token_usage.c.run_id == run_id)
        )
        if row:
            if existing_id:
                conn.execute(
                    update(self.run_token_usage)
                    .where(self.run_token_usage.c.id == existing_id)
                    .values({**row, "id": existing_id})
                )
            else:
                conn.execute(insert(self.run_token_usage).values(**row))
        elif existing_id:
            conn.execute(
                delete(self.run_token_usage).where(
                    self.run_token_usage.c.id == existing_id
                )
            )
