"""Include standalone Workflow assignments in the indexed dispatch queue.

Postgres builds the replacement concurrently before removing the old index.
These DDL operations commit outside the migration transaction; retry rebuilds
the replacement rather than trusting a potentially incomplete build.
"""
from contextlib import nullcontext

from alembic import op
from sqlalchemy import text

revision = '20261128_0136'
down_revision = '20261128_0135'
branch_labels = None
depends_on = None


def _replace(include_workflows: bool) -> None:
    postgres = op.get_bind().dialect.name == 'postgresql'
    name = 'ix_tasks_dispatch_order'
    temporary = name + '_replacement' if postgres else name
    concurrently = ' CONCURRENTLY' if postgres else ''
    predicate = (
        f"status IN ('assigned', 'queued') AND is_routine IS {'false' if postgres else '0'} AND deleted_at IS NULL "
        'AND (assigned_agent IS NOT NULL OR assigned_team_id IS NOT NULL OR project_id IS NOT NULL'
        + (" OR (snapshot ->> 'assignedWorkflowId') IS NOT NULL)" if include_workflows else ')')
    )
    with op.get_context().autocommit_block() if postgres else nullcontext():
        op.execute(text(f'DROP INDEX{concurrently} IF EXISTS "{temporary}"'))
        op.execute(text(
            f'CREATE INDEX{concurrently} "{temporary}" ON tasks '
            "((priority <> 'high'), (priority = 'low'), (due_date IS NULL), "
            f"COALESCE(due_date, '9999-12-31'), created_at, id) WHERE {predicate}"
        ))
        if postgres:
            op.execute(text(f'DROP INDEX CONCURRENTLY IF EXISTS "{name}"'))
            op.execute(text(f'ALTER INDEX "{temporary}" RENAME TO "{name}"'))


def upgrade() -> None:
    _replace(True)


def downgrade() -> None:
    _replace(False)
