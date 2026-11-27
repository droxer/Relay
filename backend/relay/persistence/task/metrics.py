"""Task statistics queries for personal Home summaries.

A mixin of ``DatabaseTaskStore``; it shares the store's engine and tables
(declared on ``TaskStoreState``) and is not used on its own.
"""

from __future__ import annotations

from datetime import UTC, date, tzinfo
from typing import Any

from sqlalchemy import and_, case, func, or_, select, true

from ...core.reporting_period import range_utc_bounds
from ...core.timestamps import parse_iso
from ..engine import store_transaction
from ..tables.projects import projects
from .state import TaskStoreState


class TaskMetricReads(TaskStoreState):
    def user_home_task_stats(
        self,
        user_id: str,
        *,
        date_range: tuple[date, date] | None = None,
        zone: tzinfo = UTC,
        all_time: bool = False,
    ) -> dict[str, int]:
        """Aggregate one user's task completions (by finishedAt), creations, and open counts."""
        tasks = self.tasks
        personal_scope = (
            tasks.c.owner_user_id == user_id,
            tasks.c.deleted_at.is_(None),
            or_(
                tasks.c.project_id.is_(None),
                select(projects.c.id).where(projects.c.id == tasks.c.project_id).exists(),
            ),
            func.coalesce(tasks.c.assignee_user_id, tasks.c.owner_user_id) == user_id,
            tasks.c.is_routine.is_(False),
        )
        in_progress_statuses = ("assigned", "queued", "running", "waiting_for_human", "review")
        bounds = range_utc_bounds(date_range, zone) if date_range is not None and not all_time else None
        if bounds is not None:
            start_at, end_at = bounds
            created_in_range: Any = and_(tasks.c.created_at >= start_at, tasks.c.created_at < end_at)
        else:
            created_in_range = true()
        summary_stmt = select(
            func.sum(case((created_in_range, 1), else_=0)).label("created"),
            func.sum(case((tasks.c.status.not_in(("done", "cancelled")), 1), else_=0)).label("open"),
            func.sum(case((tasks.c.status.in_(in_progress_statuses), 1), else_=0)).label("in_progress"),
            func.sum(case((tasks.c.status == "done", 1), else_=0)).label("done_all"),
        ).where(*personal_scope)

        with store_transaction(self.engine) as conn:
            summary = conn.execute(summary_stmt).mappings().one()
            if bounds is None:
                completed = int(summary["done_all"] or 0)
            else:
                start_at, end_at = bounds
                # Every completion sets finishedAt and updated_at together, and later
                # edits only advance updated_at, so updated_at >= start_at uses the
                # owner recency index while exact ISO parsing handles Z / +00:00 and
                # tasks edited after the window closed.
                done_stmt = select(
                    tasks.c.snapshot["finishedAt"].as_string().label("finished_at"),
                    tasks.c.updated_at.label("updated_at"),
                ).where(
                    *personal_scope,
                    tasks.c.status == "done",
                    tasks.c.updated_at >= start_at,
                )
                completed = 0
                for row in conn.execute(done_stmt).mappings():
                    finished = parse_iso(row["finished_at"])
                    if finished is None:
                        updated = row["updated_at"]
                        if updated is None:
                            continue
                        finished = updated.replace(tzinfo=UTC) if updated.tzinfo is None else updated.astimezone(UTC)
                    if start_at <= finished < end_at:
                        completed += 1

        return {
            "completed": completed,
            "created": int(summary["created"] or 0),
            "open": int(summary["open"] or 0),
            "inProgress": int(summary["in_progress"] or 0),
        }
