"""The Home queue items an Account snoozed.

Home's "Up next" queue is derived on the client from tasks, threads, and
computers. A snooze hides one item until that item changes: the client sends
the item's `key` (`task:<id>`, `permission:<threadId>:<requestId>`, …) and a
`stamp` naming its current state (an `updatedAt`, a status), and shows the
item again as soon as its stamp differs. The server neither interprets keys
nor compares stamps; it keeps the newest entries, one per key, capped.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# The newest snoozes are kept; an old one falling off only means its item can
# reappear on Home.
MAX_HOME_SNOOZES = 200
_MAX_FIELD_LENGTH = 512
_PATCH_KEYS = frozenset({"snooze", "unsnooze"})


def normalize_home_snoozes(value: Any) -> list[dict[str, str]]:
    """The stored list, tolerant of anything a past write left behind."""
    if not isinstance(value, list):
        return []
    entries: dict[str, dict[str, str]] = {}
    for entry in value:
        if not _valid_entry(entry):
            continue
        entries.pop(entry["key"], None)
        entries[entry["key"]] = {"key": entry["key"], "stamp": entry["stamp"]}
    return list(entries.values())[-MAX_HOME_SNOOZES:]


def apply_home_snoozes_patch(current: Any, patch: Any) -> list[dict[str, str]]:
    """Return a new list with `patch` applied; raise ValueError on a bad patch."""
    if not isinstance(patch, Mapping) or not patch:
        raise ValueError("homeSnoozes must be an object with snooze or unsnooze.")
    unknown = set(patch) - _PATCH_KEYS
    if unknown:
        raise ValueError(f"homeSnoozes has unknown field(s): {', '.join(sorted(unknown))}.")
    entries = normalize_home_snoozes(current)
    if "unsnooze" in patch:
        removed = _unsnooze_keys(patch["unsnooze"])
        entries = [entry for entry in entries if entry["key"] not in removed]
    if "snooze" in patch:
        entries = normalize_home_snoozes([*entries, *_snooze_entries(patch["snooze"])])
    return entries


def _snooze_entries(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise ValueError("homeSnoozes.snooze must be a non-empty list.")
    if not all(_valid_entry(entry) for entry in value):
        raise ValueError("homeSnoozes.snooze entries need a key and a stamp.")
    return [{"key": entry["key"], "stamp": entry["stamp"]} for entry in value]


def _unsnooze_keys(value: Any) -> set[str]:
    if not isinstance(value, list) or not all(_valid_text(key) for key in value):
        raise ValueError("homeSnoozes.unsnooze must be a list of keys.")
    return set(value)


def _valid_entry(entry: Any) -> bool:
    return (
        isinstance(entry, Mapping)
        and _valid_text(entry.get("key"))
        and _valid_text(entry.get("stamp"))
    )


def _valid_text(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= _MAX_FIELD_LENGTH
