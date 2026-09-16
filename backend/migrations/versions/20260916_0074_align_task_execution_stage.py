"""align backlog stages with agent execution

Revision ID: 20260916_0074
Revises: 20260915_0073

Rebuild only the workflow-stage projection. Task history and execution
ownership remain authoritative and unchanged.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20260916_0074"
down_revision = "20260915_0073"
branch_labels = None
depends_on = None


def _histories(connection, tasks, events):
    for row in connection.execute(sa.select(tasks.c.id, tasks.c.snapshot)).mappings():
        history = list(
            connection.execute(
                sa.select(events.c.payload)
                .where(events.c.task_id == row["id"])
                .order_by(events.c.sequence)
            ).scalars()
        )
        history = history or row["snapshot"].get("events", [])
        if history:
            yield row, history


def upgrade() -> None:
    from relay.persistence.store_common import materialize_task_events

    connection = op.get_bind()
    metadata = sa.MetaData()
    tasks = sa.Table("tasks", metadata, autoload_with=connection)
    events = sa.Table("task_events", metadata, autoload_with=connection)
    for row, history in _histories(connection, tasks, events):
        stage = materialize_task_events(history)["workflowStage"]
        connection.execute(
            sa.update(tasks)
            .where(tasks.c.id == row["id"])
            .values(snapshot={**row["snapshot"], "workflowStage": stage})
        )


def _legacy_workflow_stage(history: list[dict]) -> str:
    stage = "backlog"
    started = False
    for event in history:
        event_type = event.get("type")
        if event_type == "task.execution.claimed":
            started = True
            stage = "running"
            continue
        if event_type != "task.status":
            continue
        status = event.get("status")
        if status in ("blocked", "waiting_for_human"):
            if stage == "done" or (status == "waiting_for_human" and stage == "backlog"):
                stage = "running"
            continue
        if status in ("running", "review", "waiting_for_human"):
            started = True
        stage = "running" if status == "assigned" and started else status
    return stage


def downgrade() -> None:
    connection = op.get_bind()
    metadata = sa.MetaData()
    tasks = sa.Table("tasks", metadata, autoload_with=connection)
    events = sa.Table("task_events", metadata, autoload_with=connection)
    for row, history in _histories(connection, tasks, events):
        connection.execute(
            sa.update(tasks)
            .where(tasks.c.id == row["id"])
            .values(
                snapshot={
                    **row["snapshot"],
                    "workflowStage": _legacy_workflow_stage(history),
                }
            )
        )
