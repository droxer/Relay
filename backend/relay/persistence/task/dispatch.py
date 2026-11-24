"""The dispatch queue: listing dispatchable work, claims, rounds, and retry bookkeeping.

A mixin of ``DatabaseTaskStore``; it shares the store's engine and tables
(declared on ``TaskStoreState``) and is not used on its own.
"""

from __future__ import annotations

from datetime import date as _date
from datetime import datetime, UTC
from typing import Any
from loguru import logger
from sqlalchemy import (
    Boolean,
    Date,
    exists,
    insert,
    literal_column,
    or_,
    select,
    tuple_,
    update,
)
from ...core.ids import new_relay_id
from ...tasks.issue_triage import issue_needs_project
from ...tasks.prerequisites import SATISFIED_STATUS
from ..protocols import TaskDispatchAssignment
from ...core.models import AgentName
from ..db_time import parse_db_time
from ...core.ids import now_iso
from ..events import relay_task_event
from ..engine import store_transaction
from ..tables.tasks import DISPATCH_DUE_DATE, DISPATCH_DUE_MISSING, DISPATCH_LOW, DISPATCH_NOT_HIGH, dispatch_index_where
from .rules import _HYDRATE_TASK_WRITES, apply_task_events
from ...tasks.claims import dispatch_claim_active, new_dispatch_claim
from .events import (
    dispatch_outcome_event,
    dispatch_retry_cleared_event,
    dispatch_retry_event,
    round_event,
)
from .rows import (
    task_claim_sort_key,
    task_event_to_row,
    task_to_row,
)
from .state import TaskStoreState
from .flow import full_wip_scopes


class TaskDispatchRows(TaskStoreState):
    def dispatch_capacity_full(self, scopes: set[str]) -> set[str]:
        if not scopes:
            return set()
        with store_transaction(self.engine) as conn:
            return full_wip_scopes(conn, scopes)

    def list_dispatchable_tasks(
        self, limit: int | None = None, *, after: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        order = (
            literal_column(DISPATCH_NOT_HIGH, Boolean),
            literal_column(DISPATCH_LOW, Boolean),
            literal_column(DISPATCH_DUE_MISSING, Boolean),
            literal_column(DISPATCH_DUE_DATE, Date),
            self.tasks.c.created_at,
            self.tasks.c.id,
        )
        statement = (
            select(self.tasks.c.snapshot)
            .where(dispatch_index_where(self.engine.dialect.name))
            .where(
                or_(
                    self.tasks.c.dispatch_next_attempt_at.is_(None),
                    self.tasks.c.dispatch_next_attempt_at <= datetime.now(UTC),
                )
            )
            .where(~self._waiting_on_prerequisites())
            .order_by(*order)
        )
        if after is not None:
            priority, due, created, task_id = task_claim_sort_key(after)
            statement = statement.where(tuple_(*order) > (
                priority != 0, priority == 2, not after.get("dueDate"), _date.fromisoformat(due), parse_db_time(created), task_id,
            ))
        if limit is not None:
            statement = statement.limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [row["snapshot"] for row in rows]

    def _open_prerequisite_exists(self, conn: Any, task_pk: str) -> bool:
        edges = self.task_prerequisites
        prerequisite = self.tasks.alias("prerequisite")
        return conn.execute(
            select(edges.c.task_id)
            .join(prerequisite, prerequisite.c.id == edges.c.prerequisite_task_id)
            .where(edges.c.task_id == task_pk)
            .where(prerequisite.c.deleted_at.is_(None))
            .where(prerequisite.c.status != SATISFIED_STATUS)
            .limit(1)
        ).first() is not None

    def _waiting_on_prerequisites(self) -> Any:
        """A task with a live prerequisite that is not yet done."""
        edges = self.task_prerequisites
        prerequisite = self.tasks.alias("prerequisite")
        return exists(
            select(edges.c.task_id)
            .join(prerequisite, prerequisite.c.id == edges.c.prerequisite_task_id)
            .where(edges.c.task_id == self.tasks.c.id)
            .where(prerequisite.c.deleted_at.is_(None))
            .where(prerequisite.c.status != SATISFIED_STATUS)
        )

    def claim_next_task_for_agent(
        self, agent: AgentName, assignee_user_id: str | None = None
    ) -> dict[str, Any] | None:
        candidates = [
            task
            for task in self.list_dispatchable_tasks()
            if task.get("assignedAgent") == agent
            and not issue_needs_project(task)
            and not task.get("assignedTeamId")
            and (
                not assignee_user_id
                or task.get("assigneeUserId") == assignee_user_id
            )
        ]
        for task in sorted(candidates, key=task_claim_sort_key):
            claimed = self.claim_task_for_dispatch(
                task["id"],
                agent,
                message=f"Claimed by {agent}.",
                expected_assignment=TaskDispatchAssignment.capture(task),
            )
            if claimed:
                return claimed
        return None

    def claim_task_for_dispatch(
        self,
        task_id: str,
        agent: AgentName,
        message: str | None = None,
        *,
        expected_assignment: TaskDispatchAssignment | None = None,
    ) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
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
                return None
            snapshot = row["snapshot"] or {}
            if (
                snapshot.get("deletedAt")
                or snapshot.get("status") not in ("assigned", "queued")
                or (
                    snapshot.get("assignedAgent")
                    and snapshot.get("assignedAgent") != agent
                )
                or snapshot.get("isRoutine")
                or (
                    expected_assignment is not None
                    and not expected_assignment.matches(snapshot)
                )
                or dispatch_claim_active(snapshot)
                # Rechecked under the row lock: a prerequisite may have been
                # added or reopened since the queue was listed.
                or self._open_prerequisite_exists(conn, row["id"])
            ):
                return None
            existing_claim = snapshot.get("dispatchClaim")
            if existing_claim:
                logger.info(
                    "Recovering expired database task dispatch claim",
                    task_id=task_id,
                    claim_id=existing_claim["id"],
                )
            claim = new_dispatch_claim(
                claim_id=existing_claim.get("id") if existing_claim else None
            )
            events = [
                relay_task_event("task.dispatch_claimed", task_id, {"claim": claim}),
                relay_task_event(
                    "task.activity",
                    task_id,
                    {
                        "activity": {
                            "id": new_relay_id("act"),
                            "createdAt": now_iso(),
                            "message": message
                            or f"Scheduled dispatch claimed by {agent}.",
                            "agent": agent,
                        }
                    },
                ),
            ]
            task_pk = row["id"]
            sequence = int(row["version"] or 0)
            for offset, event in enumerate(events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(task_pk, sequence + offset, event)
                    )
                )
            claimed = apply_task_events(snapshot, events, version=sequence)
            conn.execute(
                update(self.tasks)
                .where(self.tasks.c.id == task_pk)
                .values(
                    **task_to_row(
                        claimed, version=sequence + len(events), database_id=task_pk
                    )
                )
            )
        logger.debug(
            "Database task claimed for scheduled dispatch", task_id=task_id, agent=agent
        )
        return self._hydrate_task(claimed) if _HYDRATE_TASK_WRITES.get() else claimed

    def release_dispatch_claim(self, task_id: str, claim_id: str) -> dict[str, Any]:
        return self.append_event(
            task_id,
            relay_task_event("task.dispatch_released", task_id, {"claimId": claim_id}),
        )

    def record_round(
        self,
        task_id: str,
        *,
        round_result: dict[str, Any] | None = None,
        round_count: int | None = None,
        continuation_session_id: str | None = None,
        clear_continuation: bool = False,
        execution_owner: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            round_event(
                task_id,
                round_result=round_result,
                round_count=round_count,
                continuation_session_id=continuation_session_id,
                clear_continuation=clear_continuation,
            ),
            execution_owner=execution_owner,
        )

    def record_dispatch_outcome(
        self,
        task_id: str,
        state: str,
        *,
        code: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            dispatch_outcome_event(task_id, state, code=code, message=message),
        )

    def record_dispatch_retry(
        self,
        task_id: str,
        *,
        failure_count: int,
        next_attempt_at: str,
        code: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            dispatch_retry_event(
                task_id,
                failure_count=failure_count,
                next_attempt_at=next_attempt_at,
                code=code,
                message=message,
            ),
        )

    def clear_dispatch_retry(self, task_id: str) -> dict[str, Any]:
        task = self.get_task(task_id)
        if not task.get("dispatchRetry"):
            return task
        return self.append_event(task_id, dispatch_retry_cleared_event(task_id))
