"""The default agents a connecting Computer offers its user.

A person answers each offer once: accepting creates the agents, declining is
kept with the Account's onboarding choices so the question is not asked again.
See `computer/default_agents.py`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...agents.creation import AgentCreationError
from ...computer.default_agents import accept_default_agents, default_agent_offers
from ...core.models import AGENT_NAMES
from ...persistence.resource_lock import resource_transaction
from ...security.onboarding import declined_default_agents
from ...security.request_auth import require_user_session
from ..bodies import JsonBodyDep
from ..deps import AppContextDep

router = APIRouter()


@router.get("/agents/default-offers")
def list_default_agent_offers(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    account = require_user_session(request, ctx.auth_store)
    user_id = _user_id(account)
    declined = declined_default_agents(account.get("onboarding"))
    return {"offers": default_agent_offers(ctx, user_id, declined)}


@router.post("/agents/default-offers/accept", status_code=201)
def accept_default_agent_offer(request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    account = require_user_session(request, ctx.auth_store)
    target_computer_id, executor_kinds = _offer_answer(_request_body)
    try:
        with resource_transaction(ctx.auth_store.engine, f"default-agent-answers:{account['id']}"):
            # The session cache may still reflect another replica's old choices.
            current = ctx.auth_store.get_account_by_id(account["id"])
            if current is None:
                raise HTTPException(401, "User not found.")
            agents = accept_default_agents(
                ctx,
                _user_id(current),
                target_computer_id,
                executor_kinds,
                declined_default_agents(current.get("onboarding")),
            )
    except AgentCreationError as error:
        raise HTTPException(error.status, str(error)) from error
    except ValueError as error:
        raise HTTPException(409 if "already has" in str(error) else 400, str(error)) from error
    return {"agents": agents}


@router.post("/agents/default-offers/decline")
def decline_default_agent_offer(request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    account = require_user_session(request, ctx.auth_store)
    target_computer_id, executor_kinds = _offer_answer(_request_body)
    try:
        with resource_transaction(ctx.auth_store.engine, f"default-agent-answers:{account['id']}"):
            ctx.auth_store.update_user_preferences(
                account["id"],
                onboarding={
                    "declineDefaultAgents": [
                        {"computerId": target_computer_id, "executorKind": kind} for kind in executor_kinds
                    ]
                },
            )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"ok": True}


def _user_id(account: dict[str, Any]) -> str:
    return str(account.get("userId") or account.get("username") or account["id"])


def _offer_answer(body: dict[str, Any]) -> tuple[str, list[str]]:
    target_computer_id = body.get("computerId")
    if not isinstance(target_computer_id, str) or not target_computer_id.strip():
        raise HTTPException(400, "computerId is required.")
    kinds = body.get("executorKinds")
    if (
        not isinstance(kinds, list)
        or not kinds
        or len(kinds) > len(AGENT_NAMES)
        or not all(isinstance(kind, str) and kind for kind in kinds)
    ):
        raise HTTPException(400, "executorKinds must be a non-empty list of runtimes.")
    return target_computer_id.strip(), list(dict.fromkeys(kinds))
