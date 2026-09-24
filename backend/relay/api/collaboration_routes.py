from __future__ import annotations

import unicodedata
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..collaboration.models import MessageIntent, RecoveryIntent
from ..collaboration.service import CollaborationConductor, CollaborationError
from ..collaboration.styles import CollaborationStyleError, validate_collaboration_style
from .deps import AppContextDep
from .helpers import get_session_for_actor, json_body, request_actor, string_field

router = APIRouter()

PURPOSES = frozenset({"accomplish", "discuss", "review"})
RECOVERY_KINDS = frozenset({"rerun", "handoff"})
MODES = frozenset({"action", "ask", "review"})


def _address_agent_ids(body: dict[str, Any]) -> tuple[str, ...]:
    """Read the addressed agents, accepting the singular legacy field.

    `addressAgentId` is what the chat gateway still sends; it means the same
    thing as a one-element `addressAgentIds`.
    """
    raw = body.get("addressAgentIds")
    if isinstance(raw, list):
        ids = [item for item in raw if isinstance(item, str) and item]
        if len(ids) != len(raw):
            raise HTTPException(400, "addressAgentIds must be a list of agent ids.")
        return tuple(dict.fromkeys(ids))
    if raw is not None:
        raise HTTPException(400, "addressAgentIds must be a list of agent ids.")
    single = string_field(body, "addressAgentId") or None
    return (single,) if single else ()


def _leading_mention_agent_ids(
    text: str, agents: list[dict[str, Any]]
) -> tuple[str, ...]:
    """Resolve the leading ``@Display Name`` run without failing open.

    Browser addressing metadata is authoritative when there is no textual
    mention. A leading mention is also durable user intent, though, and older or
    partially loaded clients may omit the metadata. Resolve that intent here so
    ``@Kimi`` can never silently become a room message.

    The grammar mirrors ``parseMentions`` in ``web/src/lib/mentions.ts`` line
    for line: only horizontal whitespace may precede the run, and a bare ``@``
    that no word follows is prose, not a failed mention. Anything the composer
    sends must resolve here, or the user gets a 400 for a message their own
    client told them was fine.
    """
    candidates = [
        agent
        for agent in agents
        if not agent.get("deletedAt")
        and agent.get("enabled", True)
        and isinstance(agent.get("displayName"), str)
        and agent["displayName"]
    ]
    cursor = _leading_space(text)
    addressed: list[str] = []
    while text.startswith("@", cursor):
        rest = text[cursor + 1 :]
        matches = [
            agent
            for agent in candidates
            if _names_the_agent(rest, agent["displayName"])
        ]
        if not matches:
            if not rest[:1].strip():
                # "@ still here" is a message that opens with an at sign, the
                # same reading the composer takes. Stop scanning, address
                # nobody, and let the round go to the room.
                break
            raise HTTPException(
                400,
                {
                    "code": "message_address_required",
                    "message": "A leading mention must name an available agent.",
                },
            )
        longest = max(len(agent["displayName"]) for agent in matches)
        best = [agent for agent in matches if len(agent["displayName"]) == longest]
        if len(best) != 1:
            raise HTTPException(
                400,
                {
                    "code": "message_address_ambiguous",
                    "message": "A leading mention must identify exactly one agent.",
                },
            )
        selected = best[0]
        addressed.append(selected["id"])
        cursor += 1 + len(selected["displayName"])
        cursor += _leading_space(text[cursor:])
    return tuple(dict.fromkeys(addressed))


def _names_the_agent(rest: str, display_name: str) -> bool:
    # `str.lower`, not `str.casefold`: the composer compares with JavaScript's
    # `toLowerCase`, and casefold would resolve names the browser would not.
    lowered = rest.lower()
    name = display_name.lower()
    return lowered == name or lowered.startswith((f"{name} ", f"{name}\n"))


def _leading_space(text: str) -> int:
    """Match JavaScript's ``/^[^\\S\\n]*/`` cursor movement exactly."""
    cursor = 0
    while cursor < len(text) and _is_javascript_non_newline_space(text[cursor]):
        cursor += 1
    return cursor


def _is_javascript_non_newline_space(character: str) -> bool:
    if character == "\n":
        return False
    return (
        character in "\t\v\f\r \u00a0\ufeff\u2028\u2029"
        or unicodedata.category(character) == "Zs"
    )


@router.post("/threads/{thread_id}/messages", status_code=202)
async def submit_thread_message(
    thread_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await json_body(request)
    text = string_field(body, "text")
    if not text:
        raise HTTPException(400, "text is required.")
    purpose = string_field(body, "intent") or "accomplish"
    if purpose not in PURPOSES:
        raise HTTPException(400, "intent must be accomplish, discuss, or review.")
    supplied_address_agent_ids = _address_agent_ids(body)
    session = get_session_for_actor(ctx.session_store, thread_id, actor)
    mention_owner_id = (
        session.get("ownerEmployeeId") if actor["isAdmin"] else actor["employeeId"]
    )
    mentioned_agent_ids = _leading_mention_agent_ids(
        text,
        ctx.agent_store.list_agents(supervisor_employee_id=mention_owner_id),
    )
    address_agent_ids = mentioned_agent_ids or supplied_address_agent_ids
    address_team_id = string_field(body, "addressTeamId") or None
    if address_team_id and address_agent_ids:
        raise HTTPException(
            400,
            {
                "code": "message_address_conflict",
                "message": "A message addresses either a team or agents, not both.",
            },
        )
    style = body.get("style")
    if style is not None:
        try:
            style = validate_collaboration_style(style, "style")
        except CollaborationStyleError as error:
            raise HTTPException(400, {"code": "style_invalid", "message": str(error)}) from error
    try:
        return await CollaborationConductor(ctx).submit(
            MessageIntent(
                thread_id=thread_id,
                text=text,
                purpose=purpose,  # type: ignore[arg-type]
                address_agent_ids=address_agent_ids,
                address_team_id=address_team_id,
                idempotency_key=string_field(body, "idempotencyKey") or None,
                user_message_id=string_field(body, "userMessageId") or None,
                style=style,
            ),
            actor,
        )
    except CollaborationError as error:
        raise HTTPException(
            error.status, {"code": error.code, "message": str(error)}
        ) from error


@router.post("/threads/{thread_id}/recoveries", status_code=202)
async def request_thread_recovery(
    thread_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await json_body(request)
    kind = string_field(body, "kind")
    if kind not in RECOVERY_KINDS:
        raise HTTPException(400, "kind must be rerun or handoff.")
    target_agent_id = string_field(body, "targetAgentId")
    if not target_agent_id:
        raise HTTPException(400, "targetAgentId is required.")
    mode = string_field(body, "mode") or "action"
    if mode not in MODES:
        raise HTTPException(400, "mode must be action, ask, or review.")
    try:
        return await CollaborationConductor(ctx).submit(
            RecoveryIntent(
                thread_id=thread_id,
                kind=kind,  # type: ignore[arg-type]
                target_agent_id=target_agent_id,
                mode=mode,
                note=string_field(body, "note") or None,
                idempotency_key=string_field(body, "idempotencyKey") or None,
            ),
            actor,
        )
    except CollaborationError as error:
        raise HTTPException(
            error.status, {"code": error.code, "message": str(error)}
        ) from error
