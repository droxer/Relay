"""Whether a computer runs an older Relay client than this backend ships.

The daemon and backend release together, and every package still reports
version 0.1.0, so a version string cannot tell an old daemon from a new one.
Capabilities can: a current daemon advertises every capability the backend
knows (``DAEMON_NODE_CAPABILITIES``) — ``test_client_version_parity`` pins
that — so a registered computer missing any of them is running an older
client. A capability a daemon only advertises in some modes must never join
that set, or every such computer would read as outdated.
"""

from __future__ import annotations

from typing import Any

from .registry import DAEMON_NODE_CAPABILITIES


def missing_capabilities(
    node: dict[str, Any], known: frozenset[str] = DAEMON_NODE_CAPABILITIES,
) -> list[str]:
    """Capabilities this backend knows that the computer did not advertise.

    Empty for a computer that never registered: a provisioned placeholder has
    reported nothing yet, which is not the same as reporting an old client.
    """
    if not node.get("lastSeenAt"):
        return []
    advertised = set(node.get("capabilities") or [])
    return sorted(known - advertised)


def client_outdated(node: dict[str, Any]) -> bool:
    return bool(missing_capabilities(node))
