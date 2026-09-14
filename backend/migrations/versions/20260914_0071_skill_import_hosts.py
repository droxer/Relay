"""Add the administrator-controlled skill import host allowlist."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260914_0071"
down_revision = "20260914_0070"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("org_settings", sa.Column(
        "skill_import_allowed_hosts",
        sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
        nullable=False, server_default='["github.com"]',
    ))


def downgrade():
    op.drop_column("org_settings", "skill_import_allowed_hosts")
