"""Managed-node lifecycle vocabulary and the validation rules every store applies.

A managed node is admin-provisioned capacity; its records live in
``persistence/managed_node_store.py``. Nothing here does IO.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import AGENT_NAMES

MANAGED_NODE_DESIRED_STATES = frozenset({"running", "stopped", "deleted"})
# "pooled" and "shared" are reserved for future multi-user node sharing;
# only "dedicated" is wired into agent placement sync today, so the other
# modes are rejected rather than silently accepted with no agents ever synced.
MANAGED_NODE_ASSIGNMENT_MODES = frozenset({"dedicated"})
MANAGED_NODE_SANDBOX_MODES = frozenset({"boxlite"})
MANAGED_NODE_PHASES = frozenset({
    "requested",
    "allocating",
    "bootstrapping",
    "registering",
    "recovering",
    "ready",
    "draining",
    "stopped",
    "deleting",
    "deleted",
    "failed",
})
PROVISIONING_ATTEMPT_STATUSES = frozenset({
    "pending",
    "claimed",
    "allocating",
    "bootstrapping",
    "registering",
    "succeeded",
    "failed",
    "cancelled",
})
TERMINAL_ATTEMPT_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
# Terminal attempts retained per node. A node that cannot provision produces one
# attempt (and one enrollment grant) per reconcile pass, so unbounded history
# would grow the store forever and slow every list_attempts scan with it.
ATTEMPT_HISTORY_LIMIT = 20


@dataclass(frozen=True)
class ManagedCapacityResolution:
    node: dict[str, Any]
    provisioning_requested: bool


def _managed_node_status(node: dict[str, Any]) -> str:
    desired_state = node.get("desiredState")
    phase = node.get("phase")
    if desired_state != "running":
        return "stopped"
    if phase in ("ready", "failed"):
        return "failed"
    return "provisioning"


def managed_node_placeholder(node: dict[str, Any]) -> dict[str, Any]:
    """Present desired managed capacity before its current runtime is online."""
    conditions = node.get("conditions") or []
    last_error = conditions[-1].get("message") if conditions else None
    return {
        "id": node["id"],
        "managedNodeId": node["id"],
        "displayName": node.get("displayName") or node["id"],
        **({"userId": node["userId"]} if node.get("userId") else {}),
        "sandboxMode": node.get("sandboxMode") or "boxlite",
        "nodeLocation": "managed",
        "status": _managed_node_status(node),
        "agents": {agent: "unknown" for agent in AGENT_NAMES},
        "createdAt": node["createdAt"],
        "updatedAt": node["updatedAt"],
        "queuedCommandCount": 0,
        "activeRuns": [],
        "online": False,
        # Never seen a heartbeat, so staleness does not apply — the placeholder
        # status (provisioning/stopped/failed) must survive visualStatus.
        "stale": False,
        "provisioningPlaceholder": True,
        **({"lastError": last_error} if last_error else {}),
    }


def validate_managed_sandbox_mode(value: Any) -> None:
    if value not in MANAGED_NODE_SANDBOX_MODES:
        raise ValueError("Managed nodes require sandboxMode boxlite.")


def validate_managed_provider(payload: dict[str, Any]) -> None:
    """Reject a malformed provider name.

    The set of usable providers belongs to whichever supervisor reconciles the
    node, not to the backend, so an unknown-but-well-formed name is reported by
    the reconciler as a ProviderAvailable condition instead of being rejected
    here. Only shapes no reconciler could ever resolve are refused.
    """
    if "provider" not in payload or payload["provider"] is None:
        return
    provider = payload["provider"]
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError("provider must be a non-empty string.")
