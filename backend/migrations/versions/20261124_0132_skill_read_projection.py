"""Make the first Skill revision's timestamp agree with event replay.

Revision ID: 20261124_0132
Revises: 20261124_0131
"""

from alembic import op

revision = "20261124_0132"
down_revision = "20261124_0131"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The old creator copied the first revision's id into the snapshot, but
    # replay used the revision creation time as the Skill's last update.
    # Assignment events do not materialize Skill fields.
    op.execute("""
        UPDATE skills AS skill
        SET snapshot = jsonb_set(skill.snapshot, '{updatedAt}', to_jsonb(
                COALESCE(first.payload ->> 'updatedAt', first.payload #>> '{revision,createdAt}'))),
            updated_at = CAST(
                COALESCE(first.payload ->> 'updatedAt', first.payload #>> '{revision,createdAt}') AS timestamptz)
        FROM skill_events AS first
        WHERE first.skill_id = skill.id
          AND first.sequence = 1
          AND first.type = 'skill.revision.added'
          AND skill.snapshot ->> 'updatedAt' <>
              COALESCE(first.payload ->> 'updatedAt', first.payload #>> '{revision,createdAt}')
          AND NOT EXISTS (
              SELECT 1
              FROM skill_events AS later
              WHERE later.skill_id = skill.id AND later.sequence > first.sequence
                AND later.type IN ('skill.revision.added', 'skill.revision.promoted', 'skill.updated', 'skill.deleted')
          )
    """)


def downgrade() -> None:
    # Earlier readers replay the same events and accept the corrected projection.
    pass
