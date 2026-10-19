"""Runtime statuses a daemon reports for each executor on a computer.

Mirrors `DaemonAgentHealthStatus` in relay-core: `ready`; `failed` (installed
but could not connect to its account or provider); `unavailable` (not
installed); `unresponsive` (its check hung). A node record reads `unknown` for
a runtime that never reported. A stopped computer is liveness, derived on
read, never a runtime status.
"""

from __future__ import annotations

AGENT_RUNTIME_STATUSES = frozenset({"ready", "failed", "unavailable", "unresponsive"})

_NOT_READY_REASONS = {
    "failed": "failed to connect",
    "unavailable": "is not installed",
    "unresponsive": "stopped responding",
}


def executor_not_ready_message(executor_kind: str, status: str | None, *, prefix: str = "") -> str:
    """Why `executor_kind` cannot take work on a node, by its reported status."""
    reason = _NOT_READY_REASONS.get(status or "")
    subject = f"{prefix}{executor_kind}"
    if reason is None:
        return f"{subject} is not ready on this runtime node."
    return f"{subject} is not ready on this runtime node: it {reason}."
