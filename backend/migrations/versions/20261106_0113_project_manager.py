"""Project manager proposal records and authoritative proposal events.

Revision ID: 20261106_0113
Revises: 20261104_0112
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261106_0113"
down_revision = "20261104_0112"
branch_labels = None
depends_on = None


def upgrade() -> None:
    document = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
    op.create_table("project_manager_proposals",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("snapshot", document, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_project_manager_proposals_project", "project_manager_proposals", ["project_id", "created_at"])
    op.create_table("project_manager_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("proposal_id", sa.Uuid(), sa.ForeignKey("project_manager_proposals.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("payload", document, nullable=False),
        sa.UniqueConstraint("proposal_id", "sequence", name="uq_project_manager_events_sequence"),
    )


def downgrade() -> None:
    op.drop_table("project_manager_events")
    op.drop_table("project_manager_proposals")
