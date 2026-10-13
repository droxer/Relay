"""Automations v2: state, next-run instant, and trigger flags on tasks.

Adds the materialized columns the v2 automation model reads and backfills
them, along with the v2 snapshot fields (``routineTriggers``,
``routineState``, ``routinePauseReason``), from each routine's legacy
snapshot using ``relay.automations.model.upgrade_legacy`` so there is one
rule. ``routine_next_run_at`` is left NULL: the scheduler's clock seeds every
active schedule automation on its first tick, because resolving "start of
day" needs the server timezone. The legacy columns and their indexes stay
until the scheduler stops reading them.

Downgrade drops the columns and indexes; the v2 snapshot keys remain, which
is harmless because legacy readers ignore them.

Revision ID: 20261013_0091
Revises: 20261011_0090
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from relay.automations.model import (
    LEGACY_FIELDS,
    listens,
    schedule_triggers,
    state_of,
    upgrade_legacy,
)

revision = "20261013_0091"
down_revision = "20261011_0090"
branch_labels = None
depends_on = None

BATCH = 1000
# Predicates are spelled as the store queries render them (`IS true` on
# Postgres, `IS 1` on SQLite); the planner only matches an identical term.
INDEXES = (
    ("ix_tasks_due_schedules", "routine_next_run_at", ()),
    ("ix_tasks_listening_routines", "created_at", ("routine_listens IS {true}",)),
    (
        "ix_tasks_unseeded_schedules",
        "created_at",
        ("routine_has_schedule IS {true}", "routine_next_run_at IS NULL"),
    ),
)


def _where(dialect: str, extra: tuple[str, ...]) -> sa.TextClause:
    true = "true" if dialect == "postgresql" else "1"
    terms = [f"is_routine IS {true}", "routine_state = 'active'", "deleted_at IS NULL"]
    terms.extend(term.format(true=true) for term in extra)
    return sa.text(" AND ".join(terms))


def _tasks_table() -> sa.Table:
    return sa.table(
        "tasks",
        sa.column("id"),
        sa.column("is_routine", sa.Boolean()),
        sa.column("snapshot", sa.JSON().with_variant(postgresql.JSONB(), "postgresql")),
        sa.column("routine_state", sa.Text()),
        sa.column("routine_listens", sa.Boolean()),
        sa.column("routine_has_schedule", sa.Boolean()),
    )


def _upgraded(snapshot: dict) -> dict:
    if "routineTriggers" in snapshot:
        return snapshot
    legacy = {key: snapshot[key] for key in LEGACY_FIELDS if key in snapshot}
    upgraded = upgrade_legacy(legacy)
    merged = {**snapshot, **upgraded}
    if "routinePauseReason" not in upgraded:
        merged.pop("routinePauseReason", None)
    return merged


def backfill(conn: sa.engine.Connection) -> None:
    """Derive the v2 snapshot fields and the three columns. Idempotent."""
    tasks = _tasks_table()
    last = None
    while True:
        query = sa.select(tasks.c.id, tasks.c.snapshot).where(tasks.c.is_routine.is_(True))
        if last is not None:
            query = query.where(tasks.c.id > last)
        rows = conn.execute(query.order_by(tasks.c.id).limit(BATCH)).all()
        if not rows:
            return
        for row_id, snapshot in rows:
            snapshot = _upgraded(dict(snapshot or {}))
            conn.execute(
                sa.update(tasks)
                .where(tasks.c.id == row_id)
                .values(
                    snapshot=snapshot,
                    routine_state=state_of(snapshot),
                    routine_listens=listens(snapshot),
                    routine_has_schedule=bool(schedule_triggers(snapshot)),
                )
            )
        last = rows[-1][0]


def upgrade() -> None:
    op.add_column("tasks", sa.Column("routine_next_run_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("tasks", sa.Column("routine_state", sa.Text(), nullable=True))
    op.add_column(
        "tasks", sa.Column("routine_listens", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.add_column(
        "tasks", sa.Column("routine_has_schedule", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.add_column(
        "automation_state",
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
    )
    backfill(op.get_bind())
    for name, column, extra in INDEXES:
        op.create_index(
            name,
            "tasks",
            [column],
            postgresql_where=_where("postgresql", extra),
            sqlite_where=_where("sqlite", extra),
        )


def downgrade() -> None:
    for name, _column, _extra in reversed(INDEXES):
        op.drop_index(name, table_name="tasks")
    op.drop_column("automation_state", "consecutive_failures")
    for column in ("routine_has_schedule", "routine_listens", "routine_state", "routine_next_run_at"):
        op.drop_column("tasks", column)
