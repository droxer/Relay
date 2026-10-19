"""Record when a daemon last took commands.

``daemon_nodes.last_poll_at`` is advanced by every command poll and cleared by
a draining heartbeat. Liveness (``last_seen_at``) says the daemon is alive;
this says it is listening for work, which is what dispatch admission needs.
Like the other liveness columns it is unindexed so the write stays HOT.

Revision ID: 20261019_0100
Revises: 20261016_0099
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261019_0100"
down_revision = "20261016_0099"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "daemon_nodes",
        sa.Column("last_poll_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("daemon_nodes", "last_poll_at")
