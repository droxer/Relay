"""Rebuild task flow projections from authoritative history.

Revision ID: 20260913_0069
Revises: 20260913_0068

No task events or execution requests are changed. Old creation events retain
implicit automatic acceptance; new creation events explicitly record policy.
Run with writers stopped so projection updates cannot race event appends.
"""

from alembic import op
import sqlalchemy as sa

revision = "20260913_0069"
down_revision = "20260913_0068"
branch_labels = None
depends_on = None

FLOW_FIELDS = (
    "workflowStage",
    "acceptancePolicy",
    "startedAt",
    "finishedAt",
    "blockedAt",
    "blockedFromStatus",
    "waitingFromStatus",
    "blockerReason",
    "blockerOwnerEmployeeId",
)


def upgrade():
    from relay.persistence.store_common import materialize_task_events

    conn = op.get_bind()
    metadata = sa.MetaData()
    tasks = sa.Table("tasks", metadata, autoload_with=conn)
    events = sa.Table("task_events", metadata, autoload_with=conn)
    # One task history at a time; do not load the organization's event log.
    for row in conn.execute(sa.select(tasks.c.id, tasks.c.snapshot)).mappings():
        history = list(
            conn.execute(
                sa.select(events.c.payload)
                .where(events.c.task_id == row["id"])
                .order_by(events.c.sequence)
            ).scalars()
        )
        history = history or row["snapshot"].get("events", [])
        if not history:
            continue
        materialized = materialize_task_events(history)
        snapshot = {
            **row["snapshot"],
            **{key: materialized[key] for key in FLOW_FIELDS if key in materialized},
        }
        conn.execute(
            sa.update(tasks).where(tasks.c.id == row["id"]).values(snapshot=snapshot)
        )


def downgrade():
    conn = op.get_bind()
    tasks = sa.Table("tasks", sa.MetaData(), autoload_with=conn)
    for row in conn.execute(sa.select(tasks.c.id, tasks.c.snapshot)).mappings():
        snapshot = {
            key: value
            for key, value in row["snapshot"].items()
            if key not in FLOW_FIELDS
        }
        conn.execute(
            sa.update(tasks).where(tasks.c.id == row["id"]).values(snapshot=snapshot)
        )
