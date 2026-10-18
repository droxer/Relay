"""Table definitions for persistence/managed_node_store."""

from __future__ import annotations

from sqlalchemy import Column, Index, Table, Text
from ..sql import json_type, metadata


records = Table(
    "managed_node_records",
    metadata,
    Column("kind", Text, primary_key=True),
    Column("id", Text, primary_key=True),
    Column("node_id", Text, nullable=True),
    Column("snapshot", json_type(), nullable=False),
    Index("ix_managed_node_records_kind_node", "kind", "node_id"),
)
