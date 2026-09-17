"""Index authoritative task ownership lookups without blocking event writes.

Revision ID: 20260917_0075
Revises: 20260916_0074
"""

from alembic import op

revision = "20260917_0075"
down_revision = "20260916_0074"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.create_index(
                "ix_task_events_task_type_sequence",
                "task_events",
                ["task_id", "type", "sequence"],
                postgresql_concurrently=True,
                if_not_exists=True,
            )
    else:
        op.create_index(
            "ix_task_events_task_type_sequence",
            "task_events",
            ["task_id", "type", "sequence"],
        )


def downgrade():
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.drop_index(
                "ix_task_events_task_type_sequence",
                table_name="task_events",
                postgresql_concurrently=True,
                if_exists=True,
            )
    else:
        op.drop_index("ix_task_events_task_type_sequence", table_name="task_events")
