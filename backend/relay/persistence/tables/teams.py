"""Table definitions for persistence/team_store."""

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


teams = Table(
    "teams",
    metadata,
    database_id_column(),
    Column(
        "owner_user_id",
        entity_uuid_type(),
        ForeignKey(
            "users.id",
            ondelete="RESTRICT",
            name="fk_teams_owner_user",
        ),
        nullable=False,
        index=True,
    ),
    Column("name", Text, nullable=False),
    Column("name_key", Text, nullable=True),
    Column("lead_agent_id", entity_uuid_type(), nullable=True),
    Column("member_agent_ids", json_type(), nullable=False),
    Column("enabled", Boolean, nullable=False),
    Column("snapshot", json_type(), nullable=False),
    Column("event_version", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("deleted_at", DateTime(timezone=True), nullable=True),
    # Uniqueness applies to an owner's *live* teams; see agent_store for
    # why the casefolded key column is kept rather than an expression index.
    Index(
        "uq_teams_live_owner_name",
        "owner_user_id",
        "name_key",
        unique=True,
        postgresql_where=text("deleted_at IS NULL"),
        sqlite_where=text("deleted_at IS NULL"),
    ),
)

events_table = Table(
    "team_events",
    metadata,
    database_id_column(),
    Column(
        "team_id",
        entity_uuid_type(),
        ForeignKey("teams.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("sequence", BigInteger, nullable=False),
    Column("type", Text, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("payload", json_type(), nullable=False),
    UniqueConstraint("team_id", "sequence", name="uq_team_events_sequence"),
)
