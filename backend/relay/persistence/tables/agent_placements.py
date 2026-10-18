"""Table definitions for persistence/agent_placement_store."""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
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


placements = Table(
    "agent_placements",
    metadata,
    database_id_column(),
    Column(
        "agent_id",
        entity_uuid_type(),
        ForeignKey(
            "agents.id", ondelete="CASCADE", name="fk_agent_placements_agent"
        ),
        nullable=False,
        index=True,
    ),
    Column(
        "supervisor_user_id",
        entity_uuid_type(),
        ForeignKey(
            "users.id",
            ondelete="RESTRICT",
            name="fk_agent_placements_supervisor_user",
        ),
        nullable=False,
        index=True,
    ),
    Column(
        "daemon_node_id",
        entity_uuid_type(),
        ForeignKey(
            "daemon_nodes.id",
            ondelete="CASCADE",
            name="fk_agent_placements_node",
        ),
        nullable=False,
        index=True,
    ),
    Column("executor_kind", Text, nullable=False),
    Column("desired_state", Text, nullable=False),
    Column("priority", BigInteger, nullable=False),
    Column("agent_version", BigInteger, nullable=False),
    Column("snapshot", json_type(), nullable=False),
    Column("event_version", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    # An agent has at most one live placement per node. Previously held only
    # by the advisory row lock taken in create_placement/rebind_placement.
    Index(
        "uq_agent_placements_live_agent_node",
        "agent_id",
        "daemon_node_id",
        unique=True,
        postgresql_where=text("desired_state <> 'removed'"),
        sqlite_where=text("desired_state <> 'removed'"),
    ),
)

events_table = Table(
    "agent_placement_events",
    metadata,
    database_id_column(),
    Column(
        "placement_id",
        entity_uuid_type(),
        ForeignKey("agent_placements.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("sequence", BigInteger, nullable=False),
    Column("type", Text, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("payload", json_type(), nullable=False),
    UniqueConstraint(
        "placement_id", "sequence", name="uq_agent_placement_events_sequence"
    ),
)
