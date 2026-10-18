"""User handles: the `@name` every surface renders, and resolving one to a user id.

The web mirror is ``web/src/lib/userHandle.ts``; both normalize the same way.
"""

from __future__ import annotations

import re
from typing import Any
from fastapi import HTTPException


USER_HANDLE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")


def normalize_user_handle(value: str) -> str:
    """Canonicalize an admin-entered user handle, or raise 400.

    The handle is rendered as `@alice` and threaded through node paths and
    credential filenames, so it cannot carry whitespace, slashes, or case that
    would make two spellings look like one identity. Lowercasing here rather
    than rejecting keeps the form forgiving; the web form applies the same
    normalization as you type, so the preview never promises a handle the
    backend will not create."""
    handle = (value or "").strip().lstrip("@").strip().lower()
    if not handle:
        raise HTTPException(400, "userId is required.")
    if not USER_HANDLE_PATTERN.match(handle):
        raise HTTPException(
            400,
            "userId must be 2-64 characters of lowercase letters, digits, "
            "dot, dash, or underscore, and start with a letter or digit.",
        )
    return handle


def resolve_user_id(auth_store: Any, user_id: str) -> str:
    """The id `user_id` resolves to in this store (a UUID under the
    database store, the handle itself under the file store)."""
    if hasattr(auth_store, "resolve_user_id"):
        return auth_store.resolve_user_id(user_id)
    return (user_id or "").strip()


def user_record(auth_store: Any, user_id: str) -> dict[str, Any] | None:
    if hasattr(auth_store, "list_users"):
        for user in auth_store.list_users():
            if user.get("id") == user_id:
                return user
    for account in auth_store.list_accounts():
        if account.get("userId") == user_id:
            return {
                # The file store keeps the handle as the id, so the two agree.
                "id": user_id,
                "handle": user_id,
                "displayName": account.get("displayName")
                or account.get("username")
                or user_id,
                "email": account.get("email"),
                "createdAt": account.get("createdAt"),
                "updatedAt": account.get("createdAt"),
            }
    return None
