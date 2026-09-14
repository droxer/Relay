"""store skill bundle objects outside the relational database

Revision ID: 20260915_0072
Revises: 20260914_0071
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260915_0072"
down_revision = "20260914_0071"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "skill_blobs",
        "content",
        existing_type=sa.LargeBinary(),
        nullable=True,
    )


def downgrade() -> None:
    # A downgrade cannot reconstruct file-backed content in SQL. Refuse to
    # claim NOT NULL compatibility when any new-style metadata row exists.
    connection = op.get_bind()
    missing = connection.scalar(
        sa.text("SELECT COUNT(*) FROM skill_blobs WHERE content IS NULL")
    )
    if missing:
        raise RuntimeError(
            "cannot downgrade while file-backed skill objects exist"
        )
    op.alter_column(
        "skill_blobs",
        "content",
        existing_type=sa.LargeBinary(),
        nullable=False,
    )
