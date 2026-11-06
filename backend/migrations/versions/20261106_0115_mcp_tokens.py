"""Scoped, expiring API tokens for local Relay MCP clients.

Revision ID: 20261106_0115
Revises: 20261106_0114
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261106_0115"
down_revision = "20261106_0114"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("mcp_tokens",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("computer_id", sa.Text()),
        sa.Column("project_ids", postgresql.JSONB()),
        sa.Column("command_id", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_mcp_tokens_owner", "mcp_tokens", ["owner_user_id", "created_at"])


def downgrade() -> None:
    op.drop_table("mcp_tokens")
