"""Add password reset links.

One row per issued link; only the SHA-256 of the token is stored. A row is
spent (``used_at``) when it is redeemed or a newer link supersedes it.

Revision ID: 20261016_0097
Revises: 20261016_0096
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261016_0097"
down_revision = "20261016_0096"
branch_labels = None
depends_on = None

ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "auth_password_resets",
        sa.Column("id", ID, primary_key=True),
        sa.Column(
            "account_id",
            ID,
            sa.ForeignKey("auth_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_auth_password_resets_account_id_created_at",
        "auth_password_resets",
        ["account_id", "created_at"],
    )
    op.create_index(
        "ix_auth_password_resets_expires_at",
        "auth_password_resets",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_auth_password_resets_expires_at", table_name="auth_password_resets")
    op.drop_index(
        "ix_auth_password_resets_account_id_created_at", table_name="auth_password_resets"
    )
    op.drop_table("auth_password_resets")
