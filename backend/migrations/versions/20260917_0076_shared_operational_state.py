"""Shared managed capacity, profile images, and recovery leases.

Revision ID: 20260917_0076
Revises: 20260917_0075
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260917_0076"
down_revision = "20260917_0075"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "managed_node_records",
        sa.Column("kind", sa.Text(), primary_key=True),
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("node_id", sa.Text(), nullable=True),
        sa.Column(
            "snapshot",
            sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_managed_node_records_kind_node", "managed_node_records", ["kind", "node_id"]
    )
    op.create_table(
        "profile_images",
        sa.Column("kind", sa.Text(), primary_key=True),
        sa.Column("entity_id", sa.Text(), primary_key=True),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("etag", sa.Text(), nullable=False),
    )
    op.add_column(
        "daemon_run_requests",
        sa.Column("recovery_after", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade():
    # Export shared operational state before downgrading to filesystem stores.
    op.drop_column("daemon_run_requests", "recovery_after")
    op.drop_table("profile_images")
    op.drop_index(
        "ix_managed_node_records_kind_node", table_name="managed_node_records"
    )
    op.drop_table("managed_node_records")
