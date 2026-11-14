"""Add ``user_tags``: the tags a person saved, used or not.

Revision ID: 20261114_0127
Revises: 20261113_0126

Tags on work stay in Task and Automation snapshots; this table keeps the names
a person saved in their tag catalog so an unused one survives. It is new and
empty: tags already on work are discovered from those snapshots on read, so
nothing is backfilled. Downgrade drops the table and with it only the saved
names no record uses; every tag on work is untouched.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261114_0127"
down_revision = "20261113_0126"
branch_labels = None
depends_on = None

TABLE = "user_tags"


def _uuid() -> sa.types.TypeEngine:
    return sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table(TABLE):
        return
    op.create_table(
        TABLE,
        sa.Column("user_id", _uuid(), nullable=False),
        sa.Column("name_key", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], ondelete="CASCADE", name="fk_user_tags_user"
        ),
        sa.PrimaryKeyConstraint("user_id", "name_key", name="pk_user_tags"),
    )


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table(TABLE):
        op.drop_table(TABLE)
