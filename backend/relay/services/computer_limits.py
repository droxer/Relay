"""How many personal computers a user may enroll.

The limit is one number resolved from two places — a per-user override when
one is pinned, the org-wide default otherwise — and it is enforced at creation
only. Lowering a limit never disconnects a computer that already exists: an
user over the line keeps working and is simply refused the next one.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from ..persistence.org_settings_store import DEFAULT_MAX_LOCAL_COMPUTERS

USER_DEVICE_LOCATION = "user-device"


def global_max_local_computers(ctx: Any) -> int:
    settings = ctx.org_settings_store.get_settings()
    value = settings.get("maxLocalComputersPerUser")
    return int(value) if value is not None else DEFAULT_MAX_LOCAL_COMPUTERS


def user_override(ctx: Any, user_id: str) -> int | None:
    """The user's pinned limit, or None when they inherit the global."""
    if not user_id:
        return None
    for user in ctx.auth_store.list_users():
        if user.get("id") == user_id:
            value = user.get("maxLocalComputers")
            return int(value) if value is not None else None
    return None


def effective_max_local_computers(ctx: Any, user_id: str) -> int:
    override = user_override(ctx, user_id)
    if override is not None:
        return override
    return global_max_local_computers(ctx)


def count_local_computers(ctx: Any, user_id: str) -> int:
    if not user_id:
        return 0
    return ctx.registry.count_user_device_nodes(user_id)


def decorate_account_limits(ctx: Any, account: dict[str, Any]) -> dict[str, Any]:
    """Attach the caller's own computer limit and usage to a session user.

    Same resolution rule as `decorate_user_limits`, but for the signed-in
    user's `/auth/me` payload so self-service surfaces (My Computer) can gate
    their connect action without an admin-only endpoint. A user with no
    user link cannot enroll a computer, so their payload stays bare.
    """
    user_id = account.get("userId") or ""
    if not user_id:
        return account
    return {
        **account,
        "maxLocalComputers": user_override(ctx, user_id),
        "effectiveMaxLocalComputers": effective_max_local_computers(ctx, user_id),
        "localComputerCount": count_local_computers(ctx, user_id),
    }


def decorate_user_limits(
    ctx: Any, users: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Attach the resolved limit and current usage to user records.

    Resolved server-side so a list render never has to know the inheritance
    rule, and so the global is read once for the whole page.
    """
    global_limit = global_max_local_computers(ctx)
    decorated = []
    for user in users:
        override = user.get("maxLocalComputers")
        override = int(override) if override is not None else None
        decorated.append({
            **user,
            "maxLocalComputers": override,
            "effectiveMaxLocalComputers": (
                override if override is not None else global_limit
            ),
            "localComputerCount": count_local_computers(ctx, user.get("id", "")),
        })
    return decorated


def assert_local_computer_allowed(ctx: Any, user_id: str) -> None:
    """Refuse a new personal computer for a user already at their limit.

    Call this only on a path that would actually create a computer — adopting
    an already-enrolled workspace must stay possible at the limit, or an
    user could not restart their own daemon.
    """
    limit = effective_max_local_computers(ctx, user_id)
    current = count_local_computers(ctx, user_id)
    if current < limit:
        return
    raise HTTPException(
        409,
        f"This user already has {current} of {limit} allowed personal "
        "computers. Disconnect one, or raise the limit in admin settings.",
    )
