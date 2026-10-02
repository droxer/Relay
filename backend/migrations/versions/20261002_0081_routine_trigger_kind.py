"""Index what fires each automation so the matcher can list event automations."""

from alembic import op
import sqlalchemy as sa

revision = "20261002_0081"
down_revision = "20260924_0080"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("routine_trigger_kind", sa.Text(), nullable=True))
    op.create_index("ix_tasks_routine_trigger_kind", "tasks", ["routine_trigger_kind"])
    # Every routine before this revision ran on a schedule.
    op.execute(
        sa.text(
            "UPDATE tasks SET routine_trigger_kind = 'schedule' WHERE is_routine = :flag"
        ).bindparams(sa.bindparam("flag", True, type_=sa.Boolean()))
    )


def downgrade() -> None:
    op.drop_index("ix_tasks_routine_trigger_kind", table_name="tasks")
    op.drop_column("tasks", "routine_trigger_kind")
