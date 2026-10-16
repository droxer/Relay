"""The signed-in person's notification inbox and which kinds they mute.

Every route answers only for the caller's own notices; an id that belongs to
someone else is ignored, never reported, so ids cannot be probed.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from ..notifications.rules import NOTIFICATION_KINDS
from ..notifications.watcher import recipient_id
from ..persistence.notification_store import MAX_LIST_LIMIT, DatabaseNotificationStore
from ..security.auth import require_user_session
from .deps import AppContextDep
from .helpers import JsonBodyDep

router = APIRouter()

# A mark-read batch larger than the inbox can show is not a real request.
MAX_MARK_READ_IDS = MAX_LIST_LIMIT


def _store(request: Request) -> DatabaseNotificationStore:
    return request.app.state.notification_store


def _caller(request: Request, ctx: AppContextDep) -> str:
    return recipient_id(require_user_session(request, ctx.auth_store))


@router.get("/notifications")
def list_notifications(
    request: Request, ctx: AppContextDep, limit: int = Query(50, ge=1, le=MAX_LIST_LIMIT),
) -> dict[str, Any]:
    return _store(request).list_for_user(_caller(request, ctx), limit=limit)


@router.post("/notifications/read")
def mark_notifications_read(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep,
) -> dict[str, Any]:
    """Body ``{"ids": [...]}`` marks those read; ``{"all": true}`` marks all."""
    user_id = _caller(request, ctx)
    body = _request_body
    if body.get("all") is True:
        ids = None
    else:
        ids = body.get("ids")
        if not isinstance(ids, list) or not all(isinstance(item, str) and item for item in ids):
            raise HTTPException(400, "ids must be a list of notification ids, or pass all: true.")
        if len(ids) > MAX_MARK_READ_IDS:
            raise HTTPException(400, f"ids may name at most {MAX_MARK_READ_IDS} notifications.")
    store = _store(request)
    store.mark_read(user_id, ids)
    return {"unreadCount": store.list_for_user(user_id, limit=1)["unreadCount"]}


@router.get("/notifications/preferences")
def get_notification_preferences(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return {"mutedKinds": _store(request).muted_kinds(_caller(request, ctx)), "kinds": list(NOTIFICATION_KINDS)}


@router.put("/notifications/preferences")
def put_notification_preferences(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep,
) -> dict[str, Any]:
    user_id = _caller(request, ctx)
    muted = _request_body.get("mutedKinds")
    if not isinstance(muted, list) or not all(isinstance(kind, str) for kind in muted):
        raise HTTPException(400, "mutedKinds must be a list of notification kinds.")
    unknown = sorted(set(muted) - set(NOTIFICATION_KINDS))
    if unknown:
        raise HTTPException(400, f"Unknown notification kind(s): {', '.join(unknown)}.")
    kinds = [kind for kind in NOTIFICATION_KINDS if kind in muted]
    return {"mutedKinds": _store(request).set_muted_kinds(user_id, kinds), "kinds": list(NOTIFICATION_KINDS)}
