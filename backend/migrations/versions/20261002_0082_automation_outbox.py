"""Automation outbox, per-automation firing state, and webhook secrets."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261002_0082"
down_revision = "20261002_0081"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "automation_outbox",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=True),
        sa.Column("source_id", sa.Text(), nullable=True),
        sa.Column("target_routine_id", sa.Text(), nullable=True),
        sa.Column("payload", JSON, nullable=False),
        sa.Column("origin_automation_id", sa.Text(), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_automation_outbox_claim", "automation_outbox", ["claimed_at", "created_at"])
    op.create_table(
        "automation_state",
        sa.Column("routine_id", sa.Text(), nullable=False),
        sa.Column("pending", sa.Boolean(), nullable=False),
        sa.Column("pending_events", JSON, nullable=False),
        sa.Column("pending_dropped", sa.Integer(), nullable=False),
        sa.Column("pending_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fired_window_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fired_count", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("routine_id"),
    )
    op.create_index("ix_automation_state_pending", "automation_state", ["pending"])
    op.create_table(
        "automation_webhook_secrets",
        sa.Column("routine_id", sa.Text(), nullable=False),
        sa.Column("secret_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("routine_id"),
    )


def downgrade() -> None:
    op.drop_table("automation_webhook_secrets")
    op.drop_index("ix_automation_state_pending", table_name="automation_state")
    op.drop_table("automation_state")
    op.drop_index("ix_automation_outbox_claim", table_name="automation_outbox")
    op.drop_table("automation_outbox")
