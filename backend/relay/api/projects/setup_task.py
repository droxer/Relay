"""The task each setup or plan draft runs under, kept out of the owner's way.

A draft's task is bookkeeping for the drafting run, not work the owner
schedules. Once the proposal is resolved or superseded its task is closed, and
a draft that never reached a daemon leaves no task behind.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from ...tasks.claims import TaskExecutionActiveError
from ..deps import AppContext


def close_setup_task(ctx: AppContext, setup: dict[str, Any] | None) -> None:
    """Mark the draft's task done unless a run still holds it."""
    task = _open_task(ctx, setup)
    if task is None or task.get("status") == "done":
        return
    try:
        ctx.task_store.update_task_if_not_dispatching(task["id"], {"status": "done"})
    except TaskExecutionActiveError:
        # The run still holds its claim; its own closeout settles the task.
        logger.info("Setup task left to its run", task_id=task["id"])


def discard_setup_task(ctx: AppContext, setup: dict[str, Any] | None) -> None:
    """Delete the draft's task if no run ever claimed it."""
    task = _open_task(ctx, setup)
    if task is None or task.get("executionOwner"):
        # A claimed task belongs to its run, whose closeout records the outcome.
        return
    try:
        ctx.task_store.delete_task(task["id"], reject_active_claim=True)
    except TaskExecutionActiveError:
        logger.info("Setup task kept for its run", task_id=task["id"])


def _open_task(ctx: AppContext, setup: dict[str, Any] | None) -> dict[str, Any] | None:
    task_id = (setup or {}).get("taskId")
    if not task_id:
        return None
    try:
        task = ctx.task_store.get_task(task_id)
    except KeyError:
        return None
    return None if task.get("deletedAt") else task
