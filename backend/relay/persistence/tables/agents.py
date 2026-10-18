"""Table definitions for persistence/agent_store."""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from ..sql import database_id_column, entity_uuid_type, json_type, metadata


agents = Table(
    "agents",
    metadata,
    database_id_column(),
    Column(
        "supervisor_user_id",
        entity_uuid_type(),
        ForeignKey(
            "users.id",
            ondelete="RESTRICT",
            name="fk_agents_supervisor_user",
        ),
        nullable=False,
        index=True,
    ),
    Column("display_name", Text, nullable=False),
    Column("display_name_key", Text, nullable=True),
    Column("executor_kind", Text, nullable=False),
    # Mirrors snapshot.modelPolicy.model; NULL is the runtime default.
    Column("model", Text, nullable=True),
    Column("compatibility_key", Text, nullable=True),
    Column("enabled", Boolean, nullable=False),
    Column("agent_version", BigInteger, nullable=False),
    Column("snapshot", json_type(), nullable=False),
    Column("event_version", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("deleted_at", DateTime(timezone=True), nullable=True),
    # Uniqueness applies to a user's *live* agents. Deleting used to
    # mean nulling display_name_key and dropping compatibility_key so the
    # row escaped a whole-table constraint; the predicate says it directly,
    # so both key columns are now written unconditionally.
    Index(
        "uq_agents_live_supervisor_display_name",
        "supervisor_user_id",
        "display_name_key",
        unique=True,
        postgresql_where=text("deleted_at IS NULL"),
        sqlite_where=text("deleted_at IS NULL"),
    ),
    Index(
        "uq_agents_live_compatibility_key",
        "compatibility_key",
        unique=True,
        postgresql_where=text(
            "deleted_at IS NULL AND compatibility_key IS NOT NULL"
        ),
        sqlite_where=text("deleted_at IS NULL AND compatibility_key IS NOT NULL"),
    ),
)

events_table = Table(
    "agent_events",
    metadata,
    database_id_column(),
    Column(
        "agent_id",
        entity_uuid_type(),
        ForeignKey("agents.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("sequence", BigInteger, nullable=False),
    Column("type", Text, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("payload", json_type(), nullable=False),
    UniqueConstraint(
        "agent_id", "sequence", name="uq_user_agent_events_sequence"
    ),
)
