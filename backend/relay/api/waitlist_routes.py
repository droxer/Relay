"""Waitlist HTTP routes: the public join and invite pages, and the admin queue.

Mounted only when ``RELAY_WAITLIST_ENABLED`` is on (``is_waitlist_route``).
The public answers are deliberately uniform — every valid join is a 202 and
every dead invite a 404 — so neither reveals whether an email is known. Invite
tokens travel in POST bodies, never a path, so no access log records one.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response

from ..core.deploy_config import public_web_url
from ..persistence.waitlist_store import WAITLIST_STATUSES, WaitlistConflictError
from ..security.auth import require_admin_session, user_session_cookie_attrs_for_request
from ..security.edge import client_ip
from ..security.passwords import validate_password
from ..services.computer_limits import decorate_account_limits
from ..services.waitlist import (
    InviteNotLiveError,
    WaitlistFullError,
    WaitlistService,
    WaitlistValidationError,
)
from .deps import AppContextDep, app_context
from .node_install import backend_base_url
from ..security.user_handles import USER_HANDLE_PATTERN, normalize_user_handle, resolve_user_id, user_record
from .bodies import JsonBodyDep, string_field

router = APIRouter()

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
_INVITE_NOT_LIVE = "This invite link is no longer valid."
_HANDLE_UNSAFE = re.compile(r"[^a-z0-9._-]+")


def _service(request: Request) -> WaitlistService:
    service = app_context(request).waitlist
    if service is None:  # The routes are mounted only with the waitlist on.
        raise HTTPException(404, "Not Found")
    return service


def _limit(request: Request, limiter_name: str, scope: str) -> None:
    key = f"{scope}:{client_ip(request)}"
    retry_after = getattr(app_context(request), limiter_name).consume(key)
    if retry_after is not None:
        raise HTTPException(
            429, "Too many requests. Try again later.", headers={"Retry-After": str(retry_after)}
        )


def suggest_handle(email: str) -> str:
    """A handle the join form can prefill from the email's local part."""
    candidate = _HANDLE_UNSAFE.sub("-", email.split("@", 1)[0].lower()).strip("._-")[:64]
    return candidate if USER_HANDLE_PATTERN.match(candidate) else ""


@contextmanager
def _entry_errors() -> Iterator[None]:
    """Map the service's entry errors onto HTTP answers."""
    try:
        yield
    except KeyError as error:
        raise HTTPException(404, "Waitlist entry not found.") from error
    except WaitlistConflictError as error:
        raise HTTPException(409, str(error)) from error
    except WaitlistValidationError as error:
        raise HTTPException(400, str(error)) from error


def _web_origin(request: Request) -> str:
    return public_web_url() or backend_base_url(request)


# --- public -----------------------------------------------------------------


@router.post("/waitlist", status_code=202)
def join_waitlist(
    request: Request, background: BackgroundTasks, *, _request_body: JsonBodyDep
) -> dict[str, bool]:
    _limit(request, "waitlist_rate_limiter", "waitlist-join")
    service = _service(request)
    try:
        created = service.join(_request_body)
    except WaitlistValidationError as error:
        raise HTTPException(400, str(error)) from error
    except WaitlistFullError as error:
        raise HTTPException(503, str(error)) from error
    if created is not None:
        background.add_task(service.send_confirmation, created)
    return {"ok": True}


@router.post("/waitlist/invites/lookup")
def lookup_invite(request: Request, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    _limit(request, "auth_rate_limiter", "waitlist-invite-lookup")
    try:
        entry = _service(request).live_invite(string_field(_request_body, "token"))
    except InviteNotLiveError as error:
        raise HTTPException(404, _INVITE_NOT_LIVE) from error
    return {
        "invite": {
            "email": entry["email"],
            "name": entry.get("name"),
            "suggestedHandle": suggest_handle(entry["email"]),
            "expiresAt": entry["inviteExpiresAt"],
        }
    }


@router.post("/waitlist/invites/accept")
def accept_invite(
    request: Request,
    response: Response,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    _limit(request, "auth_rate_limiter", "waitlist-invite-accept")
    service = _service(request)
    token = string_field(_request_body, "token")
    try:
        entry = service.live_invite(token)
    except InviteNotLiveError as error:
        raise HTTPException(404, _INVITE_NOT_LIVE) from error
    handle = normalize_user_handle(string_field(_request_body, "handle"))
    password = string_field(_request_body, "password")
    display_name = entry.get("name") or handle
    # Checked before the invite is claimed so the common mistakes are answered
    # without touching it; create_account re-validates either way.
    try:
        validate_password(password, identifiers=(handle, display_name, entry["email"]))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if user_record(ctx.auth_store, resolve_user_id(ctx.auth_store, handle)):
        raise HTTPException(409, f"The handle @{handle} is taken.")

    def create_account(claimed: dict[str, Any]) -> dict[str, Any]:
        return ctx.auth_store.create_account(
            handle,
            password,
            role="user",
            email=claimed["email"],
            user_id=handle,
            display_name=display_name,
        )

    try:
        account = service.accept(token, create_account)
    except InviteNotLiveError as error:
        raise HTTPException(404, _INVITE_NOT_LIVE) from error
    except ValueError as error:
        message = str(error)
        if "already exists" in message:
            raise HTTPException(409, f"The handle @{handle} is taken.") from error
        raise HTTPException(400, message) from error
    session = ctx.auth_store.create_session(account["id"])
    attrs = user_session_cookie_attrs_for_request(
        request, max_age_seconds=ctx.auth_store.session_ttl_seconds
    )
    response.set_cookie(value=session["token"], **attrs)
    return {"user": decorate_account_limits(ctx, account)}


# --- admin ------------------------------------------------------------------


@router.get("/admin/waitlist")
def list_waitlist(
    request: Request,
    ctx: AppContextDep,
    status: str | None = None,
    q: str | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if status is not None and status not in WAITLIST_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(WAITLIST_STATUSES)}.")
    if limit < 1 or limit > MAX_PAGE_SIZE or offset < 0:
        raise HTTPException(400, f"limit must be 1-{MAX_PAGE_SIZE} and offset non-negative.")
    query = (q or "").strip() or None
    return _service(request).list(status=status, query=query, limit=limit, offset=offset)


@router.post("/admin/waitlist/invite-batch")
def invite_waitlist_batch(
    request: Request,
    background: BackgroundTasks,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    ids = body.get("ids")
    if ids is not None and (not isinstance(ids, list) or not all(isinstance(i, str) for i in ids)):
        raise HTTPException(400, "ids must be a list of entry ids.")
    count = body.get("count")
    if count is not None and (isinstance(count, bool) or not isinstance(count, int)):
        raise HTTPException(400, "count must be a whole number.")
    service = _service(request)
    with _entry_errors():
        invites, pending = service.invite_batch(
            count=count, ids=ids, invited_by=account.get("userId"), web_origin=_web_origin(request)
        )
    # Sent after the response, so the links reach the admin however slow the
    # mail service is; each entry's delivery status moves from queued.
    background.add_task(service.deliver_invites, pending)
    return {"invites": invites}


@router.post("/admin/waitlist/{entry_id}/invite")
def invite_waitlist_entry(entry_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    with _entry_errors():
        return _service(request).invite(
            entry_id, invited_by=account.get("userId"), web_origin=_web_origin(request)
        )


@router.post("/admin/waitlist/{entry_id}/decline")
def decline_waitlist_entry(entry_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    with _entry_errors():
        return {"entry": _service(request).decline(entry_id)}


@router.patch("/admin/waitlist/{entry_id}")
def update_waitlist_entry(
    entry_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if "adminNote" not in _request_body:
        raise HTTPException(400, "adminNote is required.")
    with _entry_errors():
        return {"entry": _service(request).set_note(entry_id, _request_body["adminNote"])}


@router.delete("/admin/waitlist/{entry_id}")
def erase_waitlist_entry(entry_id: str, request: Request, ctx: AppContextDep) -> dict[str, bool]:
    require_admin_session(request, ctx.auth_store)
    with _entry_errors():
        _service(request).erase(entry_id)
    return {"ok": True}
