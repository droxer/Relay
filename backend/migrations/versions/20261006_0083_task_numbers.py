"""Number every task within its scope: project, owner's issues, owner's automations.

Existing tasks are numbered in creation order through an appended
``task.numbered`` event, so the event log stays authoritative and a replay
reproduces the number. The event reuses the task's last ``updatedAt`` so the
backfill does not reorder recency-sorted lists.
"""

from datetime import datetime
import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261006_0083"
down_revision = "20261002_0082"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")

tasks = sa.table(
    "tasks",
    sa.column("id", ID),
    sa.column("snapshot", JSON),
    sa.column("version", sa.BigInteger()),
    sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("number_scope", sa.Text()),
    sa.column("number", sa.Integer()),
)
counters_table = sa.table(
    "task_number_counters",
    sa.column("scope", sa.Text()),
    sa.column("last_number", sa.Integer()),
)
task_events = sa.table(
    "task_events",
    sa.column("id", ID),
    sa.column("task_id", ID),
    sa.column("sequence", sa.BigInteger()),
    sa.column("type", sa.Text()),
    sa.column("timestamp", sa.DateTime(timezone=True)),
    sa.column("payload", JSON),
)


def _scope(snapshot: dict) -> str:
    # Frozen copy of relay.persistence.task_numbering.task_number_scope.
    owner = snapshot.get("ownerEmployeeId") or ""
    if snapshot.get("isRoutine"):
        return f"automation:{owner}"
    if snapshot.get("projectId"):
        return f"project:{snapshot['projectId']}"
    return f"issue:{owner}"


def _restore_numbered(conn, rows) -> dict[str, int]:
    """Re-index tasks whose log already numbers them (an upgrade after a
    downgrade) without appending a second event."""
    counters: dict[str, int] = {}
    for row in rows:
        snapshot = row.snapshot or {}
        scope, number = snapshot["numberScope"], int(snapshot["number"])
        counters[scope] = max(counters.get(scope, 0), number)
        conn.execute(
            sa.update(tasks)
            .where(tasks.c.id == row.id)
            .values(number_scope=scope, number=number)
        )
    return counters


def backfill(conn) -> None:
    rows = conn.execute(
        sa.select(tasks.c.id, tasks.c.snapshot, tasks.c.version)
        .where(tasks.c.number.is_(None))
        .order_by(tasks.c.created_at, tasks.c.id)
    ).all()
    numbered = [row for row in rows if (row.snapshot or {}).get("number") is not None]
    counters = _restore_numbered(conn, numbered)
    for scope, highest in conn.execute(
        sa.select(tasks.c.number_scope, sa.func.max(tasks.c.number))
        .where(tasks.c.number.is_not(None))
        .group_by(tasks.c.number_scope)
    ).all():
        counters[scope] = max(counters.get(scope, 0), int(highest))
    for row in rows:
        snapshot = dict(row.snapshot or {})
        if snapshot.get("number") is not None:
            continue
        scope = _scope(snapshot)
        number = counters.get(scope, 0) + 1
        counters[scope] = number
        version = int(row.version or 0)
        timestamp = snapshot.get("updatedAt") or snapshot.get("createdAt")
        event = {
            "id": str(uuid.uuid4()),
            "type": "task.numbered",
            "taskId": snapshot.get("id") or str(row.id),
            "timestamp": timestamp,
            "number": number,
            "numberScope": scope,
        }
        conn.execute(
            sa.insert(task_events).values(
                id=str(uuid.uuid4()),
                task_id=row.id,
                sequence=version,
                type=event["type"],
                timestamp=datetime.fromisoformat(timestamp.replace("Z", "+00:00")),
                payload=event,
            )
        )
        conn.execute(
            sa.update(tasks)
            .where(tasks.c.id == row.id)
            .values(
                number_scope=scope,
                number=number,
                version=version + 1,
                snapshot={
                    **snapshot,
                    "number": number,
                    "numberScope": scope,
                    "eventCount": version + 1,
                },
            )
        )
    for scope, last_number in counters.items():
        conn.execute(sa.delete(counters_table).where(counters_table.c.scope == scope))
        conn.execute(
            sa.insert(counters_table).values(scope=scope, last_number=last_number)
        )


def upgrade() -> None:
    op.add_column("tasks", sa.Column("number_scope", sa.Text(), nullable=True))
    op.add_column("tasks", sa.Column("number", sa.Integer(), nullable=True))
    op.create_table(
        "task_number_counters",
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("last_number", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("scope"),
    )
    backfill(op.get_bind())
    op.create_unique_constraint(
        "uq_tasks_number_scope_number", "tasks", ["number_scope", "number"]
    )


def downgrade() -> None:
    # The appended task.numbered events stay: older readers ignore them.
    op.drop_constraint("uq_tasks_number_scope_number", "tasks", type_="unique")
    op.drop_table("task_number_counters")
    op.drop_column("tasks", "number")
    op.drop_column("tasks", "number_scope")
