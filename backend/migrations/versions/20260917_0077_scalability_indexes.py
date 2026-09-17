"""Concurrent indexes for stream reconnects, recovery and retention.

Revision ID: 20260917_0077
Revises: 20260917_0076
"""

from contextlib import nullcontext
from alembic import op
import sqlalchemy as sa

revision = "20260917_0077"
down_revision = "20260917_0076"
branch_labels = None
depends_on = None

INDEXES = [
    (
        "ix_session_events_cursor",
        "session_events",
        ["session_id", sa.text("(payload ->> 'id')")],
        None,
    ),
    (
        "ix_daemon_run_requests_recovery",
        "daemon_run_requests",
        ["recovery_after", "id"],
        "status IN ('prepared', 'running', 'dispatching', 'finalizing')",
    ),
    (
        "ix_daemon_commands_terminal_retention",
        "daemon_commands",
        ["node_id", sa.text("coalesce(completed_at, updated_at, created_at)"), "id"],
        "status IN ('completed', 'failed', 'cancelled')",
    ),
    (
        "ix_daemon_runs_terminal_retention",
        "daemon_runs",
        ["node_id", sa.text("coalesce(completed_at, started_at)"), "id"],
        "status IN ('completed', 'failed', 'cancelled')",
    ),
]


def upgrade():
    postgres = op.get_bind().dialect.name == "postgresql"
    with op.get_context().autocommit_block() if postgres else nullcontext():
        for name, table, columns, predicate in INDEXES:
            options = (
                {"postgresql_concurrently": True, "if_not_exists": True}
                if postgres
                else {}
            )
            if predicate:
                options["postgresql_where" if postgres else "sqlite_where"] = sa.text(
                    predicate
                )
            op.create_index(name, table, columns, **options)


def downgrade():
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
