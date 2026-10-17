"""A computer reads as outdated when it lacks a capability the backend knows.

That is only true if a current daemon advertises every one of them, so this
pins the three lists together: the backend's set, the protocol's capability
type, and what the daemon actually sends at registration.
"""

from __future__ import annotations

import re
from pathlib import Path

from relay.daemon_registry.registry import DAEMON_NODE_CAPABILITIES

REPO = Path(__file__).parents[3]
PROTOCOL = (REPO / "packages/relay-core/src/daemon-node-protocol.ts").read_text()
DAEMON = (REPO / "packages/relay-daemon/src/index.ts").read_text()
ADVERTISED = (REPO / "packages/relay-daemon/src/capabilities.ts").read_text()


def _protocol_capabilities() -> set[str]:
    match = re.search(r"type DaemonNodeCapability\s*=([^;]+);", PROTOCOL)
    assert match, "DaemonNodeCapability not found"
    return set(re.findall(r'"([a-z-]+)"', match.group(1)))


def _advertised_capabilities() -> set[str]:
    constants = dict(re.findall(
        r'export const (DAEMON_CAPABILITY_[A-Z_]+): DaemonNodeCapability = "([a-z-]+)";', PROTOCOL,
    ))
    # The bundle manifest is built from the same list, so registration must send it whole.
    assert "capabilities: [...DAEMON_ADVERTISED_CAPABILITIES]" in DAEMON
    match = re.search(r"DAEMON_ADVERTISED_CAPABILITIES[^=]*= \[([^\]]+)\]", ADVERTISED)
    assert match, "daemon advertised capabilities not found"
    advertised = set()
    for entry in (item.strip() for item in match.group(1).split(",")):
        if not entry:
            continue
        literal = re.fullmatch(r'"([a-z-]+)"', entry)
        assert literal or entry in constants, f"unresolved capability {entry}"
        advertised.add(literal.group(1) if literal else constants[entry])
    return advertised


def test_the_backend_knows_exactly_the_protocol_capabilities() -> None:
    assert set(DAEMON_NODE_CAPABILITIES) == _protocol_capabilities()


def test_a_current_daemon_advertises_every_known_capability() -> None:
    assert _advertised_capabilities() == set(DAEMON_NODE_CAPABILITIES)
