"""Index Automation occurrences by their recorded parent and run order."""

import sqlalchemy as sa
from alembic import op

revision = "20261124_0133"
down_revision = "20261124_0132"
branch_labels = None
depends_on = None

_INDEX = "ix_tasks_live_automation_ledger"
_UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


def upgrade() -> None:
    op.execute("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS automation_id uuid")
    # During a rolling upgrade, older writers still record the link in the
    # parent event. Start projecting those inserts before taking the backfill
    # snapshot so an occurrence cannot fall between the two versions.
    op.execute(f"""
        CREATE OR REPLACE FUNCTION relay_project_automation_occurrence()
        RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
        DECLARE occurrence text := NEW.payload ->> 'occurrenceId';
        BEGIN
            IF occurrence ~* '{_UUID_PATTERN}' THEN
                UPDATE tasks AS child SET automation_id = parent.id
                FROM tasks AS parent
                WHERE parent.id = NEW.task_id AND parent.is_routine
                  AND child.id = occurrence::uuid AND child.automation_id IS NULL
                  AND child.owner_user_id IS NOT DISTINCT FROM parent.owner_user_id;
            END IF;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("DROP TRIGGER IF EXISTS relay_project_automation_occurrence ON task_events")
    op.execute("""
        CREATE TRIGGER relay_project_automation_occurrence
        AFTER INSERT ON task_events FOR EACH ROW
        WHEN (NEW.type = 'task.occurrence_created')
        EXECUTE FUNCTION relay_project_automation_occurrence()
    """)
    with op.get_context().autocommit_block():
        op.execute(f"""
            WITH links AS (
                SELECT parent.id AS parent_id, parent.owner_user_id, occurrence_id
                FROM tasks AS parent
                CROSS JOIN LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(parent.snapshot -> 'occurrenceIds') = 'array'
                         THEN parent.snapshot -> 'occurrenceIds' ELSE '[]'::jsonb END
                ) AS linked(occurrence_id)
                WHERE parent.is_routine
                UNION ALL
                SELECT parent.id, parent.owner_user_id, event.payload ->> 'occurrenceId'
                FROM tasks AS parent JOIN task_events AS event ON event.task_id = parent.id
                WHERE parent.is_routine AND event.type = 'task.occurrence_created'
            ), parents AS (
                SELECT DISTINCT ON (child.id) child.id, links.parent_id
                FROM links JOIN tasks AS child
                  ON child.id = CASE WHEN links.occurrence_id ~* '{_UUID_PATTERN}'
                       THEN links.occurrence_id::uuid END
                 AND child.owner_user_id IS NOT DISTINCT FROM links.owner_user_id
                WHERE child.automation_id IS NULL
                ORDER BY child.id, (child.snapshot ->> 'sourceRoutineId' = links.parent_id::text) DESC NULLS LAST,
                         links.parent_id
            )
            UPDATE tasks SET automation_id = parents.parent_id
            FROM parents WHERE tasks.id = parents.id AND tasks.automation_id IS NULL
        """)
        valid = op.get_bind().scalar(sa.text(
            "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)",
        ), {"name": _INDEX})
        if valid is False:
            op.execute(f"DROP INDEX CONCURRENTLY {_INDEX}")
        if not valid:
            op.execute(f"""
                CREATE INDEX CONCURRENTLY {_INDEX} ON tasks
                  (automation_id, owner_user_id,
                   (COALESCE(NULLIF(snapshot ->> 'scheduledFor', ''), snapshot ->> 'dueDate', '')),
                   (COALESCE(snapshot ->> 'createdAt', '')), id)
                WHERE deleted_at IS NULL AND automation_id IS NOT NULL
            """)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {_INDEX}")
    op.execute("DROP TRIGGER IF EXISTS relay_project_automation_occurrence ON task_events")
    op.execute("DROP FUNCTION IF EXISTS relay_project_automation_occurrence()")
    op.drop_column("tasks", "automation_id")
