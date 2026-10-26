"""Record which operating system a computer's daemon runs on.

The daemon reports ``hostOs`` at registration so the web can mark a computer
macOS, Linux, or Windows. Existing rows start NULL and fill on the next
registration; a daemon that predates the field leaves it NULL.

Revision ID: 20261026_0104
Revises: 20261026_0103
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261026_0104"
down_revision = "20261026_0103"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("daemon_nodes", sa.Column("host_os", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("daemon_nodes", "host_os")
