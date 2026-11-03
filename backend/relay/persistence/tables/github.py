"""Encrypted account connections and short-lived GitHub authorization state."""

from sqlalchemy import Column, Float, ForeignKey, Index, Table, Text

from ..sql import entity_uuid_type, metadata

connections = Table(
    "account_github_connections", metadata,
    Column("account_id", entity_uuid_type(), ForeignKey("auth_accounts.id", ondelete="CASCADE"), primary_key=True),
    Column("sealed_secret", Text, nullable=False),
)

states = Table(
    "account_github_states", metadata,
    Column("state_hash", Text, primary_key=True),
    Column("account_id", entity_uuid_type(), ForeignKey("auth_accounts.id", ondelete="CASCADE"), nullable=False),
    Column("sealed_secret", Text, nullable=False),
    Column("expires_at", Float, nullable=False),
    Index("ix_account_github_states_account_id", "account_id"),
    Index("ix_account_github_states_expires_at", "expires_at"),
)
