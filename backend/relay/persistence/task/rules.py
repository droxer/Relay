"""Task write rules shared by the task stores: dispatch claims, retries, the
reducer entrypoint, and write-scope hydration.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timedelta, UTC
from typing import Any
from ...core.ids import new_relay_id
from .reducer import TASK_EVENT_HANDLERS
from ..db_time import parse_db_time


_HYDRATE_TASK_WRITES = ContextVar("hydrate_task_writes", default=True)


@contextmanager
def compact_task_writes() -> Iterator[None]:
    """Opt background bookkeeping out of full mutation response histories."""
    token = _HYDRATE_TASK_WRITES.set(False)
    try:
        yield
    finally:
        _HYDRATE_TASK_WRITES.reset(token)


def apply_task_events(
    snapshot: dict[str, Any], events: list[dict[str, Any]], *, version: int
) -> dict[str, Any]:
    task = deepcopy(snapshot)
    task.pop("events", None)
    task.pop("activity", None)
    for event in events:
        task["updatedAt"] = event["timestamp"]
        if event["type"] == "task.activity":
            task["activityCount"] = int(task.get("activityCount") or 0) + 1
            task["lastActivity"] = event["activity"]
        else:
            handler = TASK_EVENT_HANDLERS.get(event["type"])
            if handler:
                handler(task, event)
    task["eventCount"] = version + len(events)
    return task


class TaskExecutionActiveError(RuntimeError):
    pass


class _TaskWriteConflict(RuntimeError):
    pass


def orphaned_by_thread_delete(task: dict[str, Any]) -> bool:
    """A task whose last thread was just deleted goes with it.

    An automation outlives any one run, a task with other rounds keeps them,
    and a task mid-dispatch is about to get a new thread.
    """
    return not (
        task.get("isRoutine")
        or task.get("deletedAt")
        or task.get("linkedSessionIds")
        or dispatch_claim_active(task)
    )


def new_dispatch_claim(
    *, claim_id: str | None = None, lease_seconds: int = 60
) -> dict[str, str]:
    claimed_at = datetime.now(UTC)
    return {
        "id": claim_id or new_relay_id("claim"),
        "claimedAt": claimed_at.isoformat().replace("+00:00", "Z"),
        "expiresAt": (claimed_at + timedelta(seconds=lease_seconds))
        .isoformat()
        .replace("+00:00", "Z"),
    }


def dispatch_claim_active(task: dict[str, Any]) -> bool:
    claim = task.get("dispatchClaim")
    if not isinstance(claim, dict):
        return False
    expires_at = parse_db_time(claim.get("expiresAt"))
    return bool(expires_at and expires_at > datetime.now(UTC))
