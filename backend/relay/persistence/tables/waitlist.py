"""Table definitions for persistence/waitlist_store."""

from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Index,
    Table,
    Text,
)
from ..sql import database_id_column, metadata


entries = Table(
    "waitlist_entries",
    metadata,
    database_id_column(),
    Column("email", Text, nullable=False, unique=True),
    Column("name", Text, nullable=True),
    Column("company", Text, nullable=True),
    Column("role", Text, nullable=True),
    Column("use_case", Text, nullable=True),
    Column("source", Text, nullable=True),
    Column("locale", Text, nullable=True),
    Column("status", Text, nullable=False),
    Column("invite_token_hash", Text, nullable=True, unique=True),
    Column("invite_expires_at", DateTime(timezone=True), nullable=True),
    Column("invited_at", DateTime(timezone=True), nullable=True),
    # Plain text, not foreign keys: under the file auth store these ids
    # name accounts and users that have no database row.
    Column("invited_by_user_id", Text, nullable=True),
    Column("account_id", Text, nullable=True),
    Column("admin_note", Text, nullable=True),
    Column("last_delivery_status", Text, nullable=True),
    Column("last_delivery_error", Text, nullable=True),
    Column("last_delivered_at", DateTime(timezone=True), nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    CheckConstraint(
        "status IN ('waiting', 'invited', 'joined', 'declined')",
        name="ck_waitlist_entries_status",
    ),
    Index("ix_waitlist_entries_status_created_at", "status", "created_at"),
)
