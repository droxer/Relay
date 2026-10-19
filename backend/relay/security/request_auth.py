"""Who a request is: the session cookie, the admin bearer token, and cookie attributes."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request

from .admin_token import verify_admin_token
from ..core import deploy_config
from ..persistence.protocols import AuthStore

USER_COOKIE_NAME = "relay_session"


def user_session_token_from_request(request: Request) -> str | None:
    return request.cookies.get(USER_COOKIE_NAME)


# The account a request's session cookie resolved to, kept for the rest of the
# request so a router-level auth dependency and the handler's own check share
# one lookup.
_REQUEST_ACCOUNT_STATE = "relay_session_account"


def require_user_session(request: Request, auth_store: AuthStore) -> dict[str, Any]:
    state = getattr(request, "state", None)
    cached = getattr(state, _REQUEST_ACCOUNT_STATE, None) if state is not None else None
    if cached is not None:
        return cached
    token = user_session_token_from_request(request)
    if not token:
        raise HTTPException(401, "Authentication required.")
    session = auth_store.get_session_by_token(token)
    if not session:
        raise HTTPException(401, "Session expired or invalid.")
    account = auth_store.get_account_by_id(session["accountId"])
    if not account:
        raise HTTPException(401, "User not found.")
    if state is not None:
        setattr(state, _REQUEST_ACCOUNT_STATE, account)
    return account


def require_admin_session(
    request: Request, auth_store: AuthStore
) -> dict[str, Any]:
    bearer = _bearer_token(request)
    if verify_admin_token(bearer):
        return {
            "id": "admin-token",
            "username": "admin-token",
            "role": "admin",
            "isAdmin": True,
        }
    account = require_user_session(request, auth_store)
    if account.get("role") != "admin":
        raise HTTPException(403, "Admin access required.")
    return account


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    parts = header.split(" ", 1)
    return parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else None


def user_session_cookie_attrs(
    *, max_age_seconds: int, secure: bool | None = None
) -> dict[str, Any]:
    attrs: dict[str, Any] = {
        "key": USER_COOKIE_NAME,
        "httponly": True,
        "samesite": deploy_config.session_cookie_samesite(),
        "max_age": max_age_seconds,
        "path": "/",
        **user_session_cookie_scope(),
    }
    if secure is not None:
        attrs["secure"] = secure
    # A SameSite=None cookie is dropped by the browser unless it is also
    # Secure, so never let the request scheme downgrade a cross-site cookie
    # into one that silently fails to set.
    if attrs["samesite"] == "none":
        attrs["secure"] = True
    return attrs


def user_session_cookie_scope() -> dict[str, Any]:
    """Cookie attributes shared by ``set_cookie`` and ``delete_cookie``.

    A cookie is only deleted when the delete call repeats the domain and path
    it was written with, so both sides read the scope from one place.
    """
    domain = deploy_config.session_cookie_domain()
    return {"domain": domain} if domain else {}


def user_session_cookie_attrs_for_request(
    request: Request, *, max_age_seconds: int
) -> dict[str, Any]:
    return user_session_cookie_attrs(
        max_age_seconds=max_age_seconds,
        secure=deploy_config.cookie_is_secure(request.url.scheme),
    )
