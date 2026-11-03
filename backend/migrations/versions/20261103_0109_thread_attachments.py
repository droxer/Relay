"""Private Thread image uploads.

Revision ID: 20261103_0109
Revises: 20261103_0108
"""

from __future__ import annotations
import sqlalchemy as sa
from alembic import op

revision = "20261103_0109"
down_revision = "20261103_0108"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "thread_attachments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_user_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Uuid(), sa.ForeignKey("sessions.id", ondelete="CASCADE")),
        sa.Column("media_type", sa.Text(), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("blob_key", sa.Text()),
        sa.Column("content", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_thread_attachments_session", "thread_attachments", ["session_id"])
    op.create_index("ix_thread_attachments_created", "thread_attachments", ["created_at"])


def downgrade() -> None:
    op.drop_table("thread_attachments")
