"""Release precedence for the installed and downloadable Relay clients."""

import re
from typing import Any

from .daemon_records import infer_node_location

_VERSION_NUMBER = r"(?:0|[1-9][0-9]*)"
_VERSION_PRERELEASE = rf"(?:{_VERSION_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
CLIENT_VERSION_PATTERN = (
    rf"^{_VERSION_NUMBER}\.{_VERSION_NUMBER}\.{_VERSION_NUMBER}"
    rf"(?:-{_VERSION_PRERELEASE}(?:\.{_VERSION_PRERELEASE})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
CLIENT_VERSION_MAX_LENGTH = 128
_VERSION = re.compile(CLIENT_VERSION_PATTERN)

type ClientVersionKey = tuple[int, int, int, bool, tuple[tuple[int, int | str], ...]]


def client_version_key(value: object) -> ClientVersionKey | None:
    """Parse SemVer precedence, ignoring build metadata."""
    if not isinstance(value, str) or len(value) > CLIENT_VERSION_MAX_LENGTH or not _VERSION.fullmatch(value):
        return None
    release, _, prerelease = value.split("+", 1)[0].partition("-")
    major, minor, patch = map(int, release.split("."))
    identifiers = prerelease.split(".") if prerelease else []
    # Numeric identifiers sort before lexical identifiers; final releases sort last.
    precedence = tuple((0, int(item)) if item.isdigit() else (1, item) for item in identifiers)
    return major, minor, patch, not prerelease, precedence


def client_update_available(node: dict[str, Any], release: ClientVersionKey | None) -> bool:
    if (
        release is None
        or not node.get("lastSeenAt")
        or not node.get("userId")
        or node.get("managedNodeId")
        or infer_node_location(node) != "user-device"
    ):
        return False
    installed = client_version_key(node.get("clientVersion"))
    return installed is not None and installed < release
