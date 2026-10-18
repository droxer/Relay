"""Table definitions for persistence/daemon_store."""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    Table,
    Text,
    text,
)
from ..sql import database_id_column, entity_uuid_type, json_type, metadata

# Run requests in these states hold their thread (and task) exclusively.
ACTIVE_RUN_REQUEST_STATUSES = frozenset(
    {"prepared", "running", "dispatching", "finalizing"}
)


nodes = Table(
    "daemon_nodes",
    metadata,
    database_id_column(),
    Column(
        "user_id",
        entity_uuid_type(),
        ForeignKey(
            "users.id",
            ondelete="SET NULL",
            name="fk_daemon_nodes_user",
        ),
        nullable=True,
    ),
    Column("display_name", Text, nullable=True),
    Column("workspace_path", Text, nullable=True),
    Column("workspace_id", Text, nullable=True),
    Column("enrollment_key", Text, nullable=True),
    Column("sandbox_mode", Text, nullable=True),
    Column("node_location", Text, nullable=True),
    Column("managed_node_id", entity_uuid_type(), nullable=True),
    Column("provisioning_attempt_id", Text, nullable=True),
    Column("credential_version", Integer, nullable=False, default=1),
    Column("retired_at", DateTime(timezone=True), nullable=True),
    Column("status", Text, nullable=False),
    Column("capabilities", json_type(), nullable=True),
    Column("max_concurrent_runs", Integer, nullable=False, default=1),
    Column("ui_token_hash", Text, nullable=True),
    Column("node_token_hash", Text, nullable=True),
    # Legacy compatibility column, cleared by migration 0089. Always NULL.
    Column("node_token_secret", Text, nullable=True),
    Column("last_error", Text, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("last_seen_at", DateTime(timezone=True), nullable=True),
    Index("ix_daemon_nodes_user_id", "user_id"),
    # updated_at and last_seen_at are deliberately unindexed: every
    # heartbeat rewrites both, and leaving them out of every index is what
    # lets PostgreSQL apply that write as a HOT update.
    Index("ix_daemon_nodes_managed_node_id", "managed_node_id"),
    Index("ix_daemon_nodes_workspace_id", "workspace_id"),
    Index("ix_daemon_nodes_retired_at", "retired_at"),
    Index(
        "uq_daemon_nodes_local_enrollment",
        "enrollment_key",
        unique=True,
        postgresql_where=text(
            "enrollment_key IS NOT NULL AND managed_node_id IS NULL "
            "AND retired_at IS NULL"
        ),
        sqlite_where=text(
            "enrollment_key IS NOT NULL AND managed_node_id IS NULL "
            "AND retired_at IS NULL"
        ),
    ),
    # A Computer is (user_id, workspace_id) for a user device and
    # managed_node_id for a managed one -- never the daemon's own id, which
    # changes every time the daemon process is replaced.
    Index(
        "uq_daemon_nodes_computer",
        "user_id",
        "workspace_id",
        unique=True,
        postgresql_where=text("managed_node_id IS NULL AND retired_at IS NULL"),
        sqlite_where=text("managed_node_id IS NULL AND retired_at IS NULL"),
    ),
    Index(
        "uq_daemon_nodes_managed_runtime",
        "managed_node_id",
        unique=True,
        postgresql_where=text("managed_node_id IS NOT NULL AND retired_at IS NULL"),
        sqlite_where=text("managed_node_id IS NOT NULL AND retired_at IS NULL"),
    ),
)

# One row per agent a node knows about, replacing five parallel JSON maps
# (agents, agent_details, disabled_agents, agent_role_defaults,
# agent_role_overrides) that all keyed off the same agent name and had to be
# kept aligned by convention.
node_agents = Table(
    "daemon_node_agents",
    metadata,
    Column(
        "node_id",
        entity_uuid_type(),
        ForeignKey("daemon_nodes.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("agent", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("details", json_type(), nullable=True),
    Column("disabled", Boolean, nullable=False),
    Column("role_default", Text, nullable=True),
    Column("role_override", Text, nullable=True),
    PrimaryKeyConstraint("node_id", "agent", name="pk_daemon_node_agents"),
    # The point of normalizing: "which nodes can run codex" is an index
    # lookup instead of a scan over every node's JSON.
    Index("ix_daemon_node_agents_agent_status", "agent", "status"),
)

commands = Table(
    "daemon_commands",
    metadata,
    database_id_column(),
    Column(
        "node_id",
        entity_uuid_type(),
        ForeignKey("daemon_nodes.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("type", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("command", json_type(), nullable=False),
    Column("exit_code", Integer, nullable=True),
    Column("error", Text, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("dispatched_at", DateTime(timezone=True), nullable=True),
    Column("lease_id", Text, nullable=True),
    Column("lease_expires_at", DateTime(timezone=True), nullable=True),
    Column("attempt", Integer, nullable=False, default=0),
    Column("completed_at", DateTime(timezone=True), nullable=True),
    # Derived from command._runRequestId (text: legacy ids are not uuids).
    Column("run_request_id", Text, nullable=True),
    Index("ix_daemon_commands_node_status", "node_id", "status"),
    Index("ix_daemon_commands_created_at", "created_at"),
    Index("ix_daemon_commands_lease_expires_at", "lease_expires_at"),
    Index(
        "ix_daemon_commands_run_request_id",
        "run_request_id",
        postgresql_where=text("run_request_id IS NOT NULL"),
        sqlite_where=text("run_request_id IS NOT NULL"),
    ),
)

runs = Table(
    "daemon_runs",
    metadata,
    database_id_column(),
    Column(
        "node_id",
        entity_uuid_type(),
        ForeignKey("daemon_nodes.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column(
        "command_id",
        entity_uuid_type(),
        ForeignKey("daemon_commands.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("session_id", entity_uuid_type(), nullable=False),
    Column("agent", Text, nullable=False),
    Column("logical_agent_id", entity_uuid_type(), nullable=True),
    Column("placement_id", entity_uuid_type(), nullable=True),
    Column("task_goal", Text, nullable=False),
    Column("workspace_path", Text, nullable=True),
    Column("status", Text, nullable=False),
    Column("exit_code", Integer, nullable=True),
    Column("error", Text, nullable=True),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("completed_at", DateTime(timezone=True), nullable=True),
    Index("ix_daemon_runs_node_status", "node_id", "status"),
    Index("ix_daemon_runs_session_id", "session_id"),
    # Backs the ON DELETE SET NULL from daemon_commands (retention deletes
    # commands in bulk) and the run lookups by command.
    Index("ix_daemon_runs_command_id", "command_id"),
)

run_requests = Table(
    "daemon_run_requests",
    metadata,
    database_id_column(),
    Column(
        "node_id",
        entity_uuid_type(),
        ForeignKey("daemon_nodes.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("session_id", entity_uuid_type(), nullable=False),
    Column("task_id", entity_uuid_type(), nullable=True),
    Column("task_goal", Text, nullable=False),
    Column("assignments", json_type(), nullable=False),
    Column("current_index", Integer, nullable=False),
    Column("state", json_type(), nullable=False),
    Column("status", Text, nullable=False),
    Column("current_command_id", entity_uuid_type(), nullable=True),
    Column("current_run_id", entity_uuid_type(), nullable=True),
    Column("current_agent", Text, nullable=True),
    Column("current_started_at", DateTime(timezone=True), nullable=True),
    Column("current_progress_at", DateTime(timezone=True), nullable=True),
    Column("error", Text, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("recovery_after", DateTime(timezone=True), nullable=True),
    Column("completed_at", DateTime(timezone=True), nullable=True),
    Index("ix_daemon_run_requests_status", "status"),
    Index("ix_daemon_run_requests_node_status", "node_id", "status"),
    Index("ix_daemon_run_requests_session_id", "session_id"),
    Index("ix_daemon_run_requests_task_id", "task_id"),
)

Index(
    "uq_daemon_run_requests_active_session",
    run_requests.c.session_id,
    unique=True,
    postgresql_where=run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES),
    sqlite_where=run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES),
)

Index(
    "uq_daemon_run_requests_active_task",
    run_requests.c.task_id,
    unique=True,
    postgresql_where=(run_requests.c.task_id.is_not(None) & run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES)),
    sqlite_where=(run_requests.c.task_id.is_not(None) & run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES)),
)

events = Table(
    "daemon_events",
    metadata,
    database_id_column(),
    Column("node_id", entity_uuid_type(), nullable=True),
    Column("command_id", entity_uuid_type(), nullable=True),
    Column("run_id", entity_uuid_type(), nullable=True),
    Column("type", Text, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("payload", json_type(), nullable=False),
    Index("ix_daemon_events_node_id", "node_id"),
    Index("ix_daemon_events_command_id", "command_id"),
    Index("ix_daemon_events_timestamp", "timestamp"),
    Index("ix_daemon_events_type_timestamp", "type", "timestamp"),
)
