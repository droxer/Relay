"""Table definitions for persistence/notification_store."""

from __future__ import annotations

from sqlalchemy import Column, DateTime, Index, Table, Text
from ..sql import database_id_column, json_type, metadata


notifications = Table(
    "notifications", metadata,
    database_id_column(),
    Column("user_id", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("data", json_type(), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("read_at", DateTime(timezone=True), nullable=True),
    Index("ix_notifications_user_id_created_at", "user_id", "created_at"),
    Index("ix_notifications_created_at", "created_at"),
)

notification_watch_state = Table(
    "notification_watch_state", metadata,
    Column("subject_key", Text, primary_key=True),
    Column("state", Text, nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

notification_preferences = Table(
    "notification_preferences", metadata,
    Column("user_id", Text, primary_key=True),
    Column("muted_kinds", json_type(), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)
