"""Indexes for the hot read paths behind the polled lists.

- ``ix_tasks_live_recency``: live tasks newest first with the id tiebreaker,
  the order every task list and summary reads.
- ``ix_daemon_commands_status_node``: ``queued_command_counts`` filters on
  status across the fleet and groups by node.
- ``ix_daemon_runs_running``: ``list_active_runs`` without a node filter reads
  only running rows; a partial index keeps just those.

Built concurrently on Postgres so a busy deploy keeps serving while they
build; each is declared in ``relay.persistence.tables`` as well, so SQLite
tests and the schema-drift test see the same schema.

Revision ID: 20261023_0101
Revises: 20261019_0100
"""

from __future__ import annotations

from contextlib import nullcontext

import sqlalchemy as sa
from alembic import op

revision = "20261023_0101"
down_revision = "20261019_0100"
branch_labels = None
depends_on = None

INDEXES = [
    (
        "ix_tasks_live_recency",
        "tasks",
        [sa.text("updated_at DESC"), sa.text("id DESC")],
        "deleted_at IS NULL",
    ),
    ("ix_daemon_commands_status_node", "daemon_commands", ["status", "node_id"], None),
    ("ix_daemon_runs_running", "daemon_runs", ["node_id", "id"], "status = 'running'"),
]


def upgrade() -> None:
    postgres = op.get_bind().dialect.name == "postgresql"
    with op.get_context().autocommit_block() if postgres else nullcontext():
        for name, table, columns, predicate in INDEXES:
            options: dict[str, object] = (
                {"postgresql_concurrently": True, "if_not_exists": True}
                if postgres
                else {}
            )
            if predicate:
                options["postgresql_where" if postgres else "sqlite_where"] = sa.text(
                    predicate
                )
            op.create_index(name, table, columns, **options)


def downgrade() -> None:
    postgres = op.get_bind().dialect.name == "postgresql"
    with op.get_context().autocommit_block() if postgres else nullcontext():
        for name, table, _, _ in reversed(INDEXES):
            op.drop_index(
                name,
                table_name=table,
                **(
                    {"postgresql_concurrently": True, "if_exists": True}
                    if postgres
                    else {}
                ),
            )
