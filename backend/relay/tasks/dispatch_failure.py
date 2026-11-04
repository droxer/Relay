"""Dispatch failures require explicit user action; no automatic retry schedule."""

from __future__ import annotations

from typing import Any

from .flow import WIP_WAIT_MESSAGE, is_wip
from .claims import dispatch_claim_active


def safe_dispatch_error_message(error: Exception, *, max_length: int = 300) -> str:
    """Keep user-visible errors bounded and free of stack traces."""
    message = " ".join(str(error).split()) or type(error).__name__
    return message[:max_length]


def record_dispatch_failure(
    task_store: Any,
    task: dict[str, Any],
    *,
    code: str,
    message: str,
) -> dict[str, Any]:
    """Block after the first failure, preserving the cause for manual retry."""
    if code == "task_wip_limit":
        # Preflight is advisory. Re-read under the task lock so a concurrent
        # admission, cancellation, or human block cannot be overwritten.
        with task_store.task_write_scope(task["id"]) as current:
            if current.get("status") not in ("backlog", "assigned", "queued") or dispatch_claim_active(current) or is_wip(current):
                return current
            if current.get("status") != "queued":
                current = task_store.update_task(task["id"], {"status": "queued"})
            if current.get("dispatchRetry"):
                current = task_store.clear_dispatch_retry(task["id"])
            outcome = current.get("dispatchOutcome") or {}
            if outcome.get("state") == "queued" and outcome.get("code") == code:
                return current
            return task_store.record_dispatch_outcome(
                task["id"], "queued", code=code, message=WIP_WAIT_MESSAGE,
            )
    reason = f"{message.rstrip('.')}. Retry this task manually when the problem is resolved."
    task_store.update_task(
        task["id"],
        {
            "status": "blocked",
            "blockerReason": reason,
            "attention": {"code": code, "source": "dispatch"},
        },
    )
    task_store.clear_dispatch_retry(task["id"])
    return task_store.record_dispatch_outcome(
        task["id"], "rejected", code=code, message=reason,
    )
