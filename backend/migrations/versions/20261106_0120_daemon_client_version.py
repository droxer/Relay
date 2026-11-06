"""Record the Relay client release reported by each daemon.

Revision ID: 20261106_0120
Revises: 20261106_0119
"""
from alembic import op
import sqlalchemy as sa

revision = "20261106_0120"
down_revision = "20261106_0119"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("daemon_nodes", sa.Column("client_version", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("daemon_nodes", "client_version")
