"""Drop the legacy routine indexes.

The v2 schedule clock reads ``routine_next_run_at`` / ``routine_state`` and
the store now writes ``routine_type``, ``routine_cadence``,
``routine_next_run_date``, and ``routine_trigger_kind`` as NULL, so
``ix_tasks_due_routines`` and ``ix_tasks_triggered_routines`` no longer serve
any query. The columns themselves stay until a later migration drops them.

Downgrade recreates both indexes exactly as ``20261010_0087`` and the store
schema defined them.

Revision ID: 20261013_0092
Revises: 20261013_0091
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261013_0092"
down_revision = "20261013_0091"
branch_labels = None
depends_on = None

# (name, column, Postgres predicate, SQLite predicate)
INDEXES = (
    (
        "ix_tasks_due_routines",
        "routine_next_run_date",
        "is_routine IS true AND routine_enabled IS true",
        "is_routine IS 1 AND routine_enabled IS 1",
    ),
    (
        "ix_tasks_triggered_routines",
        "created_at",
        "is_routine IS true AND routine_enabled IS true AND routine_trigger_kind IS NOT NULL",
        "is_routine IS 1 AND routine_enabled IS 1 AND routine_trigger_kind IS NOT NULL",
    ),
)


def upgrade() -> None:
    for name, _column, _postgres, _sqlite in INDEXES:
        op.drop_index(name, table_name="tasks", if_exists=True)


def downgrade() -> None:
    for name, column, postgres, sqlite in INDEXES:
        op.create_index(
            name,
            "tasks",
            [column],
            postgresql_where=sa.text(postgres),
            sqlite_where=sa.text(sqlite),
        )
