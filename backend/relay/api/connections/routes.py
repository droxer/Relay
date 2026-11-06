"""Signed-in service authorization and per-work access configuration."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from ...connections.service import ConnectionService
from ...core.connections import ConnectionError
from ...security.request_auth import require_user_session, user_session_token_from_request
from ..actors import get_session_for_actor, get_task_for_actor, request_actor
from ..bodies import JsonBodyDep
from ..deps import AppContext, AppContextDep

router = APIRouter()


@contextmanager
def connection_errors() -> Iterator[None]:
    try:
        yield
    except ConnectionError as error:
        raise HTTPException(error.status, error.code) from error


def service(ctx: AppContext) -> ConnectionService:
    if ctx.connections is None:
        raise HTTPException(503, "connections_not_configured")
    return ctx.connections


def owner(request: Request, ctx: AppContext, response: Response | None = None) -> str:
    account = require_user_session(request, ctx.auth_store)
    if response is not None:
        response.headers["Cache-Control"] = "private, no-store"
    return account.get("userId") or account["id"]


@router.get("/connection-providers")
def catalog(request: Request, response: Response, ctx: AppContextDep) -> dict[str, Any]:
    owner(request, ctx, response)
    return {"providers": service(ctx).catalog()}


@router.get("/connections")
def list_connections(request: Request, response: Response, ctx: AppContextDep) -> dict[str, Any]:
    return {"connections": service(ctx).list(owner(request, ctx, response))}


@router.post("/connections/authorizations")
def start(request: Request, ctx: AppContextDep, *, body: JsonBodyDep) -> dict[str, str]:
    user = owner(request, ctx)
    retry_after = ctx.auth_rate_limiter.consume(f"connection-auth:{user}")
    if retry_after is not None:
        raise HTTPException(429, "connection_rate_limited", headers={"Retry-After": str(retry_after)})
    provider, return_to, reconnect = body.get("provider"), body.get("returnTo", "/settings/connections"), body.get("reconnectId")
    if not isinstance(provider, str) or not isinstance(return_to, str) or (reconnect is not None and not isinstance(reconnect, str)):
        raise HTTPException(400, "connection_authorization_invalid")
    with connection_errors():
        url = service(ctx).start(user, user_session_token_from_request(request) or "", provider, return_to, reconnect)
    return {"url": url}


@router.get("/connections/callback/{provider}")
def callback(provider: str, request: Request, ctx: AppContextDep) -> RedirectResponse:
    user = owner(request, ctx)
    with connection_errors():
        _record, return_to = service(ctx).complete(user, user_session_token_from_request(request) or "", provider,
            request.query_params.get("state", ""), code=request.query_params.get("code"),
            denied=bool(request.query_params.get("error")))
    return RedirectResponse(return_to, status_code=303, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.get("/connections/{connection_id}/resources")
def resources(connection_id: str, request: Request, response: Response, ctx: AppContextDep) -> dict[str, Any]:
    user = owner(request, ctx, response)
    with connection_errors():
        return service(ctx).resources(user, connection_id, request.query_params.get("cursor", ""))


@router.get("/connections/{connection_id}/usage")
def usage(connection_id: str, request: Request, response: Response, ctx: AppContextDep) -> dict[str, Any]:
    user = owner(request, ctx, response)
    with connection_errors():
        service(ctx)._connection(user, connection_id)
        return {"usage": service(ctx).store.usage(user, connection_id)}


@router.delete("/connections/{connection_id}")
def disconnect(connection_id: str, request: Request, ctx: AppContextDep) -> dict[str, bool]:
    user = owner(request, ctx)
    with connection_errors():
        service(ctx).disconnect(user, connection_id)
        for item in service(ctx).store.usage(user, connection_id):
            if item["targetType"] == "automation":
                try:
                    task = ctx.task_store.get_task(item["targetId"])
                except KeyError:
                    continue
                if task.get("routineState") == "active":
                    ctx.task_store.update_task(task["id"], {"routineState": "paused_by_relay",
                        "routinePauseReason": "connection_unavailable", "routineNextRunAt": None})
    return {"disconnected": True}


def target(request: Request, ctx: AppContext, kind: str, target_id: str) -> tuple[str, str, bool]:
    actor = request_actor(request, ctx.auth_store)
    if kind == "thread":
        thread = get_session_for_actor(ctx.session_store, target_id, actor)
        if thread.get("taskId"):
            return target(request, ctx, "task", thread["taskId"])
        return kind, target_id, False
    if kind not in {"task", "automation"}:
        raise HTTPException(400, "connection_target_invalid")
    task = get_task_for_actor(ctx.task_store, target_id, actor)
    if bool(task.get("isRoutine")) != (kind == "automation"):
        raise HTTPException(400, "connection_target_invalid")
    return kind, target_id, bool(task.get("sourceRoutineId"))


@router.get("/connection-grants/{kind}/{target_id}")
def get_grants(kind: str, target_id: str, request: Request, response: Response, ctx: AppContextDep) -> dict[str, Any]:
    user = owner(request, ctx, response)
    actual_kind, actual_id, readonly = target(request, ctx, kind, target_id)
    return {"grants": service(ctx).grants(user, actual_kind, actual_id),
        "targetType": actual_kind, "targetId": actual_id, "readOnly": readonly}


@router.put("/connection-grants/{kind}/{target_id}")
def save_grants(kind: str, target_id: str, request: Request, ctx: AppContextDep, *, body: JsonBodyDep) -> dict[str, Any]:
    user = owner(request, ctx)
    actual_kind, actual_id, readonly = target(request, ctx, kind, target_id)
    if readonly:
        raise HTTPException(409, "connection_generated_task_read_only")
    with connection_errors():
        saved = service(ctx).set_grants(user, actual_kind, actual_id, body.get("grants"))
    return {"grants": saved, "targetType": actual_kind, "targetId": actual_id}
