"""Automation (routine) queries and triggered occurrences.

A mixin of ``DatabaseTaskStore``; it shares the store's engine and tables
(declared on ``TaskStoreState``) and is not used on its own.
"""

from __future__ import annotations

from functools import partial
from datetime import datetime
from typing import Any
from sqlalchemy import (
    insert,
    literal_column,
    select,
    update,
)
from .reducer import materialize_task_events
from ..engine import store_transaction
from .numbering import number_task_events
from .rules import (
    apply_task_events,
)
from .events import (
    routine_occurrence_events,
    triggered_occurrence_allowed,
    triggered_occurrence_routine_events,
)
from .rows import (
    task_event_to_row,
    task_to_row,
)
from .state import TaskStoreState


class TaskRoutineRows(TaskStoreState):
    def create_triggered_occurrence(
        self,
        routine_id: str,
        *,
        run_date: str,
        trigger_kind: str,
        depth: int,
        context: str,
        summary: dict[str, Any] | None = None,
        allow_paused: bool = False,
    ) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                    .where(self.tasks.c.id == routine_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            routine = self._current_snapshot(conn, row)
            if not triggered_occurrence_allowed(routine, allow_paused=allow_paused):
                return None
            occurrence_events = routine_occurrence_events(
                routine,
                routine.get("assignedAgent"),
                scheduled_for=run_date,
                trigger={"kind": trigger_kind, "depth": depth, "context": context, "summary": summary},
            )
            occurrence_events = number_task_events(
                occurrence_events, partial(self._next_task_number, conn)
            )
            occurrence = materialize_task_events(occurrence_events)
            occurrence_row = task_to_row(occurrence, version=len(occurrence_events))
            conn.execute(insert(self.tasks).values(**occurrence_row))
            for sequence, occurrence_event in enumerate(occurrence_events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(
                            occurrence_row["id"], sequence, occurrence_event
                        )
                    )
                )
            routine_events = triggered_occurrence_routine_events(
                routine_id, occurrence["id"], run_date, trigger_kind
            )
            task_pk = row["id"]
            sequence = int(row["version"] or 0)
            for offset, event in enumerate(routine_events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(task_pk, sequence + offset, event)
                    )
                )
            updated = apply_task_events(routine, routine_events, version=sequence)
            conn.execute(
                update(self.tasks)
                .where(self.tasks.c.id == task_pk)
                .values(
                    **task_to_row(
                        updated,
                        version=sequence + len(routine_events),
                        database_id=task_pk,
                    )
                )
            )
        return occurrence

    def _active_routines_query(self, *conditions: Any, order: Any) -> Any:
        return (
            select(self.tasks.c.snapshot)
            .where(self.tasks.c.is_routine.is_(True))
            .where(self.tasks.c.routine_state == literal_column("'active'"))
            .where(self.tasks.c.deleted_at.is_(None))
            .where(*conditions)
            .order_by(order)
        )

    def listening_query(self) -> Any:
        return self._active_routines_query(
            self.tasks.c.routine_listens.is_(True), order=self.tasks.c.created_at.asc()
        )

    def due_schedules_query(self, now: datetime) -> Any:
        return self._active_routines_query(
            self.tasks.c.routine_next_run_at.is_not(None),
            self.tasks.c.routine_next_run_at <= now,
            order=self.tasks.c.routine_next_run_at.asc(),
        )

    def unseeded_schedules_query(self) -> Any:
        return self._active_routines_query(
            self.tasks.c.routine_has_schedule.is_(True),
            self.tasks.c.routine_next_run_at.is_(None),
            order=self.tasks.c.created_at.asc(),
        )

    def _snapshots(self, query: Any) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(query).mappings().all()
        return [row["snapshot"] for row in rows]

    def list_trigger_automations(self) -> list[dict[str, Any]]:
        return self._snapshots(self.listening_query())

    def list_due_schedules(self, now: datetime) -> list[dict[str, Any]]:
        return self._snapshots(self.due_schedules_query(now))

    def list_unseeded_schedules(self) -> list[dict[str, Any]]:
        return self._snapshots(self.unseeded_schedules_query())
