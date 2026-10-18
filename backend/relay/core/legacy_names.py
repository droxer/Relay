"""Read-side upgrade for data written before "employee" became "user".

Relay called the person who owns agents and computers an *employee* until
migration ``20261015_0094``. That migration rewrites every database row, but
some state never lives in the database: the file-backed stores under
``.relay/``, legacy session trees, and the bodies older daemons still send.
Those pass through ``upgrade_legacy_names`` so the rest of the code only sees
the new names. The migration uses the same function, so the two cannot
disagree.

Only object *keys*, a few exact enum values (``"employee-device"``,
``"employee-home"``), and a skill assignment's ``targetType`` are rewritten;
free text that happens to mention an employee is left as written.
"""

from __future__ import annotations

import re
from typing import Any

LEGACY_USER_DEVICE_LOCATION = "employee-device"
USER_DEVICE_LOCATION = "user-device"
_LEGACY_VALUES = {
    LEGACY_USER_DEVICE_LOCATION: USER_DEVICE_LOCATION,
    "employee-home": "user-home",
}
# "employee" is too common a word to rewrite everywhere; only these keys held it
# as an enum value.
_LEGACY_ENUM_KEYS = frozenset({"targetType", "target_type"})

_LEGACY_WORD = re.compile(r"employee|Employee|EMPLOYEE")
_REPLACEMENTS = {"employee": "user", "Employee": "User", "EMPLOYEE": "USER"}


def upgrade_legacy_key(key: str) -> str:
    return _LEGACY_WORD.sub(lambda match: _REPLACEMENTS[match.group(0)], key)


def upgrade_legacy_names(value: Any) -> Any:
    """Return ``value`` with legacy employee names upgraded; never mutates."""
    if isinstance(value, dict):
        upgraded: dict[Any, Any] = {}
        for key, item in value.items():
            new_key = upgrade_legacy_key(key) if isinstance(key, str) else key
            if new_key != key and new_key in value:
                continue  # the current key already carries this field
            if new_key in _LEGACY_ENUM_KEYS and item == "employee":
                upgraded[new_key] = "user"
                continue
            upgraded[new_key] = upgrade_legacy_names(item)
        return upgraded
    if isinstance(value, list):
        return [upgrade_legacy_names(item) for item in value]
    if isinstance(value, str):
        return _LEGACY_VALUES.get(value, value)
    return value


# Every employee-era key the runtime wrote into stored JSON. Upgrading is
# rule-based (any key containing "employee"), but a downgrade cannot invert that
# rule -- "userCode" was never an employee key -- so it maps exactly these back.
LEGACY_KEYS = frozenset(
    {
        "employeeId",
        "ownerEmployeeId",
        "actorEmployeeId",
        "assigneeEmployeeId",
        "blockerOwnerEmployeeId",
        "createdByEmployeeId",
        "deletedByEmployeeId",
        "grantedByEmployeeId",
        "supervisorEmployeeId",
        "maxLocalComputersPerEmployee",
        "employee_id",
        "owner_employee_id",
        "actor_employee_id",
        "assignee_employee_id",
        "created_by_employee_id",
        "supervisor_employee_id",
        "_relay_stop_actor_employee_id",
    }
)
_DOWNGRADED_KEYS = {upgrade_legacy_key(key): key for key in LEGACY_KEYS}
_DOWNGRADED_VALUES = {new: old for old, new in _LEGACY_VALUES.items()}


def downgrade_to_legacy_names(value: Any) -> Any:
    """Inverse of ``upgrade_legacy_names`` for the keys Relay actually wrote."""
    if isinstance(value, dict):
        downgraded: dict[Any, Any] = {}
        for key, item in value.items():
            old_key = _DOWNGRADED_KEYS.get(key, key) if isinstance(key, str) else key
            if old_key != key and old_key in value:
                continue
            if key in _LEGACY_ENUM_KEYS and item == "user":
                downgraded[old_key] = "employee"
                continue
            downgraded[old_key] = downgrade_to_legacy_names(item)
        return downgraded
    if isinstance(value, list):
        return [downgrade_to_legacy_names(item) for item in value]
    if isinstance(value, str):
        return _DOWNGRADED_VALUES.get(value, value)
    return value


def contains_legacy_names(value: Any) -> bool:
    """Cheap pre-check so callers can skip values that need no rewrite."""
    if isinstance(value, dict):
        return any(
            (isinstance(key, str) and bool(_LEGACY_WORD.search(key)))
            or (key in _LEGACY_ENUM_KEYS and item == "employee")
            or contains_legacy_names(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(contains_legacy_names(item) for item in value)
    return isinstance(value, str) and value in _LEGACY_VALUES


def with_legacy_user_id(record: dict[str, Any]) -> dict[str, Any]:
    """Mirror ``userId`` as ``employeeId`` for clients older than the rename.

    Only responses an older daemon or supervisor actually reads use this; drop
    it once those have been upgraded everywhere.
    """
    if not record.get("userId") or "employeeId" in record:
        return record
    return {**record, "employeeId": record["userId"]}
