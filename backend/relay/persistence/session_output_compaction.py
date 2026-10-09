"""Opt-in redaction of streamed run output once a run's final log is stored.

Streamed ``agent.output`` / ``agent.output.batch`` events are the bulk of
``session_events``. When a run completes, its ``agent.completed`` event carries
the run log (the registry's output buffer, capped by
``RELAY_RUN_OUTPUT_BUFFER_MAX_CHARS``), and the web transcript falls back to that
log for any run whose streamed text is missing. So after a retention window the
streamed copies can be emptied.

They are redacted in place rather than deleted: event ids, sequences, and the
row's version stay exactly as they were, so stream cursors and the web's
``eventCount`` comparisons keep working. A run whose completed log is empty is
never touched, nor is a run that has not completed.

Threads are visited in ``updated_at`` order behind a persisted keyset cursor, so
each sweep is bounded and a restart resumes instead of rescanning. One replica
sweeps at a time: the cursor row is taken with ``SKIP LOCKED``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    Column,
    DateTime,
    Table,
    Text,
    func,
    insert,
    literal_column,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import insert as postgresql_insert

from .store_common import (
    _format_iso,
    _parse_iso,
    json_type,
    metadata,
    store_transaction,
)

CURSOR_NAME = "session_output_compaction"
STREAM_OUTPUT_EVENTS = ("agent.output", "agent.output.batch")
# Long enough for one sweep of large threads, which the application-wide
# statement_timeout (RELAY_DB_STATEMENT_TIMEOUT_MS) is not sized for.
SWEEP_STATEMENT_TIMEOUT = "300s"
# Only the text is emptied: a batch keeps each entry's stream and sequence, so
# the registry's replay dedupe (_session_output_sequences) still sees them.
REDACTED_PAYLOAD = {
    "postgresql": {
        "agent.output": (
            "session_events.payload || '{\"text\": \"\", \"compacted\": true}'::jsonb"
        ),
        "agent.output.batch": (
            "jsonb_set(session_events.payload || '{\"compacted\": true}'::jsonb, "
            "'{entries}', COALESCE((SELECT jsonb_agg("
            "entry.value || '{\"text\": \"\"}'::jsonb ORDER BY entry.ordinal) "
            "FROM jsonb_array_elements(CASE WHEN jsonb_typeof("
            "session_events.payload->'entries') = 'array' "
            "THEN session_events.payload->'entries' ELSE '[]'::jsonb END) "
            "WITH ORDINALITY AS entry(value, ordinal)), '[]'::jsonb))"
        ),
    },
    "sqlite": {
        "agent.output": (
            "json_patch(session_events.payload, '{\"text\": \"\", \"compacted\": true}')"
        ),
        "agent.output.batch": (
            "json_set(json_patch(session_events.payload, '{\"compacted\": true}'), "
            "'$.entries', (SELECT json_group_array(json(json_set(entry.value, "
            "'$.text', ''))) FROM json_each(session_events.payload, '$.entries') AS entry))"
        ),
    },
}

maintenance_cursors = Table(
    "maintenance_cursors",
    metadata,
    Column("name", Text, primary_key=True),
    Column("position", json_type(), nullable=True),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)


def compact_completed_run_output(
    store: Any, *, older_than: datetime, limit: int = 20
) -> int:
    """Redact streamed output of completed runs in threads idle since ``older_than``.

    Returns how many events were redacted in this sweep.
    """
    sessions, events = store.sessions, store.events
    with store_transaction(store.engine) as conn:
        if conn.dialect.name == "postgresql":
            conn.execute(text(f"SET LOCAL statement_timeout = '{SWEEP_STATEMENT_TIMEOUT}'"))
        position = _claim_cursor(conn)
        if position is False:
            return 0
        candidates = select(sessions.c.id, sessions.c.updated_at).where(
            sessions.c.updated_at <= older_than
        )
        if position:
            after_at, after_id = _parse_iso(position["updatedAt"]), position["id"]
            candidates = candidates.where(
                (sessions.c.updated_at > after_at)
                | ((sessions.c.updated_at == after_at) & (sessions.c.id > after_id))
            )
        rows = conn.execute(
            candidates.order_by(sessions.c.updated_at, sessions.c.id).limit(max(1, limit))
        ).all()
        redacted = sum(_redact_session(conn, events, session_id) for session_id, _ in rows)
        if rows:
            last_id, last_at = rows[-1]
            conn.execute(
                update(maintenance_cursors)
                .where(maintenance_cursors.c.name == CURSOR_NAME)
                .values(
                    position={"updatedAt": _format_iso(last_at), "id": str(last_id)},
                    updated_at=func.now(),
                )
            )
    return redacted


def _claim_cursor(conn: Any) -> dict[str, Any] | None | bool:
    """Lock the sweep cursor; False when another replica holds it."""
    statement = select(maintenance_cursors.c.position).where(
        maintenance_cursors.c.name == CURSOR_NAME
    )
    if conn.dialect.name == "postgresql":
        conn.execute(
            postgresql_insert(maintenance_cursors)
            .values(name=CURSOR_NAME, position=None, updated_at=func.now())
            .on_conflict_do_nothing(index_elements=[maintenance_cursors.c.name])
        )
        row = conn.execute(statement.with_for_update(skip_locked=True)).first()
        return row.position if row is not None else False
    row = conn.execute(statement).first()
    if row is not None:
        return row.position
    conn.execute(
        insert(maintenance_cursors).values(
            name=CURSOR_NAME, position=None, updated_at=func.now()
        )
    )
    return None


def _redact_session(conn: Any, events: Table, session_id: Any) -> int:
    completed_runs = (
        select(events.c.payload["runId"].as_string())
        .where(events.c.session_id == session_id)
        .where(events.c.type == "agent.completed")
        .where(func.coalesce(events.c.payload["agentLog"].as_string(), "") != "")
    )
    redacted = REDACTED_PAYLOAD[conn.dialect.name]
    total = 0
    for event_type in STREAM_OUTPUT_EVENTS:
        result = conn.execute(
            update(events)
            .where(events.c.session_id == session_id)
            .where(events.c.type == event_type)
            .where(events.c.payload["compacted"].as_string().is_(None))
            .where(events.c.payload["runId"].as_string().in_(completed_runs))
            .values(payload=literal_column(redacted[event_type]))
        )
        total += result.rowcount or 0
    return total
