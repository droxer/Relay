"""What a daemon node can run right now: the one reading of a node record.

Agent creation, binding status, placement sync and dispatch routing all ask
the same two questions of a node, so they share these answers.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

LIVE_NODE_STATUSES = frozenset({"ready", "busy", "running"})


def is_live_node(node: Mapping[str, Any]) -> bool:
    """A node that is reachable now and able to take work."""
    return bool(
        node.get("online")
        and not node.get("stale")
        and node.get("status") in LIVE_NODE_STATUSES
    )


def ready_runtimes(nodes: Iterable[Mapping[str, Any]]) -> set[str]:
    """The runtimes these nodes can run, minus any a node disables.

    ``node["agents"]`` carries every agent name whatever is installed, so only
    its ``ready`` entries count. ``supportedAgents`` is the direct form older
    node records and some callers supply.
    """
    supported: set[str] = set()
    disabled: set[str] = set()
    for node in nodes:
        supported |= set(node.get("supportedAgents") or [])
        supported |= {
            kind for kind, status in (node.get("agents") or {}).items() if status == "ready"
        }
        disabled |= set(node.get("disabledAgents") or [])
    return supported - disabled
