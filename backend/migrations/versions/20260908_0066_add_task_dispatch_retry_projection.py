"""add queryable task dispatch retry state

Revision ID: 20260908_0066
Revises: 20260831_0065
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260908_0066"
down_revision = "20260831_0065"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("dispatch_failure_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "tasks",
        sa.Column("dispatch_next_attempt_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_tasks_dispatch_eligibility",
        "tasks",
        [
            "status",
            "is_routine",
            "dispatch_next_attempt_at",
            "priority",
            "due_date",
            "created_at",
        ],
    )
    op.alter_column("tasks", "dispatch_failure_count", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_tasks_dispatch_eligibility", table_name="tasks")
    op.drop_column("tasks", "dispatch_next_attempt_at")
    op.drop_column("tasks", "dispatch_failure_count")
