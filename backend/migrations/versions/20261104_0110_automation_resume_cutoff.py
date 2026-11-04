"""Keep a resume's outbox cutoff across ticks and restarts.

Revision ID: 20261104_0110
Revises: 20261103_0109
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261104_0110"
down_revision = "20261103_0109"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("automation_state", sa.Column("events_after", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("automation_state", "events_after")
