"""The schedule clock: promotes due routines into occurrences."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

from loguru import logger

from ..persistence.stores import valid_agent
from ..persistence.task_store import routine_due_sort_key
from ..services.project_runtime import project_work_error

ROUTINE_SKIP_NO_AGENT_MESSAGE = (
    "Routine skipped: no assigned agent. Assign an agent so the scheduler can run it."
)


def next_routine_date(run_date: date, cadence: str, today: date) -> date | None:
    if cadence == "custom":
        return None
    next_run = _add_interval(run_date, cadence)
    while next_run <= today:
        next_run = _add_interval(next_run, cadence)
    return next_run


def _add_interval(value: date, cadence: str) -> date:
    if cadence == "daily":
        return value + timedelta(days=1)
    if cadence == "monthly":
        return _add_month(value)
    return value + timedelta(days=7)


def _add_month(value: date) -> date:
    month = value.month + 1
    year = value.year
    if month == 13:
        month = 1
        year += 1
    day = min(value.day, _month_days(year, month))
    return date(year, month, day)


def _month_days(year: int, month: int) -> int:
    if month == 12:
        following = date(year + 1, 1, 1)
    else:
        following = date(year, month + 1, 1)
    return (following - timedelta(days=1)).day


class ScheduleClock:
    def __init__(
        self,
        *,
        task_store: Any,
        project_store: Any,
        materialize_assignment: Callable[[dict[str, Any]], dict[str, Any] | None],
    ) -> None:
        self._task_store = task_store
        self._project_store = project_store
        self._materialize_assignment = materialize_assignment

    def run(self, today: date) -> tuple[int, int]:
        promoted = 0
        skipped = 0
        for routine in self._due_routines(today):
            if project_id := routine.get("projectId"):
                project = self._project_store.get_project(project_id) if self._project_store else None
                if project_work_error(project):
                    skipped += 1
                    continue
            routine = self._materialize_assignment(routine) or routine
            agent = valid_agent(routine.get("assignedAgent"))
            if not (
                routine.get("projectId")
                or (agent and routine.get("assignedAgentId"))
                or routine.get("assignedTeamId")
            ):
                skipped += 1
                self._record_routine_skip(routine)
                continue
            run_date = (
                date.fromisoformat(routine["routineNextRunDate"])
                if routine.get("routineNextRunDate")
                else today
            )
            next_run = next_routine_date(
                run_date, routine.get("routineCadence") or "weekly", today
            )
            occurrence = self._task_store.promote_due_routine(
                routine["id"],
                today.isoformat(),
                next_run.isoformat() if next_run else None,
            )
            if occurrence:
                promoted += 1
        return promoted, skipped

    def _record_routine_skip(self, routine: dict[str, Any]) -> None:
        activities = routine.get("activity") or (
            [routine["lastActivity"]] if routine.get("lastActivity") else []
        )
        if (
            activities
            and activities[-1].get("message") == ROUTINE_SKIP_NO_AGENT_MESSAGE
        ):
            return
        self._task_store.record_activity(routine["id"], ROUTINE_SKIP_NO_AGENT_MESSAGE)
        logger.warning("Due routine skipped: no assigned agent", task_id=routine["id"])

    def _routine_due(self, task: dict[str, Any], today: date) -> bool:
        if (
            not task.get("isRoutine")
            or not task.get("routineEnabled")
            or not task.get("routineNextRunDate")
        ):
            return False
        try:
            next_run = date.fromisoformat(task["routineNextRunDate"])
        except ValueError:
            return False
        return next_run <= today

    def _due_routines(self, today: date) -> list[dict[str, Any]]:
        if hasattr(self._task_store, "list_due_routines"):
            return list(self._task_store.list_due_routines(today.isoformat()))
        routines = [
            task
            for task in self._task_store.list_tasks()
            if self._routine_due(task, today)
        ]
        return sorted(routines, key=routine_due_sort_key)
