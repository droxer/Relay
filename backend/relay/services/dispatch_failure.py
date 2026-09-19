"""Dispatch failures require explicit user action; no automatic retry schedule."""

from __future__ import annotations

from typing import Any


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
    reason = f"{message.rstrip('.')}. Retry this task manually when the problem is resolved."
    task_store.update_task(
        task["id"], {"status": "blocked", "blockerReason": reason},
    )
    task_store.clear_dispatch_retry(task["id"])
    return task_store.record_dispatch_outcome(
        task["id"], "rejected", code=code, message=reason,
    )
