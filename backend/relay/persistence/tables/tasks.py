"""Table definitions for persistence/task_store."""

from __future__ import annotations

from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from ..sql import database_id_column, entity_uuid_type, json_type, metadata

def routine_index_where(dialect: str, *extra: str) -> Any:
    """Partial-index predicate spelled exactly as the store queries render it
    (`IS true` on Postgres, `IS 1` on SQLite), or the planner cannot match it."""
    true = "true" if dialect == "postgresql" else "1"
    terms = [
        f"is_routine IS {true}",
        "routine_state = 'active'",
        "deleted_at IS NULL",
        *(term.format(true=true) for term in extra),
    ]
    return text(" AND ".join(terms))


tasks = Table(
    "tasks",
    metadata,
    database_id_column(),
    Column("title", Text, nullable=False),
    Column("description", Text, nullable=False),
    Column("priority", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("assigned_agent", Text, nullable=True),
    Column("assigned_agent_id", entity_uuid_type(), nullable=True),
    Column("assigned_team_id", entity_uuid_type(), nullable=True),
    Column(
        "project_id",
        entity_uuid_type(),
        ForeignKey("projects.id", ondelete="RESTRICT", name="fk_tasks_project"),
        nullable=True,
    ),
    Column("owner_user_id", entity_uuid_type(), nullable=True),
    Column("assignee_user_id", entity_uuid_type(), nullable=True),
    Column("due_date", Date, nullable=True),
    Column("is_routine", Boolean, nullable=False, default=False),
    Column("routine_type", Text, nullable=True),
    Column("routine_cadence", Text, nullable=True),
    Column("routine_next_run_date", Date, nullable=True),
    Column("routine_enabled", Boolean, nullable=False, default=False),
    Column("routine_trigger_kind", Text, nullable=True),
    Column("routine_next_run_at", DateTime(timezone=True), nullable=True),
    Column("routine_state", Text, nullable=True),
    Column("routine_listens", Boolean, nullable=False, default=False),
    Column("routine_has_schedule", Boolean, nullable=False, default=False),
    Column("number_scope", Text, nullable=True),
    Column("number", Integer, nullable=True),
    Column("dispatch_failure_count", Integer, nullable=False, default=0),
    Column("dispatch_next_attempt_at", DateTime(timezone=True), nullable=True),
    Column("snapshot", json_type(), nullable=False),
    Column("version", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    # Derived from snapshot.deletedAt so list and dispatch reads filter on
    # a column instead of a JSON path.
    Column("deleted_at", DateTime(timezone=True), nullable=True),
    UniqueConstraint("number_scope", "number", name="uq_tasks_number_scope_number"),
    # Every task event rewrites this row, so each index here is paid on
    # every write. Low-cardinality single columns (status, priority, the
    # routine booleans) are left out on purpose: the partial indexes below
    # cover the scheduler's queues, and owner/assignee reads lead with the
    # composite recency indexes.
    Index("ix_tasks_updated_at", "updated_at"),
    Index("ix_tasks_assigned_agent_id", "assigned_agent_id"),
    Index("ix_tasks_assigned_team_id", "assigned_team_id"),
    Index("ix_tasks_project_id", "project_id"),
    Index("ix_tasks_owner_updated_at", "owner_user_id", "updated_at"),
    Index("ix_tasks_assignee_updated_at", "assignee_user_id", "updated_at"),
    # The admin task list and summary read live tasks newest first with an
    # id tiebreaker; this serves that order without a sort over the table.
    # The user-scoped list ORs owner and assignee, which the two composite
    # indexes above cover through a bitmap union.
    Index(
        "ix_tasks_live_recency",
        text("updated_at DESC"),
        text("id DESC"),
        postgresql_where=text("deleted_at IS NULL"),
        sqlite_where=text("deleted_at IS NULL"),
    ),
    Index(
        "ix_tasks_dispatch_queue",
        "due_date",
        "created_at",
        "id",
        postgresql_where=text(
            "status = 'assigned' AND is_routine IS false AND deleted_at IS NULL"
        ),
        sqlite_where=text(
            "status = 'assigned' AND is_routine IS 0 AND deleted_at IS NULL"
        ),
    ),
    Index(
        "ix_tasks_due_schedules",
        "routine_next_run_at",
        postgresql_where=routine_index_where("postgresql"),
        sqlite_where=routine_index_where("sqlite"),
    ),
    Index(
        "ix_tasks_listening_routines",
        "created_at",
        postgresql_where=routine_index_where("postgresql", "routine_listens IS {true}"),
        sqlite_where=routine_index_where("sqlite", "routine_listens IS {true}"),
    ),
    Index(
        "ix_tasks_unseeded_schedules",
        "created_at",
        postgresql_where=routine_index_where(
            "postgresql", "routine_has_schedule IS {true}", "routine_next_run_at IS NULL"
        ),
        sqlite_where=routine_index_where(
            "sqlite", "routine_has_schedule IS {true}", "routine_next_run_at IS NULL"
        ),
    ),
)

events = Table(
    "task_events",
    metadata,
    database_id_column(),
    Column(
        "task_id",
        entity_uuid_type(),
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("sequence", BigInteger, nullable=False),
    Column("type", Text, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("payload", json_type(), nullable=False),
    # (task_id, sequence) serves history reads and the FK cascade.
    UniqueConstraint("task_id", "sequence", name="uq_task_events_task_sequence"),
    Index("ix_task_events_task_type_sequence", "task_id", "type", "sequence"),
)

number_counters = Table(
    "task_number_counters",
    metadata,
    Column("scope", Text, primary_key=True),
    Column("last_number", Integer, nullable=False),
)

task_sessions = Table(
    "task_sessions",
    metadata,
    database_id_column(),
    Column(
        "task_id",
        entity_uuid_type(),
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column(
        "session_id",
        entity_uuid_type(),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("task_id", "session_id", name="uq_task_sessions_task_session"),
    Index("ix_task_sessions_session_id", "session_id"),
)

# One row per (task, prerequisite) edge, derived from the dependent task's
# ``prerequisiteTaskIds`` snapshot field. The dispatch queue reads it to hold
# back a task whose prerequisites are not done; the reverse index answers
# what a task unblocks.
task_prerequisites = Table(
    "task_prerequisites",
    metadata,
    Column(
        "task_id",
        entity_uuid_type(),
        ForeignKey("tasks.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "prerequisite_task_id",
        entity_uuid_type(),
        ForeignKey("tasks.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Index("ix_task_prerequisites_prerequisite", "prerequisite_task_id"),
)
