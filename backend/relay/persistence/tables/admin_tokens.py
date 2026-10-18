"""Table definitions for persistence/admin_token_store."""

from __future__ import annotations

from sqlalchemy import Column, DateTime, Table, Text
from ..sql import metadata


tokens = Table(
    "admin_tokens",
    metadata,
    Column("id", Text, primary_key=True),
    Column("token_hash", Text, nullable=False),
    Column("issued_at", DateTime(timezone=True), nullable=False),
)
