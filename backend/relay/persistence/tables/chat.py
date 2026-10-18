"""Table definitions for chat/integrations."""

from __future__ import annotations

from sqlalchemy import Column, DateTime, Table, Text
from ..sql import database_id_column, json_type, metadata


documents = Table(
    "chat_documents",
    metadata,
    database_id_column(),
    Column("document_key", Text, nullable=False, unique=True),
    Column("payload", json_type(), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)
