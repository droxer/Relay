"""Independent Project workflows and optional Team references.

Revision ID: 20261117_0129
Revises: 20261117_0128
"""
from alembic import op
from sqlalchemy import inspect, select

from relay.persistence.tables.workflows import workflows, links, events
from relay.persistence.workflow.migration import migrate_team_workflows

revision = '20261117_0129'
down_revision = '20261117_0128'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    for table in (workflows, links, events):
        if not inspect(conn).has_table(table.name):
            table.create(conn)
    migrate_team_workflows(conn)


def downgrade() -> None:
    # Independent records cannot be represented losslessly by older Team-only
    # servers. Avoid silently dropping Project-only definitions on rollback.
    conn = op.get_bind()
    if conn.execute(select(workflows.c.id).limit(1)).first():
        raise RuntimeError('Independent Workflows require a forward fix; downgrade would lose Project definitions.')
    for table in (events, links, workflows):
        table.drop(conn)
