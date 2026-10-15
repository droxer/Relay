"""The stable identity of one Computer.

A daemon node id changes on every reprovision, so it must never be persisted
as an identity. This module is the only place in the codebase that resolves a
computer identity — do not reimplement this priority order anywhere else.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Mapping
from typing import Any


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def computer_id(node: Mapping[str, Any]) -> str:
    """Return the stable identity of the Computer this node belongs to.

    The prefix makes a namespace collision impossible: a managedNodeId that
    happens to equal some machine's machine-id must never resolve to the same
    computer.
    """
    managed_node_id = _clean(node.get("managedNodeId"))
    if managed_node_id:
        return f"managed:{managed_node_id}"
    user_id = _clean(node.get("userId"))
    # The field name is historical: `workspaceId` holds the host machine-id
    # (the daemon's `ensureMachineId()`), not anything about a directory.
    # Do not read it as related to `workspacePath`.
    machine_id = _clean(node.get("workspaceId"))
    if user_id and machine_id:
        return f"device:{user_id}:{machine_id}"
    return f"node:{node['id']}"


def is_provisional_computer_id(value: Any) -> bool:
    """Whether an identity is only the current daemon node fallback.

    A ``node:`` identity is useful for routing while a daemon is registering,
    but it is not durable enough to persist as an agent's or placement's
    Computer identity because the node id changes on reprovisioning.
    """
    return isinstance(value, str) and value.startswith("node:")


def local_enrollment_key(user_id: Any, workspace_path: Any) -> str | None:
    """Return the provisional identity used before a device reports machine-id.

    The stable machine identity is unavailable until the daemon starts. During
    that gap, enrollment retries are the same request when both the user
    and normalized workspace path match. Hashing keeps the indexed value fixed
    length without treating the workspace path as a secret.
    """
    user = _clean(user_id)
    workspace = _clean(workspace_path)
    if not user or not workspace:
        return None
    normalized_workspace = os.path.normcase(os.path.abspath(workspace))
    digest = hashlib.sha256(f"{user}\0{normalized_workspace}".encode()).hexdigest()
    return f"sha256:{digest}"
