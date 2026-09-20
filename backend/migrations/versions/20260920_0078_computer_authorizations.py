"""Short-lived browser-approved Computer enrollment grants."""
from alembic import op
import sqlalchemy as sa

revision = "20260920_0078"
down_revision = "20260917_0077"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("computer_authorizations",
        sa.Column("device_hash", sa.Text(), primary_key=True),
        sa.Column("user_code", sa.Text(), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("workspace_path", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("node_id", sa.Text(), nullable=True),
        sa.Column("employee_id", sa.Text(), nullable=True))
    op.create_index("ix_computer_authorizations_expires", "computer_authorizations", ["expires_at"])


def downgrade() -> None:
    op.drop_table("computer_authorizations")
