"""Connect a signed-in account to a GitHub App, without exposing tokens."""

from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from ...accounts.github_client import GitHubConnectionError
from ...accounts.github_connection import GitHubConnectionService
from ...security.request_auth import require_user_session, user_session_token_from_request
from ..bodies import JsonBodyDep, string_field
from ..deps import AppContext, AppContextDep

router = APIRouter()


def _service(ctx: AppContext) -> GitHubConnectionService:
    if ctx.github_connection is None:
        raise HTTPException(503, "github_connection_not_configured")
    return ctx.github_connection


@contextmanager
def github_connection_errors():
    try:
        yield
    except GitHubConnectionError as error:
        raise HTTPException(error.status, error.code) from error


@router.get("/account/github")
def github_status(request: Request, response: Response, ctx: AppContextDep) -> dict[str, Any]:
    account = require_user_session(request, ctx.auth_store)
    response.headers["Cache-Control"] = "no-store"
    return _service(ctx).status(account["id"])


@router.post("/account/github/connect")
def connect_github(request: Request, response: Response, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, str]:
    account = require_user_session(request, ctx.auth_store)
    response.headers["Cache-Control"] = "no-store"
    with github_connection_errors():
        retry_after = ctx.auth_rate_limiter.consume(f"github-connect:{account['id']}")
        if retry_after is not None:
            raise HTTPException(429, "github_connection_rate_limited", headers={"Retry-After": str(retry_after)})
        url = _service(ctx).start(account["id"], user_session_token_from_request(request) or "",
            string_field(_request_body, "returnTo") or "/settings/account")
    return {"authorizeUrl": url}


@router.get("/account/github/callback")
def github_callback(request: Request, ctx: AppContextDep) -> RedirectResponse:
    account = require_user_session(request, ctx.auth_store)
    params = request.query_params
    state, code = params.get("state", ""), params.get("code")
    if not state or len(state) > 128 or (code and len(code) > 4096):
        raise HTTPException(400, "github_connection_state_invalid")
    installation_id = None
    if raw_id := params.get("installation_id"):
        if not raw_id.isascii() or not raw_id.isdigit() or len(raw_id) > 20:
            raise HTTPException(400, "github_connection_state_invalid")
        installation_id = int(raw_id)
    with github_connection_errors():
        destination = _service(ctx).complete(account["id"], user_session_token_from_request(request) or "", state,
            code=code, installation_id=installation_id, denied=bool(params.get("error")))
    return RedirectResponse(destination, status_code=303, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.delete("/account/github")
def disconnect_github(request: Request, ctx: AppContextDep) -> dict[str, bool]:
    account = require_user_session(request, ctx.auth_store)
    _service(ctx).store.disconnect(account["id"])
    return {"connected": False}
