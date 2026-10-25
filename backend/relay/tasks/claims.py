"""Task dispatch claims and the task-lifetime rules that read them."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from ..core.ids import new_relay_id
from ..core.timestamps import parse_iso


class TaskExecutionActiveError(RuntimeError):
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
    expires_at = parse_iso(claim.get("expiresAt"))
    return bool(expires_at and expires_at > datetime.now(UTC))
