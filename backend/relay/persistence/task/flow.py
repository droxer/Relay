"""SQL projections of the task WIP policy, shared by reads and admission."""

from __future__ import annotations

from sqlalchemy import and_, or_, select, func
from ...tasks.flow import TERMINAL_TASK_STATUSES, wip_limit
from ..tables.auth import users
from ..tables.tasks import tasks


def wip_count_query(scope: str, *, exclude_task_id: str | None = None):
    scope_filter = (
        and_(tasks.c.assignee_user_id.is_(None), tasks.c.owner_user_id.is_(None))
        if scope == "unowned"
        else or_(
            tasks.c.assignee_user_id == scope,
            and_(tasks.c.assignee_user_id.is_(None), tasks.c.owner_user_id == scope),
        )
    )
    query = (
        select(func.count())
        .select_from(tasks)
        .where(
            scope_filter,
            tasks.c.status.not_in(TERMINAL_TASK_STATUSES),
            tasks.c.is_routine.is_(False),
            tasks.c.deleted_at.is_(None),
            or_(
                tasks.c.snapshot["startedAt"].as_string().is_not(None),
                tasks.c.status.in_(("running", "review", "waiting_for_human")),
            ),
        )
    )
    return query.where(tasks.c.id != exclude_task_id) if exclude_task_id else query


def user_wip_limit(conn, scope: str) -> int:
    override = (
        None if scope == "unowned" else conn.scalar(select(users.c.max_concurrent_tasks).where(users.c.id == scope))
    )
    return int(override) if override is not None else wip_limit()
