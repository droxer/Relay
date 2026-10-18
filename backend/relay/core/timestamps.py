"""ISO-8601 timestamp parsing shared by every layer.

Relay writes UTC timestamps with a trailing ``Z``; older records and SQLite
reads can be naive. Both parse to an aware UTC ``datetime`` here so callers can
compare them without a naive/aware ``TypeError``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def parse_iso(value: Any) -> datetime | None:
    """Parse an ISO timestamp, returning ``None`` for anything unparseable."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def iso_epoch_ms(value: Any) -> float | None:
    """Milliseconds since the epoch for an ISO timestamp, or ``None``."""
    parsed = parse_iso(value)
    return None if parsed is None else parsed.timestamp() * 1000
