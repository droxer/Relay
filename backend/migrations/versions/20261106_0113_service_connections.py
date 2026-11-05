"""Encrypted service connections and explicitly scoped work access.

Revision ID: 20261106_0113
Revises: 20261104_0112
"""

import sqlalchemy as sa
from alembic import op

revision = "20261106_0113"
down_revision = "20261104_0112"
branch_labels = None
depends_on = None
ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")
JSON = sa.JSON().with_variant(sa.dialects.postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table("service_connections", sa.Column("id", ID, primary_key=True),
        sa.Column("owner_user_id", sa.Text(), nullable=False), sa.Column("record", JSON, nullable=False),
        sa.Column("sealed_secret", sa.Text(), nullable=True))
    op.create_index("ix_service_connections_owner", "service_connections", ["owner_user_id"])
    op.create_table("service_connection_states", sa.Column("state_hash", sa.Text(), primary_key=True),
        sa.Column("owner_user_id", sa.Text(), nullable=False), sa.Column("sealed_secret", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False))
    op.create_index("ix_service_connection_states_expiry", "service_connection_states", ["expires_at"])
    op.create_table("service_connection_grants", sa.Column("id", ID, primary_key=True),
        sa.Column("owner_user_id", sa.Text(), nullable=False), sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", sa.Text(), nullable=False), sa.Column("record", JSON, nullable=False))
    op.create_index("ix_service_connection_grants_target", "service_connection_grants", ["owner_user_id", "target_type", "target_id"])
    op.create_table("service_connection_events", sa.Column("id", ID, primary_key=True),
        sa.Column("owner_user_id", sa.Text(), nullable=False), sa.Column("aggregate_id", sa.Text(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False), sa.Column("record", JSON, nullable=False))
    op.create_index("ix_service_connection_events_aggregate", "service_connection_events", ["aggregate_id", "sequence"], unique=True)


def downgrade() -> None:
    for table in ("service_connection_events", "service_connection_grants", "service_connection_states", "service_connections"):
        op.drop_table(table)
