"""Let a person clear notices from their inbox.

``cleared_at`` hides a notice instead of deleting it, so replaying a
deduplicated notice (same id) cannot bring a cleared one back. Existing rows
start uncleared; the watcher's 90-day prune removes cleared rows with the rest.

Revision ID: 20261026_0103
Revises: 20261025_0102
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261026_0103"
down_revision = "20261025_0102"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("notifications", sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("notifications", "cleared_at")
