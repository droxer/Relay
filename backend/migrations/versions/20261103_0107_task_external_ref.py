"""Record where an imported task came from (``tasks.external_ref``).

A GitHub issue import stores ``externalSource.ref`` (``github:owner/repo#12``)
on the row so a later import can skip issues it already brought in. The column
is nullable without a default, so adding it only changes the catalog; the
partial index covers imported rows only and is built CONCURRENTLY so writers
on ``tasks`` never queue behind it. Existing tasks were never imported, so
there is nothing to backfill.

Revision ID: 20261103_0107
Revises: 20261102_0106
"""
from __future__ import annotations

from contextlib import nullcontext

import sqlalchemy as sa
from alembic import op

revision = "20261103_0107"
down_revision = "20261102_0106"
branch_labels = None
depends_on = None

INDEX = "ix_tasks_external_ref"


def upgrade() -> None:
    postgres = op.get_bind().dialect.name == "postgresql"
    if postgres:
        op.execute("SET LOCAL lock_timeout = '5s'")
    # Entering the autocommit block commits this column before the index is
    # built. A failed index build leaves the revision unstamped, so a retry
    # must also tolerate the already-committed column.
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("tasks")}
    if "external_ref" not in columns:
        op.add_column("tasks", sa.Column("external_ref", sa.Text(), nullable=True))
    with op.get_context().autocommit_block() if postgres else nullcontext():
        if postgres:
            # A failed CONCURRENTLY build leaves an INVALID index that
            # IF NOT EXISTS would keep; drop it so a re-run repairs it.
            invalid = op.get_bind().execute(
                sa.text(
                    "SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                    "JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "WHERE c.relname = :name AND n.nspname = current_schema() "
                    "AND NOT i.indisvalid"
                ),
                {"name": INDEX},
            ).first()
            if invalid:
                op.execute(sa.text(f'DROP INDEX CONCURRENTLY IF EXISTS "{INDEX}"'))
        op.create_index(
            INDEX,
            "tasks",
            ["external_ref"],
            postgresql_concurrently=True,
            if_not_exists=True,
            postgresql_where=sa.text("external_ref IS NOT NULL"),
            sqlite_where=sa.text("external_ref IS NOT NULL"),
        )


def downgrade() -> None:
    postgres = op.get_bind().dialect.name == "postgresql"
    with op.get_context().autocommit_block() if postgres else nullcontext():
        op.drop_index(INDEX, table_name="tasks", postgresql_concurrently=True, if_exists=True)
    op.drop_column("tasks", "external_ref")
