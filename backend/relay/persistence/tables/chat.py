"""Table definitions for chat/integrations."""

from __future__ import annotations

from sqlalchemy import BigInteger, Column, DateTime, Index, Integer, Table, Text, UniqueConstraint
from ..sql import database_id_column, json_type, metadata


documents = Table(
    "chat_documents",
    metadata,
    database_id_column(),
    Column("document_key", Text, nullable=False, unique=True),
    Column("payload", json_type(), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)


# Sequence preserves append order even when timestamps tie or clocks move back.
audit_events = Table(
    "chat_audit_events",
    metadata,
    Column("sequence", BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True),
    Column("integration_id", Text, nullable=True),
    Column("payload", json_type(), nullable=False),
    Index("ix_chat_audit_events_integration_sequence", "integration_id", "sequence"),
)

conversations = Table(
    "chat_conversations",
    metadata,
    Column("sequence", BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True),
    Column("key_hash", Text, nullable=False),
    Column("conversation_key", Text, nullable=False),
    Column("session_id", Text, nullable=False),
    Column("payload", json_type(), nullable=False),
    UniqueConstraint("key_hash", name="uq_chat_conversations_key_hash"),
    Index("ix_chat_conversations_session", "session_id"),
)
