"""Add the onboarding wizard's stored choices to auth accounts.

Progress through the wizard is derived on the client; this column keeps only
what a person chose (`relay/security/onboarding.py`). Every account that exists
before this migration is marked as having read the intro and dismissed the
wizard, so nobody already using Relay is greeted by a setup guide.

Revision ID: 20261016_0098
Revises: 20261016_0097
"""

from __future__ import annotations

from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261016_0098"
down_revision = "20261016_0097"
branch_labels = None
depends_on = None

JSON_TYPE = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.add_column("auth_accounts", sa.Column("onboarding", JSON_TYPE, nullable=True))
    stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    accounts = sa.table("auth_accounts", sa.column("onboarding", JSON_TYPE))
    op.execute(
        accounts.update().values(onboarding={"introSeenAt": stamp, "dismissedAt": stamp})
    )


def downgrade() -> None:
    op.drop_column("auth_accounts", "onboarding")
