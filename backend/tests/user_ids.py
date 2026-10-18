"""The id the database accounts store gives a user created by handle.

Tests create users by handle (``"alice"``) through ``POST /admin/users`` or
``ensure_user``; the store keys them by ``uuid5`` of that handle, and that id
is what every record (``ownerUserId``, ``supervisorUserId``, a node's
``userId``) carries. Logins and handles stay ``"alice"``.
"""

from __future__ import annotations

from relay.security.auth import USER_ENTITY_KIND, database_id_for_reference


def user_id(handle: str) -> str:
    return database_id_for_reference(handle, USER_ENTITY_KIND)
