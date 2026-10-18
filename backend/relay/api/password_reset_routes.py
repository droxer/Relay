"""Password reset over HTTP: the public forgot/reset pages and the admin link.

The public answers are deliberately uniform: every well-formed request is a
202 whether or not an Account matched, and every dead link one 404. Tokens
travel in POST bodies, never a path, so no access log records one.

Only asking for a link needs email (``self_serve_enabled``); redeeming one does
not, because an admin can hand out a link on an install that has no mail.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from ..core.deploy_config import public_web_url
from ..security.auth import require_admin_session
from ..security.edge import client_ip
from ..services.password_reset import (
    PasswordResetService,
    ResetNotLiveError,
    normalize_reset_identifier,
    trusted_web_origin,
)
from .deps import AppContextDep, app_context
from .node_install import backend_base_url
from .bodies import JsonBodyDep, string_field

router = APIRouter()

_RESET_NOT_LIVE = "This reset link is invalid or has expired."


def _service(request: Request) -> PasswordResetService:
    return app_context(request).password_reset


def _limit(request: Request, limiter_name: str, key: str) -> None:
    retry_after = getattr(app_context(request), limiter_name).consume(key)
    if retry_after is not None:
        raise HTTPException(
            429, "Too many requests. Try again later.", headers={"Retry-After": str(retry_after)}
        )


def _admin_web_origin(request: Request) -> str:
    # The admin sees this URL before handing it over, so falling back to the
    # request's own origin is safe here — unlike an emailed self-serve link.
    return public_web_url() or backend_base_url(request)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


@router.post("/auth/password-reset", status_code=202)
def request_password_reset(
    request: Request, background: BackgroundTasks, *, _request_body: JsonBodyDep
) -> dict[str, bool]:
    service = _service(request)
    web_origin = trusted_web_origin()
    if not service.self_serve_enabled or web_origin is None:
        raise HTTPException(404, "Not Found")
    # Per IP only. One inbox is protected by the per-account throttle in the
    # store; a per-identifier bucket here would let anyone lock a person out
    # of resetting by spending it on their username.
    _limit(request, "password_reset_rate_limiter", f"password-reset:ip:{client_ip(request)}")
    try:
        identifier = normalize_reset_identifier(_request_body.get("identifier"))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    locale = _request_body.get("locale")
    background.add_task(
        service.request,
        identifier,
        locale=locale if isinstance(locale, str) else None,
        web_origin=web_origin,
    )
    return {"ok": True}


@router.post("/auth/password-reset/lookup")
def lookup_password_reset(request: Request, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    _limit(request, "auth_rate_limiter", f"password-reset-lookup:{client_ip(request)}")
    try:
        live = _service(request).lookup(string_field(_request_body, "token"))
    except ResetNotLiveError as error:
        raise HTTPException(404, _RESET_NOT_LIVE) from error
    return {"reset": {"username": live.account.username, "expiresAt": _iso(live.expires_at)}}


@router.post("/auth/password-reset/complete")
def complete_password_reset(
    request: Request, background: BackgroundTasks, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    service = _service(request)
    _limit(request, "auth_rate_limiter", f"password-reset-complete:{client_ip(request)}")
    try:
        account = service.complete(
            string_field(_request_body, "token"), string_field(_request_body, "password")
        )
    except ResetNotLiveError as error:
        raise HTTPException(404, _RESET_NOT_LIVE) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    background.add_task(service.send_changed_notice, account)
    return {"ok": True, "username": account.username}


@router.post("/admin/users/{user_id}/password-reset")
def admin_password_reset(user_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        issued = _service(request).admin_issue(user_id, web_origin=_admin_web_origin(request))
    except KeyError as error:
        raise HTTPException(404, "User not found.") from error
    return {"url": issued.url, "expiresAt": _iso(issued.expires_at), "delivery": issued.delivery}
