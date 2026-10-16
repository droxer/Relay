from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from ..automations.service import automation_triggers_enabled
from ..core import deploy_config
from ..security.auth import (
    USER_COOKIE_NAME,
    require_admin_session,
    require_user_session,
    user_session_cookie_attrs_for_request,
    user_session_cookie_scope,
    user_session_token_from_request,
)
from ..security.edge import client_ip
from ..services.computer_limits import decorate_account_limits
from .deps import AppContextDep
from .helpers import JsonBodyDep, string_field

router = APIRouter()


def _auth_rate_key(request: Request, scope: str, identity: str = "") -> str:
    return f"{scope}:{client_ip(request)}:{identity.strip().lower()}"


def _consume_auth_attempt(request: Request, key: str) -> None:
    retry_after = request.app.state.auth_rate_limiter.consume(key)
    if retry_after is not None:
        raise HTTPException(
            429,
            "Too many authentication attempts. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )


@router.get("/auth/status")
def auth_status(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return {
        "requiresBootstrap": not ctx.auth_store.has_accounts(),
        # Public, so the sign-in screen can offer "Request access" only when
        # the waitlist routes are mounted.
        "waitlistEnabled": bool(getattr(request.app.state, "waitlist_enabled", False)),
        # Whether "Forgot password?" can deliver: self-serve reset needs mail.
        "passwordResetEnabled": request.app.state.password_reset.self_serve_enabled,
    }


@router.get("/auth/me")
def auth_me(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    account = require_user_session(request, ctx.auth_store)
    return {
        "authenticated": True,
        "user": decorate_account_limits(ctx, ctx.auth_store._public_account(account)),
        # Server switches every signed-in user's UI depends on; admin
        # settings are admin-only, and users edit automations too.
        "capabilities": {"automationTriggers": automation_triggers_enabled()},
    }


@router.patch("/auth/preferences")
def update_auth_preferences(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    account = require_user_session(request, ctx.auth_store)
    body = _request_body
    theme = string_field(body, "theme") if "theme" in body else None
    language = string_field(body, "language") if "language" in body else None
    if theme is None and language is None:
        raise HTTPException(400, "theme or language is required.")
    try:
        updated = ctx.auth_store.update_user_preferences(
            account["id"],
            theme=theme,
            language=language,
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    # The client replaces its session user with this response, so it must
    # carry the same decorated fields as /auth/me and /auth/login — dropping
    # them here would ungate the connect-computer CTA until the next reload.
    return {"user": decorate_account_limits(ctx, updated)}


@router.post("/auth/bootstrap")
def auth_bootstrap(
    request: Request,
    response: Response,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    body = _request_body
    rate_key = _auth_rate_key(request, "bootstrap")
    _consume_auth_attempt(request, rate_key)
    try:
        account = ctx.auth_store.bootstrap_with_token(
            string_field(body, "token"),
            string_field(body, "username"),
            string_field(body, "password"),
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    request.app.state.auth_rate_limiter.reset(rate_key)
    session = ctx.auth_store.create_session(account["id"])
    attrs = user_session_cookie_attrs_for_request(
        request, max_age_seconds=ctx.auth_store.session_ttl_seconds
    )
    response.set_cookie(value=session["token"], **attrs)
    return {"user": account}


@router.post("/auth/login")
def auth_login(
    request: Request,
    response: Response,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    body = _request_body
    username = string_field(body, "username")
    rate_key = _auth_rate_key(request, "login", username)
    _consume_auth_attempt(request, rate_key)
    account = ctx.auth_store.authenticate(username, string_field(body, "password"))
    if not account:
        raise HTTPException(401, "Invalid username or password.")
    request.app.state.auth_rate_limiter.reset(rate_key)
    session = ctx.auth_store.create_session(account["id"])
    attrs = user_session_cookie_attrs_for_request(
        request, max_age_seconds=ctx.auth_store.session_ttl_seconds
    )
    response.set_cookie(value=session["token"], **attrs)
    return {"user": decorate_account_limits(ctx, ctx.auth_store._public_account(account))}


@router.post("/auth/logout")
def auth_logout(
    request: Request, response: Response, ctx: AppContextDep
) -> dict[str, bool]:
    token = user_session_token_from_request(request)
    if token:
        ctx.auth_store.delete_session(token)
    # Deleting a cookie only works when the attributes match the ones it was
    # written with, so mirror the configured scope and SameSite here.
    response.delete_cookie(
        key=USER_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite=deploy_config.session_cookie_samesite(),
        secure=deploy_config.cookie_is_secure(request.url.scheme),
        **user_session_cookie_scope(),
    )
    return {"ok": True}


@router.get("/admin/version")
def control_panel_version(request: Request, ctx: AppContextDep) -> dict[str, str]:
    require_admin_session(request, ctx.auth_store)
    return {"version": request.app.state.control_panel_version}
