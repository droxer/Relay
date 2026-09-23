"""Persist daemon capabilities across backend restarts and replicas.

Existing nodes acquire capabilities on their next daemon registration. Do not
infer support from liveness or grant capabilities to older daemon versions.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260924_0080"
down_revision = "20260921_0079"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "daemon_nodes",
        sa.Column(
            "capabilities",
            sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("daemon_nodes", "capabilities")
