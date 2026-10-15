"""Add the waitlist: people who asked to try Relay.

A plain row per normalized email, not an event log — an entry is not a session
or a task. Only the SHA-256 of an invite token is stored.

Revision ID: 20261016_0096
Revises: 20261015_0095
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261016_0096"
down_revision = "20261015_0095"
branch_labels = None
depends_on = None

ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "waitlist_entries",
        sa.Column("id", ID, primary_key=True),
        sa.Column("email", sa.Text(), nullable=False, unique=True),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("company", sa.Text(), nullable=True),
        sa.Column("role", sa.Text(), nullable=True),
        sa.Column("use_case", sa.Text(), nullable=True),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column("locale", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("invite_token_hash", sa.Text(), nullable=True, unique=True),
        sa.Column("invite_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invited_by_user_id", sa.Text(), nullable=True),
        sa.Column("account_id", sa.Text(), nullable=True),
        sa.Column("admin_note", sa.Text(), nullable=True),
        sa.Column("last_delivery_status", sa.Text(), nullable=True),
        sa.Column("last_delivery_error", sa.Text(), nullable=True),
        sa.Column("last_delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('waiting', 'invited', 'joined', 'declined')",
            name="ck_waitlist_entries_status",
        ),
    )
    op.create_index(
        "ix_waitlist_entries_status_created_at",
        "waitlist_entries",
        ["status", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_waitlist_entries_status_created_at", table_name="waitlist_entries")
    op.drop_table("waitlist_entries")
