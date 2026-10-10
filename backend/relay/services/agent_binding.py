"""An agent's binding status to its Computer.

Derived live, never persisted: it's fully computable from the registry, and
persisting it would only add a synchronization burden.
"""

from __future__ import annotations

from typing import Any

from ..core.computer_identity import computer_id
from ..core.node_readiness import is_live_node, ready_runtimes

AVAILABLE = "available"
COMPUTER_GONE = "computer_gone"
COMPUTER_OFFLINE = "computer_offline"
RUNTIME_MISSING = "runtime_missing"


def binding_status(agent: dict[str, Any], nodes: list[dict[str, Any]]) -> str:
    target = agent.get("computerId")
    if not target:
        return COMPUTER_GONE
    own = [node for node in nodes if computer_id(node) == target]
    if not own:
        return COMPUTER_GONE
    if agent["executorKind"] not in ready_runtimes(own):
        return RUNTIME_MISSING
    if not any(is_live_node(node) for node in own):
        return COMPUTER_OFFLINE
    return AVAILABLE
