"""Index changes from the 2026-10 schema review, all built CONCURRENTLY.

Added: partial indexes for the scheduler's queues and the deletion sweep, the
lookups that used to scan (run request by command, command by run request,
runs by command for the ON DELETE SET NULL, task links by thread, daemon
events by type), and the run-request retention order.

Dropped: indexes no query reads, each paid on every write of a hot row --
single low-cardinality columns on ``tasks``, single columns already led by a
composite, event indexes duplicating the (parent, sequence) unique key, and
the two liveness columns on ``daemon_nodes`` whose indexes kept every
heartbeat from being a HOT update.

Also validates the ``task_sessions`` FK added NOT VALID in 20261010_0085
(orphan links were removed in 20261010_0086); VALIDATE CONSTRAINT scans
without blocking writes.

A CONCURRENTLY build that fails leaves an INVALID index behind, which
``IF NOT EXISTS`` would then silently keep; any such leftover is dropped and
rebuilt, so re-running after a failure repairs it.

Revision ID: 20261010_0087
Revises: 20261010_0086
"""

from contextlib import nullcontext

import sqlalchemy as sa
from alembic import op

revision = "20261010_0087"
down_revision = "20261010_0086"
branch_labels = None
depends_on = None

ACTIVE_RUN_REQUESTS = "('prepared', 'running', 'dispatching', 'finalizing')"

CREATED = [
    (
        "ix_sessions_pending_deletion",
        "sessions",
        ["updated_at", "id"],
        "deletion_requested_at IS NOT NULL",
    ),
    (
        "ix_tasks_dispatch_queue",
        "tasks",
        ["due_date", "created_at", "id"],
        "status = 'assigned' AND is_routine IS false AND deleted_at IS NULL",
    ),
    (
        "ix_tasks_due_routines",
        "tasks",
        ["routine_next_run_date"],
        "is_routine IS true AND routine_enabled IS true",
    ),
    (
        "ix_tasks_triggered_routines",
        "tasks",
        ["created_at"],
        (
            "is_routine IS true AND routine_enabled IS true "
            "AND routine_trigger_kind IS NOT NULL"
        ),
    ),
    ("ix_task_sessions_session_id", "task_sessions", ["session_id"], None),
    (
        "ix_daemon_commands_run_request_id",
        "daemon_commands",
        ["run_request_id"],
        "run_request_id IS NOT NULL",
    ),
    ("ix_daemon_runs_command_id", "daemon_runs", ["command_id"], None),
    ("ix_daemon_events_type_timestamp", "daemon_events", ["type", "timestamp"], None),
    (
        "ix_daemon_run_requests_current_command",
        "daemon_run_requests",
        ["current_command_id"],
        f"status IN {ACTIVE_RUN_REQUESTS}",
    ),
    (
        "ix_daemon_run_requests_terminal_retention",
        "daemon_run_requests",
        ["updated_at", "id"],
        f"status NOT IN {ACTIVE_RUN_REQUESTS}",
    ),
]

# Kept with their definitions so the downgrade can rebuild them exactly.
DROPPED = [
    ("ix_sessions_owner_employee_id", "sessions", ["owner_employee_id"]),
    ("ix_sessions_status", "sessions", ["status"]),
    ("ix_session_events_session_id", "session_events", ["session_id"]),
    ("ix_session_events_timestamp", "session_events", ["timestamp"]),
    ("ix_session_events_type_timestamp", "session_events", ["type", "timestamp"]),
    ("ix_tasks_created_at", "tasks", ["created_at"]),
    ("ix_tasks_status", "tasks", ["status"]),
    ("ix_tasks_assigned_agent", "tasks", ["assigned_agent"]),
    ("ix_tasks_owner_employee_id", "tasks", ["owner_employee_id"]),
    ("ix_tasks_assignee_employee_id", "tasks", ["assignee_employee_id"]),
    ("ix_tasks_due_date", "tasks", ["due_date"]),
    ("ix_tasks_priority", "tasks", ["priority"]),
    ("ix_tasks_is_routine", "tasks", ["is_routine"]),
    ("ix_tasks_routine_next_run_date", "tasks", ["routine_next_run_date"]),
    ("ix_tasks_routine_enabled", "tasks", ["routine_enabled"]),
    ("ix_tasks_routine_trigger_kind", "tasks", ["routine_trigger_kind"]),
    (
        "ix_tasks_dispatch_eligibility",
        "tasks",
        ["status", "is_routine", "dispatch_next_attempt_at", "priority", "due_date", "created_at"],
    ),
    ("ix_task_events_task_id", "task_events", ["task_id"]),
    ("ix_task_events_timestamp", "task_events", ["timestamp"]),
    ("ix_daemon_nodes_updated_at", "daemon_nodes", ["updated_at"]),
    ("ix_daemon_nodes_last_seen_at", "daemon_nodes", ["last_seen_at"]),
]


def _drop_if_invalid(name):
    invalid = op.get_bind().execute(
        sa.text(
            "SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relname = :name AND n.nspname = current_schema() "
            "AND NOT i.indisvalid"
        ),
        {"name": name},
    ).first()
    if invalid:
        op.execute(sa.text(f'DROP INDEX CONCURRENTLY IF EXISTS "{name}"'))


def _create(name, table, columns, predicate):
    _drop_if_invalid(name)
    options = {"postgresql_concurrently": True, "if_not_exists": True}
    if predicate:
        options["postgresql_where"] = sa.text(predicate)
    op.create_index(name, table, columns, **options)


def _drop(name, table):
    op.drop_index(name, table_name=table, postgresql_concurrently=True, if_exists=True)


def upgrade():
    postgres = op.get_bind().dialect.name == "postgresql"
    with op.get_context().autocommit_block() if postgres else nullcontext():
        for name, table, columns, predicate in CREATED:
            _create(name, table, columns, predicate)
        for name, table, _ in DROPPED:
            _drop(name, table)
        op.execute(
            "ALTER TABLE task_sessions VALIDATE CONSTRAINT task_sessions_session_id_fkey"
        )


def downgrade():
    postgres = op.get_bind().dialect.name == "postgresql"
    with op.get_context().autocommit_block() if postgres else nullcontext():
        for name, table, columns in reversed(DROPPED):
            _create(name, table, columns, None)
        for name, table, _, _ in reversed(CREATED):
            _drop(name, table)
