"""Task dispatch claims and their lease checks."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from ..core.ids import new_relay_id
from ..core.timestamps import parse_iso


class TaskExecutionActiveError(RuntimeError):
    pass


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
