"""Daemon registry record rules shared by the database store mixins:
state keys, node registration changes, prunable events, queue limits.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any
from ..db_time import format_db_time
from ..events import daemon_event
from ...core.ids import now_iso


TERMINAL_DAEMON_STATUSES = frozenset({"completed", "failed", "cancelled"})


# Command-lifecycle events describe records that `prune_terminal_records`
# deletes, so they are pruned on the same retention cutoff. Node-lifecycle
# events are otherwise kept indefinitely: `delete_node` hard-deletes the node
# row, which makes the event log the only surviving record of a node incarnation
# (see `historical_managed_runtime_ids`).
PRUNABLE_DAEMON_EVENT_PREFIXES = (
    "daemon.command.",
    "daemon.workspace.",
    # Run-request transitions describe rows retention also removes, and are
    # written several times per run; nothing reads them back.
    "daemon.run_request.",
)


# `daemon.node.seen` is the exception. It was appended per heartbeat by a path
# that has since stopped emitting it, nothing has ever read it, and it carries no
# node payload -- so unlike `daemon.node.registered` it records nothing about an
# incarnation and only accumulates.
PRUNABLE_DAEMON_EVENT_TYPES = frozenset({"daemon.node.seen"})


def daemon_event_is_prunable(event_type: str) -> bool:
    return (
        any(event_type.startswith(prefix) for prefix in PRUNABLE_DAEMON_EVENT_PREFIXES)
        or event_type in PRUNABLE_DAEMON_EVENT_TYPES
    )


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


def daemon_command_queue_limit() -> int:
    raw = os.environ.get("RELAY_DAEMON_MAX_QUEUED_COMMANDS_PER_NODE", "1000")
    try:
        limit = int(raw)
    except ValueError as error:
        raise ValueError(
            "RELAY_DAEMON_MAX_QUEUED_COMMANDS_PER_NODE must be a positive integer."
        ) from error
    if limit <= 0:
        raise ValueError(
            "RELAY_DAEMON_MAX_QUEUED_COMMANDS_PER_NODE must be a positive integer."
        )
    return limit


def _assert_node_run_request_capacity(
    node: dict[str, Any],
    active_requests: list[dict[str, Any]],
    request: dict[str, Any],
) -> None:
    max_concurrent = node.get("maxConcurrentRuns")
    if not isinstance(max_concurrent, int) or max_concurrent <= 0:
        max_concurrent = 1
    available = len(active_requests) < max_concurrent
    if not available:
        raise ValueError("Runtime node capacity is exhausted.")


def _node_for_storage(node: dict[str, Any]) -> dict[str, Any]:
    stored = {**node, "token": None}
    stored.pop("nodeToken", None)
    stored.pop("nodeTokenSecret", None)
    return stored


def _node_for_event(node: dict[str, Any]) -> dict[str, Any]:
    """The stored node minus secrets: daemon events are audit, never pruned."""
    stored = _node_for_storage(node)
    stored.pop("nodeTokenSecret", None)
    return stored


# Advance on every heartbeat by design, so they say nothing about whether a
# registration is materially new.
_NODE_LIVENESS_FIELDS = ("updatedAt", "lastSeenAt", "lastPollAt")


_NODE_LIVENESS_COLUMNS = frozenset({"updated_at", "last_seen_at", "last_poll_at"})


def _comparable_node_value(value: Any) -> Any:
    """Normalize a stored node value for comparison.

    SQLite hands back naive datetimes where the incoming row holds UTC-aware
    ones, so compare timestamps in their formatted form.
    """
    return format_db_time(value) if isinstance(value, datetime) else value


def node_registration_changed(
    previous: dict[str, Any] | None, node: dict[str, Any]
) -> bool:
    """Whether a registration differs from what is already stored.

    Daemons re-register on a heartbeat, and `daemon.node.*` events are never
    pruned (they are the only record of a node incarnation once `delete_node`
    removes the row). Appending an event per heartbeat therefore grows
    `daemon_events` without bound while telling
    `_managed_runtime_identity_map` nothing it does not already know, since it
    folds the events into a dict keyed by node id.
    """
    if previous is None:
        return True
    return {
        key: value
        for key, value in previous.items()
        if key not in _NODE_LIVENESS_FIELDS
    } != {key: value for key, value in node.items() if key not in _NODE_LIVENESS_FIELDS}


# What a draining daemon's `lastPollAt` becomes: a poll so old it can never
# count as fresh. Distinct from "never polled", which gets the benefit of the
# doubt, because the daemon told us it will not take work again.
NODE_POLL_DRAINED_AT = "1970-01-01T00:00:00.000Z"


def preserve_node_poll(
    previous: dict[str, Any] | None, node: dict[str, Any]
) -> dict[str, Any]:
    """A registration says nothing about polling, so the prior observation stays.

    Clearing it on every registration would let a daemon stuck re-registering
    after each failed poll look dispatchable forever.
    """
    if not previous or not previous.get("lastPollAt") or node.get("lastPollAt"):
        return node
    return {**node, "lastPollAt": previous["lastPollAt"]}


def _poll_observation(
    node: dict[str, Any], now: str, polled: bool | None
) -> dict[str, Any]:
    """The `lastPollAt` a liveness write carries: advanced, kept, or (False) drained."""
    if polled:
        return {"lastPollAt": now}
    if polled is False:
        return {"lastPollAt": NODE_POLL_DRAINED_AT}
    if node.get("lastPollAt"):
        return {"lastPollAt": node["lastPollAt"]}
    return {}


def preserve_node_retirement(
    previous: dict[str, Any] | None, node: dict[str, Any]
) -> dict[str, Any]:
    """Keep a durable retirement fence monotonic across stale replica writes."""
    if not previous or not previous.get("retiredAt"):
        return node
    return {
        **node,
        "retiredAt": previous["retiredAt"],
        "status": "deleted" if previous.get("status") == "deleted" else "stopped",
    }


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


NodeSettingValue = str | None | list[str] | dict[str, str]


def node_setting_update(
    node_id: str,
    node: dict[str, Any],
    *,
    field: str,
    value: NodeSettingValue,
    event_type: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if isinstance(value, list):
        normalized_value: NodeSettingValue = list(value)
    elif isinstance(value, dict):
        normalized_value = dict(value)
    else:
        normalized_value = value

    updated = {**node, "updatedAt": now_iso()}
    if normalized_value:
        updated[field] = normalized_value
    else:
        updated.pop(field, None)
    return updated, daemon_event(
        event_type,
        {"nodeId": node_id, field: normalized_value},
    )


def completed_cancel_record(
    record: dict[str, Any], now: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    command = record["command"]
    updated = {
        **record,
        "status": "completed",
        "updatedAt": now,
        "completedAt": now,
    }
    event = daemon_event(
        "daemon.command.completed",
        {
            "nodeId": record["nodeId"],
            "commandId": record["id"],
            "targetCommandId": command["commandId"],
            "runId": command["runId"],
        },
    )
    return updated, event


def _managed_runtime_identity_map(
    events: list[dict[str, Any]],
) -> dict[str, str]:
    identities: dict[str, str] = {}
    for event in events:
        node = event.get("node") if isinstance(event, dict) else None
        if (
            event.get("type") == "daemon.node.registered"
            and isinstance(node, dict)
            and isinstance(node.get("id"), str)
            and isinstance(node.get("managedNodeId"), str)
        ):
            identities[node["id"]] = node["managedNodeId"]
    return identities
