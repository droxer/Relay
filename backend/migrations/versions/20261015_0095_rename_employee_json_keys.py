"""Rewrite employee-era keys inside stored JSON to their user names.

Event payloads and snapshots carry keys such as ``ownerEmployeeId``; they
become ``ownerUserId`` through ``relay.core.legacy_names.upgrade_legacy_names``
-- the same function the runtime applies to file-backed state and to bodies
from older daemons, so the migration and the runtime cannot disagree.

An event log can be large, so this revision does not run as one transaction:
it walks each table in primary-key order and commits every batch. Table locks
from the previous revision's renames are already released, nothing is held
for the whole scan, and an interrupted run simply resumes -- rows already
rewritten no longer match. Stop the backend while it runs: the runtime reads
only the new keys.

Downgrade maps back exactly the keys Relay wrote (``LEGACY_KEYS``), the same
way and in the same batches.

Revision ID: 20261015_0095
Revises: 20261015_0094
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import sqlalchemy as sa
from alembic import op

from relay.core.legacy_names import downgrade_to_legacy_names, upgrade_legacy_names

revision = "20261015_0095"
down_revision = "20261015_0094"
branch_labels = None
depends_on = None

# (table, JSON column) that can carry employee-era keys or values.
JSON_COLUMNS = (
    ("agent_events", "payload"),
    ("agent_placement_events", "payload"),
    ("agent_placements", "snapshot"),
    ("agents", "snapshot"),
    ("automation_outbox", "payload"),
    ("automation_state", "pending_events"),
    ("chat_documents", "payload"),
    ("daemon_commands", "command"),
    ("daemon_events", "payload"),
    ("daemon_node_agents", "details"),
    ("daemon_run_requests", "assignments"),
    ("daemon_run_requests", "state"),
    ("managed_node_records", "snapshot"),
    ("project_events", "payload"),
    ("projects", "snapshot"),
    ("session_artifacts", "metadata"),
    ("session_events", "payload"),
    ("session_workspace_files", "artifact"),
    ("sessions", "final_outcome"),
    ("sessions", "participants"),
    ("sessions", "snapshot"),
    ("skill_assignments", "pin"),
    ("skill_events", "payload"),
    ("skills", "snapshot"),
    ("task_events", "payload"),
    ("tasks", "snapshot"),
    ("team_events", "payload"),
    ("teams", "snapshot"),
)

BATCH_SIZE = 500


def upgrade() -> None:
    _rewrite_all("%employee%", upgrade_legacy_names)


def downgrade() -> None:
    # Every downgraded key and value contains "user"; the mapping is exact, so a
    # row that only mentions "user" in text downgrades to itself and is skipped.
    _rewrite_all("%user%", downgrade_to_legacy_names)


def _rewrite_all(pattern: str, rewrite: Callable[[Any], Any]) -> None:
    # Autocommit: each batch below commits on its own.
    with op.get_context().autocommit_block():
        conn = op.get_bind()
        for table, column in JSON_COLUMNS:
            if _rewrite_column(conn, table, column, pattern, rewrite):
                # Plain ANALYZE takes no lock that blocks reads or writes.
                conn.execute(sa.text(f'ANALYZE "{table}"'))


def _rewrite_column(
    conn: sa.Connection,
    table_name: str,
    column_name: str,
    pattern: str,
    rewrite: Callable[[Any], Any],
) -> int:
    table = sa.Table(table_name, sa.MetaData(), autoload_with=conn)
    pk_names = sa.inspect(conn).get_pk_constraint(table_name)["constrained_columns"]
    key = [table.c[name] for name in pk_names]
    column = table.c[column_name]
    statement = (
        sa.update(table)
        .where(sa.and_(*(c == sa.bindparam(f"pk_{c.name}") for c in key)))
        .values({column.name: sa.bindparam("value", type_=column.type)})
    )
    rewritten = 0
    last: tuple[Any, ...] | None = None
    while True:
        page = sa.select(*key, column).where(sa.cast(column, sa.Text).ilike(pattern))
        if last is not None:
            page = page.where(sa.tuple_(*key) > sa.tuple_(*last))
        rows = conn.execute(page.order_by(*key).limit(BATCH_SIZE)).mappings().all()
        if not rows:
            return rewritten
        last = tuple(rows[-1][name] for name in pk_names)
        changed = [
            {**{f"pk_{name}": row[name] for name in pk_names}, "value": value}
            for row in rows
            if (value := rewrite(row[column_name])) != row[column_name]
        ]
        if changed:
            conn.execute(statement, changed)
            rewritten += len(changed)
