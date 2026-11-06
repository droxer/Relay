"""User-owned service authorizations, bounded work grants and audit history."""

from sqlalchemy import Column, Float, Index, Integer, Table, Text

from ..sql import database_id_column, json_type, metadata

connections = Table("service_connections", metadata,
    database_id_column(), Column("owner_user_id", Text, nullable=False),
    Column("record", json_type(), nullable=False), Column("sealed_secret", Text, nullable=True),
    Index("ix_service_connections_owner", "owner_user_id"))

states = Table("service_connection_states", metadata,
    Column("state_hash", Text, primary_key=True), Column("owner_user_id", Text, nullable=False),
    Column("sealed_secret", Text, nullable=False), Column("expires_at", Float, nullable=False),
    Index("ix_service_connection_states_expiry", "expires_at"))

grants = Table("service_connection_grants", metadata,
    database_id_column(), Column("owner_user_id", Text, nullable=False),
    Column("target_type", Text, nullable=False), Column("target_id", Text, nullable=False),
    Column("record", json_type(), nullable=False),
    Index("ix_service_connection_grants_target", "owner_user_id", "target_type", "target_id"))

events = Table("service_connection_events", metadata,
    database_id_column(), Column("owner_user_id", Text, nullable=False),
    Column("aggregate_id", Text, nullable=False), Column("sequence", Integer, nullable=False),
    Column("record", json_type(), nullable=False),
    Index("ix_service_connection_events_aggregate", "aggregate_id", "sequence", unique=True))
