"""Per-user task capacity overrides; null inherits the default of five.

Revision ID: 20261104_0112
Revises: 20261104_0111
"""

from alembic import op
import sqlalchemy as sa

revision = "20261104_0112"
down_revision = "20261104_0111"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("max_concurrent_tasks", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "max_concurrent_tasks")
