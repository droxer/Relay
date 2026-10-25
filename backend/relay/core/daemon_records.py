"""Daemon run and node record vocabulary every layer reads: terminal statuses,
the run-state keys the registry stamps on a record, and node location."""

from __future__ import annotations

from typing import Any

TERMINAL_DAEMON_STATUSES = frozenset({"completed", "failed", "cancelled"})
DISPATCH_CLAIM_ID_STATE_KEY = "_relay_dispatch_claim_id"
DISPATCH_CLAIM_EXPIRES_STATE_KEY = "_relay_dispatch_claim_expires_at"
TERMINAL_EVENT_STATE_KEY = "_relay_terminal_event"
TERMINAL_CLAIM_ID_STATE_KEY = "_relay_terminal_claim_id"


# Set when a restarted daemon reports it admitted this run and will not resume
# it. Kept apart from _relay_recovery_required, which marks a stuck save and
# makes finalization stand down; a late exit report must still finalize.
EXECUTION_INTERRUPTED_STATE_KEY = "_relay_execution_interrupted_at"


# Set when the daemon reports it cannot verify the process exited after a stop.
# The run stays reserved; a person may now report it gone.
EXIT_UNCONFIRMED_STATE_KEY = "_relay_exit_unconfirmed_at"

TERMINAL_CLAIM_EXPIRES_STATE_KEY = "_relay_terminal_claim_expires_at"


# What a draining daemon's `lastPollAt` becomes: a poll so old it can never
# count as fresh. Distinct from "never polled", which gets the benefit of the
# doubt, because the daemon told us it will not take work again.
NODE_POLL_DRAINED_AT = "1970-01-01T00:00:00.000Z"


def infer_node_location(node: dict[str, Any]) -> str | None:
    """Infer location only from explicit or managed control-plane state."""
    explicit = node.get("nodeLocation")
    if explicit:
        return str(explicit)
    if node.get("managedNodeId"):
        return "managed"
    return None


def assigned_node_location(node: dict[str, Any]) -> str:
    """Classify a node during an authorized control-plane assignment."""
    if node.get("nodeLocation"):
        return str(node["nodeLocation"])
    if node.get("managedNodeId"):
        return "managed"
    return "user-device"
