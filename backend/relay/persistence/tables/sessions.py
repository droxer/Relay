"""Table definitions for persistence/session_store."""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Table,
    Text,
    UniqueConstraint,
    text,
    true,
)
from ..sql import database_id_column, entity_uuid_type, json_type, metadata


sessions = Table(
    "sessions",
    metadata,
    database_id_column(),
    Column("workspace_path", Text, nullable=False),
    Column(
        "project_id",
        entity_uuid_type(),
        ForeignKey("projects.id", ondelete="RESTRICT", name="fk_sessions_project"),
        nullable=True,
    ),
    Column("owner_user_id", entity_uuid_type(), nullable=True),
    Column("title", Text, nullable=True),
    Column("task_goal", Text, nullable=False),
    Column("participants", json_type(), nullable=False),
    Column("status", Text, nullable=False),
    Column("phase", Text, nullable=False),
    Column("pending_decision", Text, nullable=True),
    Column("current_agent", Text, nullable=True),
    Column("final_outcome", json_type(), nullable=True),
    Column("snapshot", json_type(), nullable=False),
    Column("version", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    # Derived from snapshot.deletionRequestedAt so the deletion sweep can
    # find its few rows without reading every snapshot.
    Column("deletion_requested_at", DateTime(timezone=True), nullable=True),
    Index("ix_sessions_updated_at", "updated_at"),
    Index("ix_sessions_created_at", "created_at"),
    Index("ix_sessions_project_id", "project_id"),
    Index("ix_sessions_owner_updated_at", "owner_user_id", "updated_at"),
    Index(
        "ix_sessions_pending_deletion",
        "updated_at",
        "id",
        postgresql_where=text("deletion_requested_at IS NOT NULL"),
        sqlite_where=text("deletion_requested_at IS NOT NULL"),
    ),
)

events = Table(
    "session_events",
    metadata,
    database_id_column(),
    Column(
        "session_id",
        entity_uuid_type(),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("sequence", BigInteger, nullable=False),
    Column("type", Text, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("payload", json_type(), nullable=False),
    # The unique (session_id, sequence) index serves every per-session
    # read and the FK cascade; nothing reads events by time or type.
    UniqueConstraint(
        "session_id", "sequence", name="uq_session_events_session_sequence"
    ),
    # A stream reconnect resumes from an event id (``Last-Event-ID``), which
    # lives in the payload; migration 0077 built this on Postgres and the
    # declaration here keeps SQLite (3.38+ has ``->>``) and the drift test on
    # the same schema.
    Index("ix_session_events_cursor", "session_id", text("(payload ->> 'id')")),
)

artifacts = Table(
    "session_artifacts",
    metadata,
    database_id_column(),
    Column(
        "session_id",
        entity_uuid_type(),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("agent_run_id", Text, nullable=True),
    Column("kind", Text, nullable=False),
    Column("title", Text, nullable=False),
    Column("path", Text, nullable=True),
    Column("content", Text, nullable=True),
    Column("content_type", Text, nullable=True),
    Column("byte_size", BigInteger, nullable=False),
    Column("metadata", json_type(), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_session_artifacts_session_id", "session_id"),
)

run_token_usage = Table(
    "session_run_token_usage",
    metadata,
    database_id_column(),
    # No FK to sessions: rows are retained after the originating thread
    # is permanently deleted so token-usage history survives.
    Column("session_id", entity_uuid_type(), nullable=False),
    Column("run_id", Text, nullable=False),
    Column("owner_user_id", entity_uuid_type(), nullable=True),
    Column("task_goal", Text, nullable=True),
    Column("input_tokens", BigInteger, nullable=False),
    Column("output_tokens", BigInteger, nullable=False),
    Column("cache_tokens", BigInteger, nullable=False),
    Column("total_tokens", BigInteger, nullable=False),
    # cache_tokens split; cache_tokens = cache_read + cache_write.
    Column("cache_read_tokens", BigInteger, nullable=False, server_default="0"),
    Column("cache_write_tokens", BigInteger, nullable=False, server_default="0"),
    # The executor kind that ran, so the dashboard can name runtimes that
    # completed without reporting usage.
    Column("agent", Text, nullable=True),
    # False for a completed run whose runtime reported no counts; its
    # token columns are zero.
    Column("reported", Boolean, nullable=False, server_default=true()),
    Column("completed_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint(
        "session_id", "run_id", name="uq_session_run_token_usage_session_run"
    ),
    Index("ix_session_run_token_usage_completed_at", "completed_at"),
    Index("ix_session_run_token_usage_owner_user_id", "owner_user_id"),
)

agent_runs = Table(
    "session_agent_runs",
    metadata,
    database_id_column(),
    # No FK: the fact that an agent has run must survive thread deletion.
    Column("session_id", entity_uuid_type(), nullable=False),
    Column("run_id", Text, nullable=False),
    Column("logical_agent_id", Text, nullable=True),
    Column("placement_id", Text, nullable=True),
    UniqueConstraint("session_id", "run_id", name="uq_session_agent_runs_run"),
    Index("ix_session_agent_runs_logical_agent", "logical_agent_id"),
    Index("ix_session_agent_runs_placement", "placement_id"),
)

# One row per (thread, workspace file): the newest workspace_file artifact
# for that path. It is a projection of artifact.created events, kept so the
# artifact index is an indexed range read instead of a walk over every
# session snapshot's artifact array.
workspace_files = Table(
    "session_workspace_files",
    metadata,
    Column(
        "session_id",
        entity_uuid_type(),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("file_key", Text, primary_key=True),
    Column("artifact_id", Text, nullable=True),
    Column("owner_user_id", entity_uuid_type(), nullable=True),
    Column("workspace_path", Text, nullable=False),
    # A missing or unreadable createdAt ranks oldest (the epoch), matching
    # helpers.workspace_artifacts, so the column is never NULL.
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("artifact", json_type(), nullable=False),
    Index(
        "ix_session_workspace_files_owner_recent",
        "owner_user_id",
        "created_at",
    ),
    Index(
        "ix_session_workspace_files_workspace_recent",
        "workspace_path",
        "created_at",
    ),
    Index("ix_session_workspace_files_recent", "created_at"),
)

tombstones = Table(
    "session_tombstones",
    metadata,
    database_id_column(),
    Column("session_id", entity_uuid_type(), nullable=False),
    Column("task_goal", Text, nullable=False),
    Column("title", Text, nullable=True),
    Column("owner_user_id", entity_uuid_type(), nullable=True),
    Column("deleted_by", Text, nullable=True),
    Column("deleted_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("session_id", name="uq_session_tombstones_session"),
)
