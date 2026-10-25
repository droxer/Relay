"""Task write rules shared by the task stores: the reducer entrypoint, the
write-conflict signal, and write-scope hydration. Dispatch claims live in
``tasks/claims.py``.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from typing import Any
from .reducer import TASK_EVENT_HANDLERS


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




class _TaskWriteConflict(RuntimeError):
    pass
