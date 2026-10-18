"""Table definitions for persistence/session_output_compaction."""

from __future__ import annotations

from sqlalchemy import (
    Column,
    DateTime,
    Table,
    Text,
)
from ..sql import json_type, metadata


maintenance_cursors = Table(
    "maintenance_cursors",
    metadata,
    Column("name", Text, primary_key=True),
    Column("position", json_type(), nullable=True),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)
