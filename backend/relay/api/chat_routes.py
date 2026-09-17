from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from .deps import AppContextDep
from .helpers import JsonBodyDep, require_chat_service_request, string_field

router = APIRouter()


def _resolve_owner(ctx: AppContextDep, body: dict[str, Any]) -> dict[str, Any]:
    """Resolve the chat identity (and thus the owning employee) or raise."""
    try:
        identity = ctx.chat_store.resolve_identity(body)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if not identity:
        raise HTTPException(404, "No active chat identity link is available for this conversation.")
    return identity


def _owned_by(session: dict[str, Any], employee_id: str) -> bool:
    return session.get("ownerEmployeeId") == employee_id


@router.post("/internal/chat/identity/resolve")
def resolve_chat_identity(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_chat_service_request(request)
    body = _request_body
    return {"identity": _resolve_owner(ctx, body)}


@router.get("/internal/chat/integrations/runtime")
def runtime_chat_integrations(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    """Active provider settings for the separately deployed chat webhook service."""
    require_chat_service_request(request)
    return {"integrations": ctx.chat_store.runtime_integrations()}


@router.post("/internal/chat/conversation/session")
def chat_conversation_session(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    """Resolve the live session a chat thread is currently bound to, if any."""
    require_chat_service_request(request)
    body = _request_body
    identity = _resolve_owner(ctx, body)
    record = ctx.chat_store.get_conversation_session(body)
    if not record or not record.get("sessionId"):
        return {"session": None, "mapping": record}
    try:
        session = ctx.session_store.get_session(record["sessionId"])
    except KeyError:
        return {"session": None, "mapping": record}
    # Never surface another employee's session, or a closed (archived) one.
    if not _owned_by(session, identity["employeeId"]) or session.get("archived"):
        return {"session": None, "mapping": record}
    return {"session": session, "mapping": record}


@router.post("/internal/chat/conversation/sessions")
def chat_conversation_sessions(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    """List the owning employee's open conversations for switch/list commands."""
    require_chat_service_request(request)
    body = _request_body
    identity = _resolve_owner(ctx, body)
    sessions = [
        session
        for session in ctx.session_store.list_sessions()
        if not session.get("archived") and session.get("ownerEmployeeId") == identity["employeeId"]
    ]
    return {"sessions": sessions}


@router.post("/internal/chat/conversation/mapping")
def chat_conversation_mapping(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    """Bind a chat thread to a session the resolved employee owns."""
    require_chat_service_request(request)
    body = _request_body
    identity = _resolve_owner(ctx, body)
    session_id = string_field(body, "sessionId")
    if not session_id:
        raise HTTPException(400, "sessionId is required.")
    try:
        session = ctx.session_store.get_session(session_id)
    except KeyError:
        raise HTTPException(404, "Session not found.")
    if not _owned_by(session, identity["employeeId"]):
        raise HTTPException(403, "Session is owned by another employee.")
    record = ctx.chat_store.set_conversation_session(body, session_id, identity["employeeId"])
    return {"mapping": record}
