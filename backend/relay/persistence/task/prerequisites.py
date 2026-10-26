"""Task prerequisites: validating a set and keeping its edge rows.

A mixin of ``DatabaseTaskStore``; it shares the store's engine and tables
(declared on ``TaskStoreState``) and is not used on its own. The rules live
in ``relay.tasks.prerequisites``; this module only reads and writes rows.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from sqlalchemy import delete, insert, select, text

from ...core.ids import new_relay_id, now_iso
from ...tasks.prerequisites import (
    PREREQUISITES_EVENT,
    SATISFIED_STATUS,
    validate_prerequisites,
)
from ..engine import store_transaction
from ..events import relay_task_event
from .state import TaskStoreState

# Serializes prerequisite writes within one project on PostgreSQL, so two
# concurrent edits cannot each pass the cycle check and together close one.
_PROJECT_LOCK_SALT = 5512093187


class TaskPrerequisiteRows(TaskStoreState):
    def set_task_prerequisites(
        self, task_id: str, prerequisite_ids: list[str], *, actor_user_id: str | None = None
    ) -> dict[str, Any]:
        """Replace a task's prerequisites; the write path validates them."""
        message = (
            f"Prerequisites set: {', '.join(prerequisite_ids)}."
            if prerequisite_ids
            else "Prerequisites cleared."
        )
        return self.append_events(
            task_id,
            [
                relay_task_event(
                    PREREQUISITES_EVENT,
                    task_id,
                    {
                        "prerequisiteTaskIds": list(prerequisite_ids),
                        **({"actorUserId": actor_user_id} if actor_user_id else {}),
                    },
                ),
                relay_task_event(
                    "task.activity",
                    task_id,
                    {
                        "activity": {
                            "id": new_relay_id("act"),
                            "createdAt": now_iso(),
                            "message": message,
                        }
                    },
                ),
            ],
        )

    def open_prerequisites_for(self, task_ids: list[str]) -> dict[str, list[str]]:
        """Each task's prerequisites that are live and not yet done."""
        if not task_ids:
            return {}
        edges = self.task_prerequisites
        prerequisite = self.tasks.alias("prerequisite")
        waiting: dict[str, list[str]] = defaultdict(list)
        with store_transaction(self.engine) as conn:
            for offset in range(0, len(task_ids), 500):
                rows = conn.execute(
                    select(edges.c.task_id, edges.c.prerequisite_task_id)
                    .join(prerequisite, prerequisite.c.id == edges.c.prerequisite_task_id)
                    .where(edges.c.task_id.in_(task_ids[offset : offset + 500]))
                    .where(prerequisite.c.deleted_at.is_(None))
                    .where(prerequisite.c.status != SATISFIED_STATUS)
                ).all()
                for task_id, prerequisite_id in rows:
                    waiting[str(task_id)].append(str(prerequisite_id))
        return dict(waiting)

    def task_dependents(self, task_id: str) -> list[str]:
        """The live tasks that name this one as a prerequisite."""
        edges = self.task_prerequisites
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(edges.c.task_id)
                .join(self.tasks, self.tasks.c.id == edges.c.task_id)
                .where(edges.c.prerequisite_task_id == task_id)
                .where(self.tasks.c.deleted_at.is_(None))
                .order_by(self.tasks.c.created_at, self.tasks.c.id)
            ).scalars()
            return [str(row) for row in rows]

    def _check_prerequisites(self, conn: Any, task: dict[str, Any]) -> None:
        """Validate the task's new set against its project, under the write
        transaction, before the event is committed."""
        ids = list(task.get("prerequisiteTaskIds") or [])
        project_id = task.get("projectId")
        if not ids or not project_id:
            validate_prerequisites(task, ids, {}, {})
            return
        if self.engine.dialect.name == "postgresql":
            conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:scope, :salt))"),
                {"scope": str(project_id), "salt": _PROJECT_LOCK_SALT},
            )
        project_tasks = {
            str(row["id"]): {"isRoutine": bool(row["is_routine"])}
            for row in conn.execute(
                select(self.tasks.c.id, self.tasks.c.is_routine)
                .where(self.tasks.c.project_id == project_id)
                .where(self.tasks.c.deleted_at.is_(None))
            ).mappings()
        }
        edges = self.task_prerequisites
        graph: dict[str, list[str]] = defaultdict(list)
        for dependent, prerequisite in conn.execute(
            select(edges.c.task_id, edges.c.prerequisite_task_id)
            .join(self.tasks, self.tasks.c.id == edges.c.task_id)
            .where(self.tasks.c.project_id == project_id)
            .where(self.tasks.c.deleted_at.is_(None))
        ).all():
            graph[str(dependent)].append(str(prerequisite))
        validate_prerequisites(task, ids, project_tasks, graph)

    def _replace_prerequisite_rows(
        self, conn: Any, task_pk: str, prerequisite_ids: list[str]
    ) -> None:
        edges = self.task_prerequisites
        conn.execute(delete(edges).where(edges.c.task_id == task_pk))
        for prerequisite_id in prerequisite_ids:
            conn.execute(
                insert(edges).values(task_id=task_pk, prerequisite_task_id=prerequisite_id)
            )
