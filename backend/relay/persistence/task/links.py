"""Task assignment and the task-to-thread links.

A mixin of ``DatabaseTaskStore``; it shares the store's engine and tables
(declared on ``TaskStoreState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from loguru import logger
from sqlalchemy import (
    delete,
    insert,
    select,
    text,
    update,
)
from ..automation_store import insert_outbox_rows, task_outbox_rows
from ..store_common import (
    AgentName,
    _parse_iso,
    new_database_id,
    relay_task_event,
)
from .rules import (
    _HYDRATE_TASK_WRITES,
    _TaskWriteConflict,
    apply_task_events,
    orphaned_by_thread_delete,
)
from .events import (
    _task_session_link_events,
    _task_session_unlink_events,
)
from .rows import (
    task_event_to_row,
    task_to_row,
)
from .state import TaskStoreState


class TaskLinkRows(TaskStoreState):
    def _lock_session_for_link(self, conn: Any, session_id: str) -> None:
        lock_clause = "" if self.engine.dialect.name == "sqlite" else " FOR KEY SHARE"
        session_pk = conn.scalar(
            text("SELECT id FROM sessions WHERE id = :session_id" + lock_clause),
            {"session_id": session_id},
        )
        if not session_pk:
            raise KeyError(f"Unknown session {session_id}.")

    def assign_task(
        self, task_id: str, agent: AgentName, agent_id: str | None = None
    ) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event(
                "task.assigned",
                task_id,
                {
                    "agent": agent,
                    **({"agentId": agent_id} if agent_id else {}),
                },
            ),
        )
        self.append_event(
            task_id, relay_task_event("task.status", task_id, {"status": "assigned"})
        )
        logger.debug("Database task assigned", task_id=task_id, agent=agent)
        return self.record_activity(task_id, f"Assigned to {agent}.", {"agent": agent})

    def set_task_assignment(
        self, task_id: str, agent: AgentName, agent_id: str
    ) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event(
                "task.assigned", task_id, {"agent": agent, "agentId": agent_id}
            ),
        )
        return self.record_activity(
            task_id, f"Assigned to logical agent {agent_id}.", {"agent": agent}
        )

    def set_task_team_assignment(self, task_id: str, team_id: str) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event("task.assigned", task_id, {"teamId": team_id}),
        )
        return self.record_activity(task_id, f"Assigned to team {team_id}.")

    def unassign_task(self, task_id: str) -> dict[str, Any]:
        self.append_event(task_id, relay_task_event("task.unassigned", task_id, {}))
        return self.record_activity(task_id, "Agent assignment cleared.")

    def link_session(self, task_id: str, session_id: str) -> dict[str, Any]:
        task = self.append_events(
            task_id,
            _task_session_link_events(task_id, session_id),
            skip_linked_session_id=session_id,
        )
        logger.debug(
            "Database task linked to session",
            task_id=task_id,
            session_id=session_id,
        )
        return task

    def unlink_session(self, task_id: str, session_id: str) -> dict[str, Any]:
        task = self.get_task(task_id)
        if session_id not in task.get("linkedSessionIds", []):
            return task
        return self.append_events(
            task_id, _task_session_unlink_events(task_id, session_id)
        )

    def unlink_session_in_transaction(
        self,
        conn: Any,
        task_id: str,
        session_id: str,
        *,
        delete_orphan: bool = False,
        deleted_by: str | None = None,
    ) -> dict[str, Any]:
        """Unlink a deleted thread; with `delete_orphan`, drop a task left threadless."""
        row = (
            conn.execute(
                select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                .where(self.tasks.c.id == task_id)
                .with_for_update()
            )
            .mappings()
            .first()
        )
        if not row:
            raise KeyError(task_id)
        current = row["snapshot"] or {}
        if session_id not in current.get("linkedSessionIds", []):
            return current
        events = _task_session_unlink_events(task_id, session_id)
        sequence = int(row["version"] or 0)
        unlinked = apply_task_events(current, events, version=sequence)
        orphaned = delete_orphan and orphaned_by_thread_delete(unlinked)
        if orphaned:
            events = [*events, relay_task_event(
                "task.deleted", task_id,
                {"actorUserId": deleted_by} if deleted_by else {},
            )]
        task = apply_task_events(current, events, version=sequence) if orphaned else unlinked
        claimed = conn.execute(
            update(self.tasks)
            .where(self.tasks.c.id == row["id"], self.tasks.c.version == sequence)
            .values(
                **task_to_row(
                    task,
                    version=sequence + len(events),
                    database_id=row["id"],
                )
            )
        )
        if claimed.rowcount != 1:
            raise _TaskWriteConflict(task_id)
        for offset, event in enumerate(events):
            conn.execute(
                insert(self.events).values(
                    **task_event_to_row(row["id"], sequence + offset, event)
                )
            )
        conn.execute(
            delete(self.task_sessions)
            .where(self.task_sessions.c.task_id == row["id"])
            .where(self.task_sessions.c.session_id == session_id)
        )
        if orphaned:
            logger.info("Database task deleted with its last thread", task_id=task_id, deleted_by=deleted_by)
            if self.emit_automation_events:
                insert_outbox_rows(conn, task_outbox_rows(current, task))
        return self._hydrate_task(task) if _HYDRATE_TASK_WRITES.get() else task

    def _ensure_task_session(
        self, conn: Any, task_pk: str, session_id: str, timestamp: str
    ) -> None:
        existing = conn.execute(
            select(self.task_sessions.c.task_id)
            .where(self.task_sessions.c.task_id == task_pk)
            .where(self.task_sessions.c.session_id == session_id)
        ).first()
        if not existing:
            conn.execute(
                insert(self.task_sessions).values(
                    id=new_database_id(),
                    task_id=task_pk,
                    session_id=session_id,
                    created_at=_parse_iso(timestamp),
                )
            )
