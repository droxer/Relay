"""GitHub connection is coming soon; public issue imports need no connection."""

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from ...security.request_auth import require_user_session
from ..bodies import JsonBodyDep
from ..deps import AppContextDep

router = APIRouter()


@router.get("/account/github")
def github_status(request: Request, response: Response, ctx: AppContextDep) -> dict[str, Any]:
    require_user_session(request, ctx.auth_store)
    response.headers["Cache-Control"] = "no-store"
    return {"configured": False, "connected": False, "comingSoon": True, "login": None, "manageUrl": None}


@router.post("/account/github/connect")
def connect_github(request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> None:
    require_user_session(request, ctx.auth_store)
    raise HTTPException(501, "github_connection_coming_soon")


@router.get("/account/github/callback")
def github_callback(request: Request, ctx: AppContextDep) -> None:
    require_user_session(request, ctx.auth_store)
    raise HTTPException(501, "github_connection_coming_soon")


@router.delete("/account/github")
def disconnect_github(request: Request, ctx: AppContextDep) -> dict[str, bool]:
    account = require_user_session(request, ctx.auth_store)
    # Previously saved credentials may still be removed while connection is
    # deferred, but cannot be used by imports or renewed through callbacks.
    if ctx.github_connection:
        ctx.github_connection.store.disconnect(account["id"])
    return {"connected": False}
