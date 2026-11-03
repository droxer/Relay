"""Encrypted per-account GitHub App connections and one-time authorization states.

Revision ID: 20261103_0108
Revises: 20261103_0107
"""

import sqlalchemy as sa
from alembic import op

revision = "20261103_0108"
down_revision = "20261103_0107"
branch_labels = None
depends_on = None

ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    op.create_table("account_github_connections",
        sa.Column("account_id", ID, sa.ForeignKey("auth_accounts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("sealed_secret", sa.Text(), nullable=False))
    op.create_table("account_github_states",
        sa.Column("state_hash", sa.Text(), primary_key=True),
        sa.Column("account_id", ID, sa.ForeignKey("auth_accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sealed_secret", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False))
    op.create_index("ix_account_github_states_account_id", "account_github_states", ["account_id"])
    op.create_index("ix_account_github_states_expires_at", "account_github_states", ["expires_at"])


def downgrade() -> None:
    op.drop_table("account_github_states")
    op.drop_table("account_github_connections")
