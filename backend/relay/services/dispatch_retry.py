"""Shared dispatch retry policy for scheduled and manual task dispatch.

Both dispatch paths (the background scheduler and the manual dispatcher) must
persist retry state under identical rules, so the failure-count progression,
backoff shape, jitter bound, and budget-exhaustion blocking live here exactly
once. State changes go through the task store's event log; this module only
decides what to record.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

MAX_DISPATCH_RETRY_DELAY_SECONDS = 3600.0
DEFAULT_DISPATCH_RETRY_BASE_SECONDS = 10.0
# Bounded jitter: the persisted deadline lands within ±20% of the capped
# exponential delay so restarted backends do not retry in lockstep.
DISPATCH_RETRY_JITTER_RATIO = 0.2
DEFAULT_MAX_CONSECUTIVE_DISPATCH_FAILURES = 10
DISPATCH_RETRY_EXHAUSTED_CODE = "dispatch_retry_exhausted"


def dispatch_retry_delay(
    failure_count: int,
    *,
    base_seconds: float,
    sample: Callable[[], float] = random.random,
) -> float:
    """Capped exponential delay with bounded jitter.

    `sample` returns a value in [0, 1) (like `random.random`); inject a fixed
    callable in tests for deterministic deadlines.
    """
    delay = min(
        base_seconds * (2**failure_count), MAX_DISPATCH_RETRY_DELAY_SECONDS
    )
    spread = delay * DISPATCH_RETRY_JITTER_RATIO
    return delay - spread + (2 * spread * sample())


def safe_dispatch_error_message(error: Exception, *, max_length: int = 300) -> str:
    """User-visible failure summary: the exception message, flattened to one
    line and bounded. Never includes a stack trace."""
    message = " ".join(str(error).split()) or type(error).__name__
    return message[:max_length]


def record_dispatch_retry(
    task_store: Any,
    task: dict[str, Any],
    *,
    code: str,
    message: str,
    base_seconds: float = DEFAULT_DISPATCH_RETRY_BASE_SECONDS,
    max_failures: int = DEFAULT_MAX_CONSECUTIVE_DISPATCH_FAILURES,
    sample: Callable[[], float] = random.random,
) -> dict[str, Any]:
    """Persist one consecutive dispatch failure and block an exhausted budget.

    The count accumulates from the task's persisted retry state so it survives
    backend restarts. When the failure budget is spent the task is blocked
    rather than retried forever; a manual retry clears the state on success.
    """
    retry = task.get("dispatchRetry") or {}
    failure_count = int(retry.get("failureCount") or 0) + 1
    next_attempt_at = datetime.now(UTC) + timedelta(
        seconds=dispatch_retry_delay(
            failure_count, base_seconds=base_seconds, sample=sample
        )
    )
    updated = task_store.record_dispatch_retry(
        task["id"],
        failure_count=failure_count,
        next_attempt_at=next_attempt_at.isoformat().replace("+00:00", "Z"),
        code=code,
        message=message,
    )
    if failure_count >= max_failures:
        task_store.record_dispatch_outcome(
            task["id"],
            "rejected",
            code=DISPATCH_RETRY_EXHAUSTED_CODE,
            message=(
                f"Dispatch failed {failure_count} times in a row "
                f"({code}); the task is blocked until retried manually."
            ),
        )
        updated = task_store.update_task(task["id"], {"status": "blocked"})
    return updated
