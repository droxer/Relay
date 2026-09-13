"""Reserve each task for at most one active daemon run request.

Revision ID: 20260913_0068
Revises: 20260909_0067
"""

from alembic import op
import sqlalchemy as sa

revision = "20260913_0068"
down_revision = "20260909_0067"
branch_labels = None
depends_on = None

INDEX_NAME = "uq_daemon_run_requests_active_task"
PREDICATE = "task_id IS NOT NULL AND status IN ('prepared', 'running', 'dispatching', 'finalizing')"


def upgrade() -> None:
    # Do not pick a winner by cancelling metadata: an agent may still be writing.
    # Pause admissions and resolve existing owners through normal lifecycle paths.
    if op.get_bind().execute(sa.text(
        f"SELECT task_id FROM daemon_run_requests WHERE {PREDICATE} "
        "GROUP BY task_id HAVING COUNT(*) > 1 LIMIT 1"
    )).first():
        raise RuntimeError(
            "Active task ownership conflicts exist. Pause admissions and resolve "
            "duplicate active task runs before retrying this migration. No runs were changed."
        )
    op.create_index(
        INDEX_NAME, "daemon_run_requests", ["task_id"], unique=True,
        postgresql_where=sa.text(PREDICATE), sqlite_where=sa.text(PREDICATE),
    )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="daemon_run_requests")
