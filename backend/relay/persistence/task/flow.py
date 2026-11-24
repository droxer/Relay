"""SQL projections of the task WIP policy, shared by reads and admission."""

from __future__ import annotations

from sqlalchemy import select, func
from ...tasks.flow import wip_limit
from ..tables.auth import users
from ..tables.tasks import task_occupies_wip, task_wip_scope, tasks


def wip_count_query(scope: str, *, exclude_task_id: str | None = None):
    scope_filter = task_wip_scope.is_(None) if scope == "unowned" else task_wip_scope == scope
    query = select(func.count()).select_from(tasks).where(scope_filter, task_occupies_wip)
    return query.where(tasks.c.id != exclude_task_id) if exclude_task_id else query


def user_wip_limit(conn, scope: str) -> int:
    override = (
        None if scope == "unowned" else conn.scalar(select(users.c.max_concurrent_tasks).where(users.c.id == scope))
    )
    return int(override) if override is not None else wip_limit()
