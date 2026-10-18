"""Table definitions for persistence/skill_store."""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from ..sql import database_id_column, entity_uuid_type, json_type, metadata


skills = Table(
    "skills",
    metadata,
    database_id_column(),
    Column(
        "owner_user_id",
        entity_uuid_type(),
        ForeignKey("users.id", ondelete="RESTRICT", name="fk_skills_owner"),
        nullable=False,
    ),
    Column("namespace_key", Text, nullable=False),
    Column("name_key", Text, nullable=False),
    Column("slug", Text, nullable=False),
    Column("visibility", Text, nullable=False),
    Column("snapshot", json_type(), nullable=False),
    Column("event_version", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("deleted_at", DateTime(timezone=True), nullable=True),
    CheckConstraint(
        "visibility IN ('private', 'org')", name="ck_skills_visibility"
    ),
    Index("ix_skills_owner_updated", "owner_user_id", "updated_at"),
    Index(
        "uq_skills_live_slug",
        "slug",
        unique=True,
        postgresql_where=text("deleted_at IS NULL"),
        sqlite_where=text("deleted_at IS NULL"),
    ),
    Index(
        "uq_skills_live_owner_name",
        "owner_user_id",
        "namespace_key",
        "name_key",
        unique=True,
        postgresql_where=text("deleted_at IS NULL"),
        sqlite_where=text("deleted_at IS NULL"),
    ),
)

revisions = Table(
    "skill_revisions",
    metadata,
    database_id_column(),
    Column(
        "skill_id",
        entity_uuid_type(),
        ForeignKey("skills.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("revision", Integer, nullable=False),
    Column("manifest_sha256", Text, nullable=False),
    Column("bytes", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column(
        "created_by_user_id",
        entity_uuid_type(),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    ),
    Column("note", Text, nullable=True),
    CheckConstraint("revision > 0", name="ck_skill_revisions_positive"),
    CheckConstraint(
        "bytes >= 0 AND bytes <= 4194304", name="ck_skill_revisions_bytes"
    ),
    UniqueConstraint("skill_id", "revision", name="uq_skill_revisions_number"),
    Index("ix_skill_revisions_skill", "skill_id", "revision"),
)

blobs = Table(
    "skill_blobs",
    metadata,
    Column("sha256", Text, primary_key=True),
    # Bundle bytes live in SkillObjectStore. This nullable compatibility
    # column lets upgraded databases retain blobs written by older builds.
    Column("content", LargeBinary, nullable=True),
    Column("bytes", BigInteger, nullable=False),
    CheckConstraint("bytes >= 0 AND bytes <= 1048576", name="ck_skill_blobs_bytes"),
)

files = Table(
    "skill_files",
    metadata,
    database_id_column(),
    Column(
        "revision_id",
        entity_uuid_type(),
        ForeignKey("skill_revisions.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("path", Text, nullable=False),
    Column(
        "sha256",
        Text,
        ForeignKey("skill_blobs.sha256", ondelete="RESTRICT"),
        nullable=False,
    ),
    Column("bytes", BigInteger, nullable=False),
    CheckConstraint("bytes >= 0 AND bytes <= 1048576", name="ck_skill_files_bytes"),
    UniqueConstraint("revision_id", "path", name="uq_skill_files_path"),
    Index("ix_skill_files_sha256", "sha256"),
)

events_table = Table(
    "skill_events",
    metadata,
    database_id_column(),
    Column(
        "skill_id",
        entity_uuid_type(),
        ForeignKey("skills.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("sequence", BigInteger, nullable=False),
    Column("type", Text, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("payload", json_type(), nullable=False),
    UniqueConstraint("skill_id", "sequence", name="uq_skill_events_sequence"),
)

assignments = Table(
    "skill_assignments",
    metadata,
    database_id_column(),
    Column(
        "skill_id",
        entity_uuid_type(),
        ForeignKey("skills.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("target_type", Text, nullable=False),
    Column("target_id", Text, nullable=False),
    Column("mode", Text, nullable=False),
    Column("pin", json_type(), nullable=False),
    Column("invocation", Text, nullable=False),
    Column(
        "created_by_user_id",
        entity_uuid_type(),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    CheckConstraint(
        "target_type IN ('user', 'team', 'project', 'agent', 'org')",
        name="ck_skill_assignments_target_type",
    ),
    CheckConstraint(
        "mode IN ('optional', 'required', 'suggested')",
        name="ck_skill_assignments_mode",
    ),
    CheckConstraint(
        "invocation IN ('implicit', 'explicit')",
        name="ck_skill_assignments_invocation",
    ),
    UniqueConstraint(
        "skill_id",
        "target_type",
        "target_id",
        name="uq_skill_assignments_target",
    ),
    Index("ix_skill_assignments_target", "target_type", "target_id"),
    Index("ix_skill_assignments_skill", "skill_id"),
)
