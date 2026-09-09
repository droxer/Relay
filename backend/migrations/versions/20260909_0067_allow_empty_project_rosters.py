"""Allow projects to be created before their first roster member.

Revision ID: 20260909_0067
Revises: 20260908_0066
"""

from alembic import op
import sqlalchemy as sa

revision = "20260909_0067"
down_revision = "20260908_0066"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("projects", "lead_agent_id", existing_type=sa.Uuid(), nullable=True)


def downgrade() -> None:
    if op.get_bind().execute(
        sa.text("SELECT 1 FROM projects WHERE lead_agent_id IS NULL LIMIT 1")
    ).first():
        raise RuntimeError(
            "Cannot downgrade while projects have empty rosters; assign their lead agents first."
        )
    op.alter_column("projects", "lead_agent_id", existing_type=sa.Uuid(), nullable=False)
