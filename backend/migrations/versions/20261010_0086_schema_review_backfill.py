"""Backfill the 2026-10 schema review's derived columns and projections.

Runs outside one long transaction: each batch of at most ``BATCH`` rows is its
own short autocommit statement, keyed by primary key, so no lock is held across
the walk over every snapshot and an interrupted run simply resumes. Every step
only fills what is still missing, so the revision is safe to re-run (for
instance after old-code replicas wrote rows during a rolling deploy:
``alembic downgrade 20261010_0085 && alembic upgrade head`` repeats it without
touching the schema in between).

A snapshot timestamp that PostgreSQL cannot parse becomes NULL (or the epoch,
for an artifact's rank) instead of aborting the migration.

Revision ID: 20261010_0086
Revises: 20261010_0085
"""

import sqlalchemy as sa
from alembic import op

revision = "20261010_0086"
down_revision = "20261010_0085"
branch_labels = None
depends_on = None

BATCH = 1000

TRY_TIMESTAMPTZ = """
CREATE OR REPLACE FUNCTION pg_temp.relay_try_timestamptz(value text)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    RETURN value::timestamptz;
EXCEPTION WHEN others THEN
    RETURN NULL;
END
$$
"""

# (table, rows still missing the value, SET clause)
COLUMN_BACKFILLS = [
    (
        "sessions",
        "deletion_requested_at IS NULL AND snapshot ? 'deletionRequestedAt'",
        (
            "deletion_requested_at = "
            "pg_temp.relay_try_timestamptz(snapshot->>'deletionRequestedAt')"
        ),
    ),
    (
        "tasks",
        "deleted_at IS NULL AND snapshot ? 'deletedAt'",
        "deleted_at = pg_temp.relay_try_timestamptz(snapshot->>'deletedAt')",
    ),
    (
        "daemon_commands",
        "run_request_id IS NULL AND command ? '_runRequestId'",
        "run_request_id = command->>'_runRequestId'",
    ),
]

# Mirrors helpers.workspace_artifacts: newest createdAt per file wins, a missing
# or unreadable createdAt ranks oldest (the epoch), and a tie goes to the later
# entry in the array. ON CONFLICT keeps rows the running code already wrote.
WORKSPACE_FILES = """
INSERT INTO session_workspace_files
    (session_id, file_key, artifact_id, owner_employee_id,
     workspace_path, created_at, artifact)
SELECT DISTINCT ON (s.id, k.file_key)
       s.id, k.file_key, a.value->>'id', s.owner_employee_id, s.workspace_path,
       k.created_at, a.value
FROM sessions s
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(s.snapshot->'artifacts') = 'array'
         THEN s.snapshot->'artifacts' ELSE '[]'::jsonb END
) WITH ORDINALITY AS a(value, ordinal)
CROSS JOIN LATERAL (
    SELECT
        COALESCE(
            NULLIF(a.value->>'workspaceRelativePath', ''),
            NULLIF(a.value->>'path', ''),
            NULLIF(a.value->>'id', '')
        ) AS file_key,
        COALESCE(
            pg_temp.relay_try_timestamptz(a.value->>'createdAt'),
            'epoch'::timestamptz
        ) AS created_at
) k
WHERE s.id = ANY(:ids)
  AND a.value->>'kind' = 'workspace_file'
  AND k.file_key IS NOT NULL
ORDER BY s.id, k.file_key, k.created_at DESC, a.ordinal DESC
ON CONFLICT (session_id, file_key) DO NOTHING
"""


def _batches(conn, table: str, where: str):
    """Yield primary-key batches of matching rows, in key order."""
    after = None
    while True:
        rows = conn.execute(
            sa.text(
                f"SELECT id FROM {table} WHERE {where}"
                + (" AND id > :after" if after is not None else "")
                + " ORDER BY id LIMIT :batch"
            ),
            {"after": after, "batch": BATCH},
        ).scalars().all()
        if not rows:
            return
        yield rows
        after = rows[-1]


def upgrade():
    if op.get_bind().dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        conn = op.get_bind()
        conn.execute(sa.text(TRY_TIMESTAMPTZ))
        for table, missing, assignment in COLUMN_BACKFILLS:
            for ids in _batches(conn, table, missing):
                conn.execute(
                    sa.text(f"UPDATE {table} SET {assignment} WHERE id = ANY(:ids)"),
                    {"ids": ids},
                )
        for ids in _batches(conn, "sessions", "snapshot ? 'artifacts'"):
            conn.execute(sa.text(WORKSPACE_FILES), {"ids": ids})
        # A link to a thread that no longer exists is meaningless, and it would
        # fail the FK validation in 20261010_0087. The task's own snapshot (the
        # authority) is untouched.
        conn.execute(
            sa.text(
                "DELETE FROM task_sessions ts WHERE NOT EXISTS "
                "(SELECT 1 FROM sessions s WHERE s.id = ts.session_id)"
            )
        )


def downgrade():
    # Derived values only; 20261010_0085's downgrade drops their columns and
    # tables.
    pass
