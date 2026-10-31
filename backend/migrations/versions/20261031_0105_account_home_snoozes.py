"""Add the Home queue's snoozed items to auth accounts.

Home's "Up next" queue is derived on the client; this column keeps only which
items a person snoozed and the stamp each had (`relay/security/home_snoozes.py`).
Existing accounts start NULL — nothing snoozed.

Revision ID: 20261031_0105
Revises: 20261026_0104
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261031_0105"
down_revision = "20261026_0104"
branch_labels = None
depends_on = None

JSON_TYPE = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.add_column("auth_accounts", sa.Column("home_snoozes", JSON_TYPE, nullable=True))


def downgrade() -> None:
    op.drop_column("auth_accounts", "home_snoozes")
