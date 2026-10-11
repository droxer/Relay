"""Store the admin bearer token's hash in the database.

The token used to live in ``<data dir>/auth/admin-token`` as plaintext, which
tied the backend to a persistent volume. The backend imports that file on its
first boot after this revision and deletes it; the database keeps only the
SHA-256.

Revision ID: 20261011_0090
Revises: 20261010_0089
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261011_0090"
down_revision = "20261010_0089"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "admin_tokens",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    # The imported file is gone and a hash cannot be turned back into one, so
    # an older backend must be re-seeded from RELAY_ADMIN_TOKEN after this.
    op.drop_table("admin_tokens")
