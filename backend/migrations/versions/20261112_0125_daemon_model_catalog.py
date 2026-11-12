"""Persist runtime model catalogs reported by computers.

Revision ID: 20261112_0125
Revises: 20261112_0124

Apply before starting the updated backend. Existing rows acquire their catalog
on the daemon's next registration or runtime refresh; no vendor ids are seeded.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261112_0125"
down_revision = "20261112_0124"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("daemon_node_agents", sa.Column(
        "models", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True,
    ))
    op.add_column("daemon_node_agents", sa.Column("custom_model_endpoint", sa.Boolean(), nullable=True))
    op.add_column("daemon_node_agents", sa.Column("default_model", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("daemon_node_agents", "default_model")
    op.drop_column("daemon_node_agents", "custom_model_endpoint")
    op.drop_column("daemon_node_agents", "models")
