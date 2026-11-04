"""Restore capacity waits incorrectly blocked by the manual retry policy."""

from __future__ import annotations

from typing import Any
from sqlalchemy import select

from ..persistence.engine import store_transaction
from ..persistence.tables.tasks import tasks
from ..tasks.claims import dispatch_claim_active
from ..tasks.dispatch_failure import record_dispatch_failure


def requeue_capacity_waits(*, task_store: Any) -> None:
    # A rejected WIP claim never acquired an execution owner or startedAt.
    # Never revive real blocked work or a later human block with a stale outcome.
    with store_transaction(task_store.engine) as conn:
        ids = list(
            conn.scalars(
                select(tasks.c.id).where(
                    tasks.c.status == "blocked",
                    tasks.c.deleted_at.is_(None),
                    tasks.c.snapshot["attention"]["code"].as_string() == "task_wip_limit",
                )
            )
        )
    for task_id in ids:
        with task_store.task_write_scope(task_id) as task:
            if (
                task.get("status") != "blocked"
                or task.get("deletedAt")
                or task.get("startedAt")
                or task.get("executionOwner")
                or dispatch_claim_active(task)
                or task.get("isRoutine")
                or (task.get("attention") or {}).get("code") != "task_wip_limit"
                or (task.get("dispatchOutcome") or {}).get("code") != "task_wip_limit"
            ):
                continue
            task = task_store.update_task(task_id, {"status": "assigned"})
            record_dispatch_failure(task_store, task, code="task_wip_limit", message="Capacity wait")
