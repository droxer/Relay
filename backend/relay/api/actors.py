"""Who is calling: session, chat-service, and node-token actors, and record access.
"""

from __future__ import annotations

import secrets
from typing import Any
from fastapi import HTTPException, Request
from ..daemon_registry.registry import DaemonNodeRegistry
from ..daemon_registry.credentials import sandbox_ui_token_matches
from ..persistence.protocols import AuthStore, SessionStore, TaskStore
from ..security.actor import Actor
from ..security.auth import require_user_session
from .bodies import string_field
from .deps import app_context


CHAT_SERVICE_USER_HEADER = "x-relay-user-id"


LEGACY_CHAT_SERVICE_USER_HEADER = "x-relay-employee-id"


def bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    parts = header.split(" ", 1)
    return parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else None


def get_session_or_404(store: SessionStore, session_id: str) -> dict[str, Any]:
    try:
        session = store.get_session(session_id)
        if not session.get("id"):
            raise HTTPException(404, "Session not found.")
        return session
    except KeyError:
        raise HTTPException(404, "Session not found.") from None


def get_task_or_404(store: TaskStore, task_id: str) -> dict[str, Any]:
    try:
        task = store.get_task(task_id)
        if not task.get("id"):
            raise HTTPException(404, "Task not found.")
        return task
    except KeyError:
        raise HTTPException(404, "Task not found.") from None


def request_actor(request: Request, auth_store: AuthStore) -> Actor:
    chat_actor = request_chat_service_actor(request)
    if chat_actor:
        return chat_actor
    account = require_user_session(request, auth_store)
    user_id = account.get("userId") or account.get("username") or account["id"]
    return {
        "account": account,
        "userId": user_id,
        "isAdmin": account.get("role") == "admin",
    }


def request_actor_or_none(request: Request, auth_store: AuthStore) -> Actor | None:
    if chat_service_user_header(request):
        return request_chat_service_actor(request)
    try:
        return request_actor(request, auth_store)
    except HTTPException as error:
        # Only "no valid session" means anonymous; anything else (a 503 for a
        # misconfigured server, say) must not quietly downgrade the caller.
        if error.status_code == 401:
            return None
        raise


def chat_service_user_header(request: Request) -> str:
    value = request.headers.get(CHAT_SERVICE_USER_HEADER) or request.headers.get(
        LEGACY_CHAT_SERVICE_USER_HEADER
    )
    return (value or "").strip()


def request_chat_service_actor(request: Request) -> Actor | None:
    user_id = chat_service_user_header(request)
    if not user_id:
        return None
    require_chat_service_request(request)
    return {
        "account": {
            "id": f"chat:{user_id}",
            "username": user_id,
            "userId": user_id,
            "role": "user",
        },
        "userId": user_id,
        "isAdmin": False,
    }


def require_chat_service_request(request: Request) -> None:
    expected = app_context(request).settings.chat_token
    if not expected:
        raise HTTPException(503, "RELAY_CHAT_TOKEN is not configured.")
    token = bearer_token(request)
    if (
        not token
        or len(token) != len(expected)
        or not secrets.compare_digest(token, expected)
    ):
        raise HTTPException(401, "Invalid chat service token.")


def request_actor_or_sandbox(
    request: Request, auth_store: AuthStore, registry: DaemonNodeRegistry
) -> Actor:
    actor = request_actor_or_none(request, auth_store)
    if actor:
        return actor
    token = bearer_token(request)
    sandbox = authorized_sandbox_for_token(registry, token)
    user_id = sandbox.get("userId") if sandbox else None
    if sandbox and isinstance(user_id, str) and user_id:
        return {
            "account": {
                "id": f"sandbox:{sandbox['id']}",
                "username": user_id,
                "userId": user_id,
                "role": "user",
            },
            "userId": user_id,
            "isAdmin": False,
        }
    if token:
        raise HTTPException(401, "Invalid sandbox token.")
    return request_actor(request, auth_store)


def owner_user_id_for_create(actor: Actor, body: dict[str, Any]) -> str:
    requested = string_field(body, "ownerUserId") or string_field(
        body, "userId"
    )
    if actor["isAdmin"] and requested:
        return requested
    return actor["userId"]


def assignee_user_id_for_task(
    actor: Actor, body: dict[str, Any], fallback: str | None = None
) -> str:
    requested = string_field(body, "assigneeUserId") or string_field(
        body, "assignee_user_id"
    )
    if actor["isAdmin"] and requested:
        return requested
    if requested and requested == actor["userId"]:
        return requested
    return fallback or actor["userId"]


def actor_can_access_record(actor: Actor, record: dict[str, Any]) -> bool:
    if actor["isAdmin"]:
        return True
    return (
        record.get("ownerUserId") == actor["userId"]
        or record.get("assigneeUserId") == actor["userId"]
    )


def actor_can_access_sandbox(actor: Actor, sandbox: dict[str, Any]) -> bool:
    if actor["isAdmin"]:
        return True
    return sandbox.get("userId") == actor["userId"]


def get_session_for_actor(
    store: SessionStore, session_id: str, actor: Actor
) -> dict[str, Any]:
    session = get_session_or_404(store, session_id)
    if not actor_can_access_record(actor, session):
        raise HTTPException(403, "Session access denied.")
    return session


def get_session_header_for_actor(
    store: SessionStore, session_id: str, actor: Actor
) -> dict[str, Any]:
    try:
        session = store.get_session_header(session_id)
    except KeyError:
        raise HTTPException(404, "Session not found.") from None
    if not session.get("id"):
        raise HTTPException(404, "Session not found.")
    if not actor_can_access_record(actor, session):
        raise HTTPException(403, "Session access denied.")
    return session


def get_task_for_actor(
    store: TaskStore, task_id: str, actor: Actor
) -> dict[str, Any]:
    task = get_task_or_404(store, task_id)
    if task.get("deletedAt"):
        raise HTTPException(404, "Task not found.")
    if not actor_can_access_record(actor, task):
        raise HTTPException(403, "Task access denied.")
    return task


def authorized_sandbox_for_token(
    registry: DaemonNodeRegistry, token: str | None
) -> dict[str, Any] | None:
    if not token:
        return None
    return next(
        (
            sandbox
            for sandbox in registry.list_ready()
            if sandbox_ui_token_matches(sandbox, token)
        ),
        None,
    )
