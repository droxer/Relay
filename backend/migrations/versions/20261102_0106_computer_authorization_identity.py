"""Keep the installer's host identity through browser authorization.

Revision ID: 20261102_0106
Revises: 20261031_0105
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261102_0106"
down_revision = "20261031_0105"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("computer_authorizations", sa.Column("workspace_id", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("computer_authorizations", "workspace_id")
