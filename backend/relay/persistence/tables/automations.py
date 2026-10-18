"""Table definitions for persistence/automation_store."""

from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, Table, Text
from ..sql import database_id_column, json_type, metadata


automation_outbox = Table(
    "automation_outbox", metadata,
    database_id_column(),
    Column("kind", Text, nullable=False),
    Column("event_type", Text, nullable=False),
    Column("source_type", Text, nullable=True),
    Column("source_id", Text, nullable=True),
    Column("target_routine_id", Text, nullable=True),
    Column("payload", json_type(), nullable=False),
    Column("origin_automation_id", Text, nullable=True),
    Column("depth", Integer, nullable=False, default=0),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("claimed_at", DateTime(timezone=True), nullable=True),
    Index("ix_automation_outbox_claim", "claimed_at", "created_at"),
)

automation_state = Table(
    "automation_state", metadata,
    Column("routine_id", Text, primary_key=True),
    Column("pending", Boolean, nullable=False, default=False),
    Column("pending_events", json_type(), nullable=False),
    Column("pending_dropped", Integer, nullable=False, default=0),
    Column("pending_since", DateTime(timezone=True), nullable=True),
    Column("fired_window_start", DateTime(timezone=True), nullable=True),
    Column("fired_count", Integer, nullable=False, default=0),
    Column("consecutive_failures", Integer, nullable=False, default=0),
    Column("counted_occurrence_ids", json_type(), nullable=True),
    Index("ix_automation_state_pending", "pending"),
)

automation_webhook_secrets = Table(
    "automation_webhook_secrets", metadata,
    Column("routine_id", Text, primary_key=True),
    Column("secret_hash", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)
