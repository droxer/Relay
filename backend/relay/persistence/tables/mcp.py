"""Revocable Relay MCP API credentials. Only token digests are stored."""
from sqlalchemy import Column, DateTime, ForeignKey, Index, Table, Text
from ..sql import database_id_column, entity_uuid_type, json_type, metadata

mcp_tokens = Table(
    "mcp_tokens", metadata, database_id_column(),
    Column("owner_user_id", entity_uuid_type(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("name", Text, nullable=False),
    Column("token_hash", Text, nullable=False, unique=True),
    Column("computer_id", Text),
    Column("project_ids", json_type()),
    Column("command_id", Text),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("revoked_at", DateTime(timezone=True)),
    Index("ix_mcp_tokens_owner", "owner_user_id", "created_at"),
)
