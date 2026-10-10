"""Erase recoverable launch credentials; authentication hashes remain valid.

Revision ID: 20261010_0089
Revises: 20261010_0088
"""
from alembic import op

revision = "20261010_0089"
down_revision = "20261010_0088"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Keep the nullable column for schema compatibility during deployment.
    op.execute("UPDATE daemon_nodes SET node_token_secret = NULL WHERE node_token_secret IS NOT NULL")


def downgrade() -> None:
    # Erased credentials cannot and must not be reconstructed.
    pass
