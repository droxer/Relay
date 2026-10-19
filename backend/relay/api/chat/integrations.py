from __future__ import annotations

import asyncio
import secrets
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...security.request_auth import require_admin_session
from ...security.user_handles import user_record
from ..bodies import JsonBodyDep, string_field
from ..deps import AppContextDep

router = APIRouter()


# ── Chat integrations ───────────────────────────────────────────────────

def _actor_name(account: dict[str, Any]) -> str:
    return str(account.get("username") or account.get("id") or "admin")


def _chat_error(error: Exception) -> HTTPException:
    if isinstance(error, KeyError):
        return HTTPException(404, "Chat integration record not found.")
    if isinstance(error, ValueError):
        return HTTPException(400, str(error))
    return HTTPException(500, "Chat integration operation failed.")


@router.get("/admin/chat-integrations")
def list_chat_integrations(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return {"integrations": ctx.chat_store.list_integrations()}


@router.post("/admin/chat-integrations", status_code=201)
def create_chat_integration(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.create_integration(body, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.get("/admin/chat-integrations/{integration_id}")
def get_chat_integration(
    integration_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        integration = ctx.chat_store.get_integration(integration_id)
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.patch("/admin/chat-integrations/{integration_id}")
def update_chat_integration(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.update_integration(integration_id, body, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.post("/admin/chat-integrations/{integration_id}/activations")
async def activate_chat_integration(integration_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    try:
        ctx.chat_store.validate_activation(integration_id)
        settings = ctx.chat_store.connection_settings(integration_id)
        if settings.get("provider") == "telegram":
            provisioned, message = await ctx.chat_provision(settings, integration_id)
            if not provisioned:
                raise ValueError(message)
        else:
            message = "Integration activated."
        integration = ctx.chat_store.activate_integration(integration_id, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration, "provisioning": {"ok": True, "message": message}}


@router.post("/admin/chat-integrations/{integration_id}/health-checks")
async def check_chat_integration(integration_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    try:
        settings = ctx.chat_store.connection_settings(integration_id)
        provider_health = await ctx.chat_probe(settings)
        integration = ctx.chat_store.check_integration(
            integration_id,
            actor=_actor_name(account),
            provider_health=provider_health,
        )
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.post("/admin/chat-integrations/{integration_id}/webhook-secret-rotations")
async def rotate_telegram_webhook_secret(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    locks = ctx.chat_rotation_locks
    lock = locks.setdefault(integration_id, asyncio.Lock())
    async with lock:
        return await _rotate_telegram_webhook_secret(integration_id, request, ctx, account)


async def _rotate_telegram_webhook_secret(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    account: dict[str, Any],
) -> dict[str, Any]:
    try:
        ctx.chat_store.validate_telegram_webhook_rotation(integration_id)
        previous_settings = ctx.chat_store.connection_settings(integration_id)
        previous_secret = previous_settings.get("secrets", {}).get("webhookSecret")
        webhook_secret = secrets.token_urlsafe(32)
        integration = ctx.chat_store.set_telegram_webhook_secret(
            integration_id,
            webhook_secret,
            actor=_actor_name(account),
        )
        settings = ctx.chat_store.connection_settings(integration_id)
        provisioned, message = await ctx.chat_provision(settings, integration_id)
        if not provisioned:
            if isinstance(previous_secret, str) and previous_secret:
                restored, restore_message = await ctx.chat_provision(previous_settings, integration_id)
                if restored:
                    ctx.chat_store.set_telegram_webhook_secret(integration_id, previous_secret, actor=_actor_name(account))
                else:
                    raise ValueError(
                        f"{message} The previous webhook could not be restored ({restore_message}); "
                        "Relay retained the new secret to avoid rejecting a webhook that Telegram may have accepted."
                    )
            raise ValueError(message)
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration, "provisioning": {"ok": True, "message": message}}


@router.post("/admin/chat-integrations/{integration_id}/identity-links", status_code=201)
def add_chat_identity_link(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    user_id = string_field(body, "userId")
    default_agent_id = string_field(body, "defaultAgentId")
    if not user_record(ctx.auth_store, user_id):
        raise HTTPException(404, "User not found.")
    if default_agent_id:
        agent = ctx.agent_store.get_agent(default_agent_id)
        if (
            not agent
            or agent.get("deletedAt")
            or not agent.get("enabled", True)
            or agent.get("supervisorUserId") != user_id
        ):
            raise HTTPException(
                400, "defaultAgentId must reference an enabled agent owned by the linked user."
            )
    try:
        integration = ctx.chat_store.add_identity_link(integration_id, body, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.delete("/admin/chat-integrations/{integration_id}/identity-links/{link_id}")
def delete_chat_identity_link(
    integration_id: str, link_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    try:
        integration = ctx.chat_store.delete_identity_link(integration_id, link_id, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.post("/admin/chat-integrations/{integration_id}/allowed-conversations", status_code=201)
def add_chat_allowed_conversation(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.add_allowed_conversation(integration_id, body, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.delete("/admin/chat-integrations/{integration_id}/allowed-conversations/{conversation_record_id}")
def delete_chat_allowed_conversation(
    integration_id: str,
    conversation_record_id: str,
    request: Request,
    ctx: AppContextDep,
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    try:
        integration = ctx.chat_store.delete_allowed_conversation(integration_id, conversation_record_id, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.get("/admin/chat-integrations/{integration_id}/audit")
def list_chat_integration_audit(
    integration_id: str, request: Request, ctx: AppContextDep, limit: int = 50
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        ctx.chat_store.get_integration(integration_id)
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"events": ctx.chat_store.audit_events(integration_id, limit=limit)}
