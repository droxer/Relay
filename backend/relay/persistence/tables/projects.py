"""Table definitions for persistence/project_store."""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from ..sql import database_id_column, entity_uuid_type, json_type, metadata


projects = Table(
    "projects",
    metadata,
    database_id_column(),
    Column(
        "owner_user_id",
        entity_uuid_type(),
        ForeignKey("users.id", ondelete="RESTRICT", name="fk_projects_owner"),
        nullable=False,
    ),
    Column("name", Text, nullable=False),
    Column("name_key", Text, nullable=False),
    Column("computer_id", Text, nullable=False),
    Column("workspace_subpath", Text, nullable=False),
    Column("lead_agent_id", entity_uuid_type(), nullable=True),
    Column("enabled", Boolean, nullable=False),
    Column("snapshot", json_type(), nullable=False),
    Column("event_version", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("archived_at", DateTime(timezone=True), nullable=True),
    Index("ix_projects_owner_updated", "owner_user_id", "updated_at"),
    Index(
        "uq_projects_live_owner_name",
        "owner_user_id",
        "name_key",
        unique=True,
        postgresql_where=text("archived_at IS NULL"),
        sqlite_where=text("archived_at IS NULL"),
    ),
)

members = Table(
    "project_members",
    metadata,
    database_id_column(),
    Column(
        "project_id",
        entity_uuid_type(),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    ),
    # Agent storage is file-backed in the default local deployment, so this
    # projection deliberately does not own a database FK to agents.
    Column("agent_id", entity_uuid_type(), nullable=False),
    Column("role", Text, nullable=False),
    Column("responsibilities", Text, nullable=False),
    Column("instructions", Text, nullable=True),
    Column("enabled", Boolean, nullable=False),
    Column("position", Integer, nullable=False),
    UniqueConstraint("project_id", "agent_id", name="uq_project_members_agent"),
    Index("ix_project_members_agent", "agent_id"),
)

events_table = Table(
    "project_events",
    metadata,
    database_id_column(),
    Column(
        "project_id",
        entity_uuid_type(),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("sequence", BigInteger, nullable=False),
    Column("type", Text, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("payload", json_type(), nullable=False),
    UniqueConstraint("project_id", "sequence", name="uq_project_events_sequence"),
)
