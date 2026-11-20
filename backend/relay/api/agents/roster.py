"""Agent directory, setup, search and owner-scoped configuration reads."""

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from ...agents.binding import binding_status
from ...computer.default_agents import default_agent_offers
from ...core.models import AGENT_NAMES
from ...security.onboarding import declined_default_agents
from ..actors import chat_service_user_header, request_actor
from ..conditional_get import private_conditional_json
from ..deps import AppContextDep
from .agents import _agent_views, _agent_with_placements, _node_map

router = APIRouter()


def _search_computers(placements: list[dict[str, Any]]) -> list[str]:
    """Match the directory's display order and one name per Computer."""
    names: dict[str, str] = {}
    for placement in sorted(placements, key=lambda item: (item.get("priority", 100), item["id"])):
        if placement.get("desiredState") == "removed":
            continue
        node_id = placement.get("runtimeNodeId") or placement["daemonNodeId"]
        names.setdefault(placement.get("computerId") or node_id, placement.get("nodeDisplayName") or node_id)
    return list(names.values())


def _search_match(agent: dict[str, Any], blurbs: dict[str, str], query: str) -> bool:
    executor = agent["executorKind"]
    search_text = " ".join([
        agent["displayName"], agent["id"], executor, blurbs.get(executor, ""),
        agent.get("instructions") or "", *_search_computers(agent["placements"]),
    ])
    return query in search_text.lower()


def _onboarding_candidates(views: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first ready or busy Agent per runtime and node in roster order."""
    covered: set[tuple[str, str]] = set()
    candidates = []
    for agent in views:
        if agent["availability"] not in ("ready", "busy"):
            continue
        placements = []
        for placement in agent["placements"]:
            target = (placement.get("runtimeNodeId") or placement["daemonNodeId"], agent["executorKind"])
            if placement["desiredState"] != "active" or target in covered:
                continue
            covered.add(target)
            placements.append({
                key: placement[key] for key in ("daemonNodeId", "runtimeNodeId", "desiredState") if key in placement
            })
        if placements:
            candidates.append({
                **{key: agent[key] for key in ("id", "executorKind", "availability", "enabled")},
                "placements": placements,
            })
    return candidates


@router.get("/agents", response_model=None)
def list_agents(request: Request, ctx: AppContextDep) -> dict[str, Any] | Response:
    actor = request_actor(request, ctx.auth_store)
    owner = actor["userId"]
    view = request.query_params.get("view")
    search = view == "matches"
    setup = view == "setup"
    summary = view == "summary" or search or setup
    query = request.query_params.get("q", "").strip().lower()
    if search and not query:
        return {"agentIds": []}
    include_offers = not search and request.query_params.get("include") == "default-offers" and not chat_service_user_header(request)
    if summary:
        records = ctx.agent_store.list_agent_summaries(owner, include_deleted=include_offers, include_instructions=search)
    else:
        records = ctx.agent_store.list_agents(supervisor_user_id=owner, include_deleted=include_offers)
    agents = [agent for agent in records if agent.get("enabled", True) and not agent.get("deletedAt")]
    nodes = _node_map(ctx, owner=owner if summary else None) if agents or include_offers else {}
    views = _agent_views(ctx, agents, nodes=nodes, owner=owner, summary=summary)
    if search:
        blurbs = {kind: request.query_params.get(f"blurb.{kind}", "")[:512] for kind in AGENT_NAMES}
        return {"agentIds": [agent["id"] for agent in views if _search_match(agent, blurbs, query)]}

    fleet = list(nodes.values())
    result: dict[str, Any]
    if setup:
        result = {"view": "setup", "onboardingAgents": _onboarding_candidates(views)}
    else:
        result = {"agents": [
            {**agent_view, "bindingStatus": binding_status(agent, fleet)} for agent, agent_view in zip(agents, views, strict=True)
        ]}
        if summary:
            result["view"] = "summary"
            result["searchesInstructions"] = any(agent["hasInstructions"] for agent in agents)
            for entry in result["agents"]:
                entry.pop("hasInstructions", None)
    if include_offers:
        result["defaultAgentOffers"] = default_agent_offers(
            ctx, owner, declined_default_agents(actor.get("account", {}).get("onboarding")), fleet=fleet, history=records,
        )
    return private_conditional_json(request, result) if setup else result


@router.get("/agents/{agent_id}")
def get_own_agent(agent_id: str, request: Request, ctx: AppContextDep) -> Response:
    actor = request_actor(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt") or agent.get("supervisorUserId") != actor["userId"]:
        raise HTTPException(404, "Agent not found.")
    nodes = _node_map(ctx, owner=actor["userId"])
    if request.query_params.get("view") == "badge":
        view = _agent_with_placements(ctx, agent, nodes=nodes, summary=True)
        return private_conditional_json(request, {"agent": {
            **{key: view[key] for key in ("id", "displayName", "executorKind", "enabled", "availability")},
            "profileImageUrl": view.get("profileImageUrl"),
        }})
    return private_conditional_json(request, {"agent": {
        **_agent_with_placements(ctx, agent, nodes=nodes),
        "bindingStatus": binding_status(agent, list(nodes.values())),
    }})
