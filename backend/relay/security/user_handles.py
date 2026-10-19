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


def slugify_handle(value: str | None) -> str:
    """Best-effort handle from free text, matching the admin form's grammar.

    Used only for rows that predate the handle column or were created outside
    the admin form; a real handle is stored verbatim."""
    lowered = (value or "").strip().lower()
    slug = re.sub(r"[^a-z0-9._-]+", "-", lowered).strip("-.")
    slug = re.sub(r"-{2,}", "-", slug)
    if len(slug) < 2:
        return ""
    return slug[:64]


def user_handle_or_none(value: str | None) -> str | None:
    """``normalize_user_handle`` for data rather than a request: None, not 400."""
    try:
        return normalize_user_handle(value or "")
    except HTTPException:
        return None


def resolve_user_id(auth_store: Any, user_id: str) -> str:
    """The id `user_id` resolves to in this store (a handle becomes the
    user's UUID)."""
    return auth_store.resolve_user_id(user_id)


def user_record(auth_store: Any, user_id: str) -> dict[str, Any] | None:
    return next((user for user in auth_store.list_users() if user.get("id") == user_id), None)
