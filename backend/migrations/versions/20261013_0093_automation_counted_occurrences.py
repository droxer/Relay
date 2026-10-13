"""Remember which occurrences fed an automation's failure streak.

The streak counts finished occurrences, once each: a retried occurrence that
blocks again must not count twice. ``counted_occurrence_ids`` keeps the most
recent few (``MAX_COUNTED_OCCURRENCES``) as a JSON list. A single
last-occurrence column would forget an older occurrence as soon as a newer
one finished, and a retry of that older one would count again.

Nullable, so existing rows need no backfill; NULL reads as an empty list.

Revision ID: 20261013_0093
Revises: 20261013_0092
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261013_0093"
down_revision = "20261013_0092"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.add_column("automation_state", sa.Column("counted_occurrence_ids", JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("automation_state", "counted_occurrence_ids")
