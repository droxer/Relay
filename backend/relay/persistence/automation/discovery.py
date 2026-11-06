"""Bounded routing projections and durable round-robin candidate discovery."""

from datetime import datetime
from typing import Any

from sqlalchemy import Text, and_, cast, insert, literal_column, or_, select, update

from ..engine import store_transaction
from ..tables.automations import automation_scan_cursors, automation_state
from ..tables.tasks import tasks


def active_routines() -> tuple[Any, ...]:
    return (
        tasks.c.is_routine.is_(True),
        tasks.c.deleted_at.is_(None),
        tasks.c.routine_state == literal_column("'active'"),
    )


def routing_page(
    engine: Any,
    *,
    limit: int,
    before: datetime,
    after_created_at: datetime | None = None,
    after_id: str | None = None,
) -> list[dict[str, Any]]:
    query = select(
        tasks.c.id, tasks.c.created_at, tasks.c.owner_user_id, tasks.c.snapshot["routineTriggers"].label("triggers")
    ).where(
        *active_routines(),
        tasks.c.routine_listens.is_(True),
        tasks.c.created_at <= before,
    )
    if after_created_at is not None and after_id is not None:
        query = query.where(
            or_(
                tasks.c.created_at > after_created_at,
                and_(tasks.c.created_at == after_created_at, tasks.c.id > after_id),
            )
        )
    query = query.order_by(tasks.c.created_at, tasks.c.id).limit(limit)
    with store_transaction(engine) as conn:
        rows = conn.execute(query).mappings().all()
    return [
        {
            "id": row["id"],
            "createdAt": row["created_at"],
            "ownerUserId": row["owner_user_id"],
            "routineTriggers": row["triggers"],
            "isRoutine": True,
            "routineState": "active",
        }
        for row in rows
    ]


def candidate_ids(engine: Any, *, limit: int, now: datetime) -> list[str]:
    """Rotate through narrow IDs, even when earlier candidates remain in flight.

    The caller holds the automation transaction lock. Progress commits with
    its tick, so another replica resumes the scan and rollback retries it.
    """
    eligible = (
        select(cast(tasks.c.id, Text).label("routine_id"))
        .where(
            *active_routines(),
            tasks.c.routine_has_schedule.is_(True),
            or_(tasks.c.routine_next_run_at.is_(None), tasks.c.routine_next_run_at <= now),
        )
        .union(select(automation_state.c.routine_id).where(automation_state.c.pending.is_(True)))
        .subquery()
    )
    query = select(eligible.c.routine_id).order_by(eligible.c.routine_id)
    name = "tick-candidates"
    with store_transaction(engine) as conn:
        cursor = conn.execute(
            select(automation_scan_cursors.c.after_id).where(automation_scan_cursors.c.name == name)
        ).first()
        after = cursor[0] if cursor else None
        ids = list(conn.scalars((query.where(eligible.c.routine_id > after) if after else query).limit(limit)))
        if after and len(ids) < limit:
            ids.extend(conn.scalars(query.where(eligible.c.routine_id <= after).limit(limit - len(ids))))
        values = {"after_id": ids[-1] if ids else None}
        if cursor:
            conn.execute(update(automation_scan_cursors).where(automation_scan_cursors.c.name == name).values(**values))
        else:
            conn.execute(insert(automation_scan_cursors).values(name=name, **values))
    return ids
