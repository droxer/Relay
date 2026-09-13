"""add the event-sourced skill catalog

Revision ID: 20260914_0070
Revises: 20260913_0069
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260914_0070"
down_revision = "20260913_0069"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "skills",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_employee_id", sa.Uuid(), nullable=False),
        sa.Column("namespace_key", sa.Text(), nullable=False),
        sa.Column("name_key", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("visibility", sa.Text(), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("event_version", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "visibility IN ('private', 'org')", name="ck_skills_visibility"
        ),
        sa.ForeignKeyConstraint(
            ["owner_employee_id"],
            ["employees.id"],
            name="fk_skills_owner",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_skills_owner_updated", "skills", ["owner_employee_id", "updated_at"]
    )
    op.create_index(
        "uq_skills_live_slug",
        "skills",
        ["slug"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index(
        "uq_skills_live_owner_name",
        "skills",
        ["owner_employee_id", "namespace_key", "name_key"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_table(
        "skill_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("skill_id", sa.Uuid(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("manifest_sha256", sa.Text(), nullable=False),
        sa.Column("bytes", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Uuid(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint("revision > 0", name="ck_skill_revisions_positive"),
        sa.CheckConstraint(
            "bytes >= 0 AND bytes <= 4194304", name="ck_skill_revisions_bytes"
        ),
        sa.ForeignKeyConstraint(["skill_id"], ["skills.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["created_by_employee_id"], ["employees.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("skill_id", "revision", name="uq_skill_revisions_number"),
    )
    op.create_index(
        "ix_skill_revisions_skill", "skill_revisions", ["skill_id", "revision"]
    )
    op.create_table(
        "skill_blobs",
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("bytes", sa.BigInteger(), nullable=False),
        sa.CheckConstraint(
            "bytes >= 0 AND bytes <= 1048576", name="ck_skill_blobs_bytes"
        ),
        sa.PrimaryKeyConstraint("sha256"),
    )
    op.create_table(
        "skill_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("bytes", sa.BigInteger(), nullable=False),
        sa.CheckConstraint(
            "bytes >= 0 AND bytes <= 1048576", name="ck_skill_files_bytes"
        ),
        sa.ForeignKeyConstraint(
            ["revision_id"], ["skill_revisions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["sha256"], ["skill_blobs.sha256"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("revision_id", "path", name="uq_skill_files_path"),
    )
    op.create_index("ix_skill_files_sha256", "skill_files", ["sha256"])
    op.create_table(
        "skill_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("skill_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(["skill_id"], ["skills.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("skill_id", "sequence", name="uq_skill_events_sequence"),
    )


def downgrade() -> None:
    op.drop_table("skill_events")
    op.drop_index("ix_skill_files_sha256", table_name="skill_files")
    op.drop_table("skill_files")
    op.drop_table("skill_blobs")
    op.drop_index("ix_skill_revisions_skill", table_name="skill_revisions")
    op.drop_table("skill_revisions")
    op.drop_index("uq_skills_live_owner_name", table_name="skills")
    op.drop_index("uq_skills_live_slug", table_name="skills")
    op.drop_index("ix_skills_owner_updated", table_name="skills")
    op.drop_table("skills")
