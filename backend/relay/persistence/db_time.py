"""Converting database datetimes to and from Relay's wire timestamps."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import overload


def parse_db_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def require_db_time(value: str) -> datetime:
    """Parse a timestamp the caller knows is present (e.g. ``now_iso()``)."""
    parsed = parse_db_time(value)
    if parsed is None:
        raise ValueError("Expected a non-empty ISO-8601 timestamp.")
    return parsed


@overload
def format_db_time(value: datetime) -> str: ...
@overload
def format_db_time(value: None) -> None: ...
@overload
def format_db_time(value: datetime | None) -> str | None: ...
def format_db_time(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        # SQLite's DATETIME result has no timezone offset. Relay writes all
        # timestamps as UTC, so never reinterpret a database value in the
        # host's local timezone when formatting it back onto the wire.
        value = value.replace(tzinfo=UTC)
    return (
        value.astimezone(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
