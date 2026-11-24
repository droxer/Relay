"""Table definitions for persistence/notification_store."""

from __future__ import annotations

from sqlalchemy import Column, DateTime, Index, Table, Text, text
from ..sql import database_id_column, json_type, metadata


notifications = Table(
    "notifications", metadata,
    database_id_column(),
    Column("user_id", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("data", json_type(), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("read_at", DateTime(timezone=True), nullable=True),
    # Cleared notices stay as rows so a replayed dedupe key cannot bring
    # them back; the watcher prunes them with the rest.
    Column("cleared_at", DateTime(timezone=True), nullable=True),
    Index("ix_notifications_visible_recency", "user_id", "created_at", "id",
          postgresql_where=text("cleared_at IS NULL"), sqlite_where=text("cleared_at IS NULL")),
    Index("ix_notifications_unread", "user_id", "kind",
          postgresql_where=text("cleared_at IS NULL AND read_at IS NULL"),
          sqlite_where=text("cleared_at IS NULL AND read_at IS NULL")),
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
