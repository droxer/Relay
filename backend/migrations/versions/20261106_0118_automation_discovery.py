"""Persist bounded automation scans and broadcast routing progress.

Revision ID: 20261106_0118
Revises: 20261106_0117

Stop old backend/worker processes before upgrade. Downgrade requires completed
broadcast routing; otherwise old code would redeliver already visited pages.
"""

from alembic import op
import sqlalchemy as sa

revision = "20261106_0118"
down_revision = "20261106_0117"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("automation_scan_cursors",
        sa.Column("name", sa.Text(), primary_key=True),
        sa.Column("after_id", sa.Text(), nullable=True),
    )
    for name in ("routing_before", "routing_after_created_at", "routed_at"):
        op.add_column("automation_outbox", sa.Column(name, sa.DateTime(timezone=True), nullable=True))
    op.add_column("automation_outbox", sa.Column("routing_after_id", sa.Text(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if conn.scalar(sa.text("SELECT 1 FROM automation_outbox WHERE routing_after_id IS NOT NULL LIMIT 1")):
        raise RuntimeError("Finish partial automation broadcast routing with the new workers before downgrade.")
    for name in ("routing_before", "routing_after_created_at", "routing_after_id", "routed_at"):
        op.drop_column("automation_outbox", name)
    op.drop_table("automation_scan_cursors")
