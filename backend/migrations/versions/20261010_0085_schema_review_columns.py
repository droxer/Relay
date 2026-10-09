"""Derived columns and projection tables from the 2026-10 schema review (DDL only).

- ``sessions.deletion_requested_at`` / ``tasks.deleted_at``: columns derived
  from the snapshot, so the deletion sweep and every task list stop filtering
  on a JSON path.
- ``daemon_commands.run_request_id``: derived from ``command._runRequestId``,
  so the pending-command lookup stops loading every pending command.
- ``session_workspace_files``: the per-file artifact index.
- ``maintenance_cursors``: the persisted cursor for opt-in output compaction.
- ``task_sessions.session_id`` gains its FK, added NOT VALID (no scan).

This revision only changes catalogs: nullable columns without defaults and new
tables are metadata-only in PostgreSQL, so the ACCESS EXCLUSIVE locks are held
for milliseconds. ``lock_timeout`` makes it fail fast instead of queueing
behind a long transaction and stalling every writer behind it. Backfills run in
20261010_0086 (batched, outside one long transaction); indexes and FK
validation in 20261010_0087 (CONCURRENTLY).

Revision ID: 20261010_0085
Revises: 20261010_0084
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261010_0085"
down_revision = "20261010_0084"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")
TIMESTAMPTZ = sa.DateTime(timezone=True)
TASK_SESSIONS_FK = "task_sessions_session_id_fkey"


def upgrade():
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("sessions", sa.Column("deletion_requested_at", TIMESTAMPTZ, nullable=True))
    op.add_column("tasks", sa.Column("deleted_at", TIMESTAMPTZ, nullable=True))
    op.add_column("daemon_commands", sa.Column("run_request_id", sa.Text(), nullable=True))

    op.create_table(
        "session_workspace_files",
        sa.Column(
            "session_id",
            ID,
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("file_key", sa.Text(), primary_key=True),
        sa.Column("artifact_id", sa.Text(), nullable=True),
        sa.Column("owner_employee_id", ID, nullable=True),
        sa.Column("workspace_path", sa.Text(), nullable=False),
        sa.Column("created_at", TIMESTAMPTZ, nullable=False),
        sa.Column("artifact", JSON, nullable=False),
    )
    op.create_index(
        "ix_session_workspace_files_owner_recent",
        "session_workspace_files",
        ["owner_employee_id", "created_at"],
    )
    op.create_index(
        "ix_session_workspace_files_workspace_recent",
        "session_workspace_files",
        ["workspace_path", "created_at"],
    )
    op.create_index(
        "ix_session_workspace_files_recent", "session_workspace_files", ["created_at"]
    )

    op.create_table(
        "maintenance_cursors",
        sa.Column("name", sa.Text(), primary_key=True),
        sa.Column("position", JSON, nullable=True),
        sa.Column("updated_at", TIMESTAMPTZ, nullable=False),
    )

    # NOT VALID checks new writes only; 20261010_0086 removes orphan links and
    # 20261010_0087 validates without blocking writes.
    op.execute(
        f"ALTER TABLE task_sessions ADD CONSTRAINT {TASK_SESSIONS_FK} "
        "FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE NOT VALID"
    )


def downgrade():
    op.drop_constraint(TASK_SESSIONS_FK, "task_sessions", type_="foreignkey")
    op.drop_table("maintenance_cursors")
    op.drop_table("session_workspace_files")
    op.drop_column("daemon_commands", "run_request_id")
    op.drop_column("tasks", "deleted_at")
    op.drop_column("sessions", "deletion_requested_at")
