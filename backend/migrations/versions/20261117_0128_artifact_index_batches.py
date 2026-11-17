"""Add pending workspace-artifact indexing batches.

Revision ID: 20261117_0128
Revises: 20261114_0127

Run before deploying the background artifact indexer. A completed run enqueues
its reported files here (snapshot content inline) in the receipt transaction so
``run.completed`` never performs per-file blob uploads or storage transactions.
Rows cascade-delete with their thread. Downgrade drops the table.
"""
from alembic import op
import sqlalchemy as sa

from relay.persistence.sql import entity_uuid_type, json_type

revision = "20261117_0128"
down_revision = "20261114_0127"
branch_labels = None
depends_on = None

NAMING = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}


def upgrade():
    op.create_table(
        "session_artifact_index_batches",
        sa.Column("id", entity_uuid_type(), primary_key=True),
        sa.Column(
            "session_id",
            entity_uuid_type(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=True),
        sa.Column("items", json_type(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("attempts", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_token", sa.Text(), nullable=True),
        sa.Column("overflow_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "session_id",
            "run_id",
            "sequence",
            name="uq_session_artifact_index_batches_run_seq",
        ),
    )
    op.create_index(
        "ix_session_artifact_index_batches_status",
        "session_artifact_index_batches",
        ["status"],
    )
    op.create_index(
        "ix_session_artifact_index_batches_claimed",
        "session_artifact_index_batches",
        ["claimed_at"],
    )


def downgrade():
    op.drop_index(
        "ix_session_artifact_index_batches_claimed",
        table_name="session_artifact_index_batches",
    )
    op.drop_index(
        "ix_session_artifact_index_batches_status",
        table_name="session_artifact_index_batches",
    )
    op.drop_table("session_artifact_index_batches")
