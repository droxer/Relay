"""Add task prerequisites.

One row per edge between a task and a task that must be done before it may
run. The rows are derived from each dependent task's ``task.prerequisites_set``
event; no existing task has one, so there is nothing to backfill.

Revision ID: 20261025_0102
Revises: 20261023_0101
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261025_0102"
down_revision = "20261023_0101"
branch_labels = None
depends_on = None

ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "task_prerequisites",
        sa.Column(
            "task_id",
            ID,
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "prerequisite_task_id",
            ID,
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )
    op.create_index(
        "ix_task_prerequisites_prerequisite",
        "task_prerequisites",
        ["prerequisite_task_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_task_prerequisites_prerequisite", table_name="task_prerequisites")
    op.drop_table("task_prerequisites")
