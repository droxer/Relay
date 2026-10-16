"""Add the in-app notification inbox.

``notifications`` holds each person's notices (task finished, computer went
online/offline, computer runs an outdated client); ``notification_watch_state``
records the last computer state the watcher announced so replicas announce a
transition once; ``notification_preferences`` holds the kinds a person muted.
``user_id`` is text without a foreign key: a notice is written inside a task
write, which an unknown owner id must never fail.

Revision ID: 20261016_0099
Revises: 20261016_0098
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261016_0099"
down_revision = "20261016_0098"
branch_labels = None
depends_on = None

ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")
JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", ID, primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("data", JSON, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_notifications_user_id_created_at", "notifications", ["user_id", "created_at"]
    )
    op.create_index("ix_notifications_created_at", "notifications", ["created_at"])
    op.create_table(
        "notification_watch_state",
        sa.Column("subject_key", sa.Text(), primary_key=True),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "notification_preferences",
        sa.Column("user_id", sa.Text(), primary_key=True),
        sa.Column("muted_kinds", JSON, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("notification_preferences")
    op.drop_table("notification_watch_state")
    op.drop_index("ix_notifications_created_at", table_name="notifications")
    op.drop_index("ix_notifications_user_id_created_at", table_name="notifications")
    op.drop_table("notifications")
