"""add scoped skill assignments

Revision ID: 20260915_0073
Revises: 20260915_0072
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260915_0073"
down_revision = "20260915_0072"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "skill_assignments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("skill_id", sa.Uuid(), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", sa.Text(), nullable=False),
        sa.Column("mode", sa.Text(), nullable=False),
        sa.Column("pin", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("invocation", sa.Text(), nullable=False),
        sa.Column("created_by_employee_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "target_type IN ('employee', 'team', 'project', 'agent', 'org')",
            name="ck_skill_assignments_target_type",
        ),
        sa.CheckConstraint(
            "mode IN ('optional', 'required', 'suggested')",
            name="ck_skill_assignments_mode",
        ),
        sa.CheckConstraint(
            "invocation IN ('implicit', 'explicit')",
            name="ck_skill_assignments_invocation",
        ),
        sa.ForeignKeyConstraint(["skill_id"], ["skills.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["created_by_employee_id"], ["employees.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "skill_id",
            "target_type",
            "target_id",
            name="uq_skill_assignments_target",
        ),
    )
    op.create_index(
        "ix_skill_assignments_target",
        "skill_assignments",
        ["target_type", "target_id"],
    )
    op.create_index(
        "ix_skill_assignments_skill", "skill_assignments", ["skill_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_skill_assignments_skill", table_name="skill_assignments")
    op.drop_index("ix_skill_assignments_target", table_name="skill_assignments")
    op.drop_table("skill_assignments")
