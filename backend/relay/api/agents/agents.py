from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger

from ...collaboration.models import RunIntent
from ...collaboration.errors import CollaborationError
from ...collaboration.service import CollaborationConductor
from ...collaboration.styles import CollaborationStyleError, validate_collaboration_style
from ...core.computer_identity import computer_id
from ...core.daemon_capabilities import (
    DAEMON_CAPABILITY_AGENT_MODEL,
    DAEMON_CAPABILITY_ENDPOINT_MODELS,
    has_capability,
)
from ...persistence.agent.placements import placement_status
from ...security.request_auth import require_admin_session
from ...agents.binding import binding_status
from ...agents.location import AgentMoveError, place_agent_on_node
from ...agents.creation import AgentCreationError, create_agent_for_user
from ...agents.routing import placement_node
from ...computer.names import computer_display_name
from ...projects.catalog import agent_has_active_project
from ...teams.membership import remove_agent_from_teams
from ..deps import AppContextDep
from ..actors import request_actor
from ..bodies import JsonBodyDep, json_body, string_field
from ...skills.bundle import resolve_bundle
from ...skills.grants import read_grants

router = APIRouter()


# Users can adjust their agent's personality, model, and role at any time; the
# birth certificate (computerId / executorKind) is fixed at creation — a
# different computer or runtime is a different coworker, so it should be a new
# agent, not an edit. The role is the agent's own default; a team may assign
# its member a different one.
AGENT_META_FIELDS = frozenset({"displayName", "instructions", "modelPolicy", "defaultRole"})


@router.get("/agents")
def list_agents(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    agents = [
        agent
        for agent in ctx.agent_store.list_agents(supervisor_user_id=actor["userId"])
        if agent.get("enabled", True)
    ]
    nodes = _node_map(ctx)
    fleet = list(nodes.values())
    # An agent a user explicitly created always stays on the roster.
    # If its computer or runtime is gone, flag it — let the user decide
    # whether to delete it. The system doesn't make that call for them.
    return {
        "agents": [
            {**view, "bindingStatus": binding_status(agent, fleet)}
            for agent, view in zip(agents, _agent_views(ctx, agents, nodes=nodes), strict=True)
        ]
    }


@router.post("/agents", status_code=201)
def create_agent(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = _request_body
    try:
        agent = create_agent_for_user(ctx, actor["userId"], body)
    except AgentCreationError as error:
        raise HTTPException(error.status, str(error)) from error
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error
    return {"agent": _agent_with_placements(ctx, agent)}


@router.patch("/agents/{agent_id}")
def update_agent(
    agent_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
    if agent.get("supervisorUserId") != actor["userId"]:
        raise HTTPException(403, "Cannot update another user's agent.")
    body = _request_body
    unknown = set(body) - AGENT_META_FIELDS
    if unknown:
        raise HTTPException(
            400,
            f"Unsupported agent field(s): {', '.join(sorted(unknown))}.",
        )
    try:
        updated = _update_agent_and_realize_placements(ctx, agent_id, body)
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error
    return {"agent": _agent_with_placements(ctx, updated)}


@router.delete("/agents/{agent_id}", status_code=200)
def delete_agent(agent_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
    if agent.get("supervisorUserId") != actor["userId"]:
        raise HTTPException(403, "Cannot delete another user's agent.")
    return _delete_agent(ctx, agent)


@router.get("/admin/agents")
def list_control_panel_agents(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    user_id = (
        request.query_params.get("userId")
        or request.query_params.get("supervisorUserId")
        or None
    )
    return {
        "agents": _agent_views(
            ctx,
            ctx.agent_store.list_agents(
                supervisor_user_id=user_id, include_deleted=True
            ),
        )
    }


@router.post("/admin/agents", status_code=201)
def create_control_panel_agent(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    user_id = string_field(body, "supervisorUserId")
    if not _user_exists(ctx.auth_store, user_id):
        raise HTTPException(404, "User not found.")
    try:
        agent = create_agent_for_user(ctx, user_id, body)
    except AgentCreationError as error:
        raise HTTPException(error.status, str(error)) from error
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error
    return {"agent": agent}


@router.get("/admin/agents/{agent_id}")
def get_control_panel_agent(
    agent_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, "Agent not found.")
    nodes = _node_map(ctx)
    return {
        "agent": {
            **_agent_with_placements(ctx, agent, nodes=nodes),
            "bindingStatus": binding_status(agent, list(nodes.values())),
        }
    }


@router.patch("/admin/agents/{agent_id}")
def update_control_panel_agent(
    agent_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        return {
            "agent": _update_agent_and_realize_placements(ctx, agent_id, _request_body)
        }
    except KeyError as error:
        raise HTTPException(404, "Agent not found.") from error
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error


@router.delete("/admin/agents/{agent_id}", status_code=200)
def delete_control_panel_agent(
    agent_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
    return _delete_agent(ctx, agent)


def _delete_agent(ctx: AppContextDep, agent: dict[str, Any]) -> dict[str, Any]:
    agent_id = agent["id"]
    if _agent_has_active_run(ctx, agent_id):
        raise HTTPException(
            409,
            "Agent has active work. Wait for its runs to finish before deleting it.",
        )
    if agent_has_active_project(ctx.project_store, agent_id):
        raise HTTPException(
            409,
            "Agent belongs to an active project. Remove it from the project "
            "before deleting it.",
        )
    try:
        deleted = ctx.agent_store.delete_agent(agent_id)
        ctx.profile_image_store.delete("agents", agent_id)
        remove_agent_from_teams(ctx.team_store, agent_id, agent["supervisorUserId"])
        return {"agent": deleted}
    except KeyError as error:
        raise HTTPException(404, "Agent not found.") from error


@router.get("/admin/agent-placements")
def list_agent_placements(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    agent_id = request.query_params.get("agentId") or None
    daemon_node_id = request.query_params.get("nodeId") or None
    placements = ctx.agent_placement_store.list_placements(
        agent_id=agent_id,
        daemon_node_id=daemon_node_id,
        include_removed=True,
    )
    nodes = _node_map(ctx)
    agents: dict[str, dict[str, Any] | None] = {}
    for placement in placements:
        agents.setdefault(
            placement["agentId"], ctx.agent_store.get_agent(placement["agentId"])
        )
    return {
        "placements": [
            _placement_view(
                ctx, placement, nodes=nodes, agent=agents[placement["agentId"]]
            )
            for placement in placements
        ]
    }


@router.post("/admin/agents/{agent_id}/placements", status_code=201)
def create_agent_placement(
    agent_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
    body = _request_body
    daemon_node_id = body.get("daemonNodeId")
    if not isinstance(daemon_node_id, str) or not daemon_node_id.strip():
        raise HTTPException(400, "daemonNodeId is required.")
    node = ctx.registry.get(daemon_node_id)
    if not node:
        raise HTTPException(404, "Daemon node not found.")
    try:
        placement = place_agent_on_node(
            ctx.agent_store,
            ctx.agent_placement_store,
            agent,
            node,
            body,
            team_store=ctx.team_store,
            project_store=ctx.project_store,
        )
    except AgentMoveError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error
    return {"placement": _placement_view(ctx, placement, agent=agent)}


@router.patch("/admin/agent-placements/{placement_id}")
def update_agent_placement(
    placement_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        placement = ctx.agent_placement_store.update_placement(placement_id, body)
    except KeyError as error:
        raise HTTPException(404, "Agent placement not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"placement": _placement_view(ctx, placement)}


@router.delete("/admin/agent-placements/{placement_id}", status_code=200)
def delete_agent_placement(
    placement_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        placement = ctx.agent_placement_store.update_placement(
            placement_id, {"desiredState": "removed"}
        )
    except KeyError as error:
        raise HTTPException(404, "Agent placement not found.") from error
    return {"placement": _placement_view(ctx, placement)}


@router.post("/agent-runs", status_code=202)
async def run_logical_agents(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await json_body(request)
    task_goal = string_field(body, "taskGoal") or string_field(body, "task_goal")
    if not task_goal:
        raise HTTPException(400, "taskGoal is required.")
    raw_assignments = body.get("assignments")
    if raw_assignments is not None and not isinstance(raw_assignments, list):
        raise HTTPException(400, "assignments must be a list.")
    decision = body.get("decision")
    style = body.get("style")
    if style is not None:
        try:
            style = validate_collaboration_style(style, "style")
        except CollaborationStyleError as error:
            raise HTTPException(400, str(error)) from error
    try:
        return await CollaborationConductor(ctx).submit(
            RunIntent(
                task_goal=task_goal,
                session_id=string_field(body, "sessionId")
                or string_field(body, "session_id")
                or None,
                raw_assignments=raw_assignments,
                mode=string_field(body, "mode") or "action",
                requested_team_id=string_field(body, "teamId")
                or string_field(body, "team_id")
                or None,
                requested_project_id=string_field(body, "projectId")
                or string_field(body, "project_id")
                or None,
                requested_node_id=string_field(body, "daemonNodeId")
                or string_field(body, "daemon_node_id")
                or None,
                idempotency_key=string_field(body, "idempotencyKey")
                or string_field(body, "idempotency_key")
                or None,
                user_message_id=string_field(body, "userMessageId")
                or string_field(body, "user_message_id")
                or None,
                decision=decision if isinstance(decision, dict) else None,
                style=style,
            ),
            actor,
        )
    except CollaborationError as error:
        detail: Any = (
            str(error)
            if error.status in (400, 403)
            else {"code": error.code, "message": str(error)}
        )
        raise HTTPException(error.status, detail) from error


def _user_exists(auth_store: Any, user_id: str) -> bool:
    # list_users already excludes soft-deleted users.
    return any(user.get("id") == user_id for user in auth_store.list_users())


def _update_agent_and_realize_placements(
    ctx: AppContextDep, agent_id: str, patch: dict[str, Any]
) -> dict[str, Any]:
    if "skillPolicy" in patch:
        raise HTTPException(422, "Use skill grant routes to manage skillPolicy.")
    previous = ctx.agent_store.get_agent(agent_id)
    updated = ctx.agent_store.update_agent(agent_id, patch)
    if previous and updated.get("version") != previous.get("version"):
        for placement in ctx.agent_placement_store.list_placements(agent_id=agent_id):
            try:
                ctx.agent_placement_store.realize_agent_version(
                    placement["id"], updated["version"]
                )
            except Exception as error:  # noqa: BLE001 - readiness does not depend on this audit field
                logger.warning(
                    "Agent placement version realization deferred",
                    agent_id=agent_id,
                    placement_id=placement["id"],
                    agent_version=updated["version"],
                    error=str(error),
                )
    return updated


def _agent_has_active_run(ctx: AppContextDep, agent_id: str) -> bool:
    return any(
        any(
            assignment.get("agentId") == agent_id
            for assignment in request.get("assignments") or []
        )
        for request in ctx.registry.daemon_store.list_active_run_requests()
    )


NodeMap = dict[str, dict[str, Any]]


def _node_map(ctx: AppContextDep) -> NodeMap:
    """The fleet by node id, read once per request and threaded down.

    ``monitor_nodes`` derives liveness for every node, so every helper that
    needs a node takes this map instead of asking the registry again.
    """
    return {node["id"]: node for node in ctx.registry.monitor_nodes()}


def _placements_by_agent(
    ctx: AppContextDep, agent_ids: list[str]
) -> dict[str, list[dict[str, Any]]]:
    """Live placements grouped by agent, loaded in one query for a batch."""
    if not agent_ids:
        return {}
    wanted = set(agent_ids)
    if len(wanted) == 1:
        rows = ctx.agent_placement_store.list_placements(agent_id=agent_ids[0])
    else:
        rows = ctx.agent_placement_store.list_placements()
    grouped: dict[str, list[dict[str, Any]]] = {agent_id: [] for agent_id in wanted}
    for placement in rows:
        if placement["agentId"] in grouped:
            grouped[placement["agentId"]].append(placement)
    return grouped


def _agent_views(
    ctx: AppContextDep,
    agents: list[dict[str, Any]],
    *,
    nodes: NodeMap | None = None,
) -> list[dict[str, Any]]:
    """``_agent_with_placements`` for a batch: one node read, one placement read."""
    node_map = _node_map(ctx) if nodes is None else nodes
    placements = _placements_by_agent(ctx, [agent["id"] for agent in agents])
    return [
        _agent_with_placements(
            ctx, agent, nodes=node_map, placements=placements.get(agent["id"], [])
        )
        for agent in agents
    ]


def _agent_with_placements(
    ctx: AppContextDep,
    agent: dict[str, Any],
    *,
    nodes: NodeMap | None = None,
    placements: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    node_map = _node_map(ctx) if nodes is None else nodes
    raw_placements = (
        ctx.agent_placement_store.list_placements(agent_id=agent["id"])
        if placements is None
        else placements
    )
    placement_views = [
        _placement_view(ctx, placement, nodes=node_map, agent=agent)
        for placement in raw_placements
    ]
    availability = "offline"
    if any(placement["status"] == "ready" for placement in placement_views):
        availability = "ready"
    elif any(placement["status"] == "busy" for placement in placement_views):
        availability = "busy"
    elif any(placement["status"] == "pending" for placement in placement_views):
        availability = "pending"
    runtime_nodes = _runtime_nodes(node_map, placement_views)
    # The role shapes what a team member is told to contribute, so the people
    # who own the agent need to see it.
    return {
        **agent,
        "availability": availability,
        "placements": placement_views,
        "skills": _agent_skills(ctx, agent, runtime_nodes),
        "canSelectModel": _can_select_model(runtime_nodes),
        "customModelEndpoint": _custom_model_endpoint(agent, runtime_nodes),
        "availableModels": _available_models(agent, runtime_nodes),
    }


def _runtime_nodes(
    nodes: NodeMap, placements: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The live nodes the agent's placements resolved to, in fleet order."""
    node_ids = {
        placement["runtimeNodeId"]
        for placement in placements
        if placement.get("runtimeNodeId")
    }
    return [node for node_id, node in nodes.items() if node_id in node_ids]


def _can_select_model(runtime_nodes: list[dict[str, Any]]) -> bool:
    """Whether the daemon this agent runs on can pass a pinned model on.

    False only when a runtime node is known and lacks the capability — the
    web then says "update the daemon" instead of letting the owner pick a
    model every run would fail on. With no known node it stays True: the
    dispatch gate in the registry still refuses an outdated daemon.
    """
    return all(
        has_capability(node, DAEMON_CAPABILITY_AGENT_MODEL) for node in runtime_nodes
    )


def _custom_model_endpoint(
    agent: dict[str, Any], runtime_nodes: list[dict[str, Any]]
) -> bool:
    """Whether this agent's runtime calls a custom model endpoint on its node.

    The vendor model ids the web suggests may not exist behind a proxy or a
    compatible provider, so the picker then asks for an id that endpoint serves.
    A daemon with ``endpoint-models`` reports only the endpoint's own models, so
    its options need no suppression.
    """
    executor_kind = agent.get("executorKind")
    return any(
        executor_kind in (node.get("customModelEndpoints") or [])
        and not has_capability(node, DAEMON_CAPABILITY_ENDPOINT_MODELS)
        for node in runtime_nodes
    )


def _available_models(
    agent: dict[str, Any], runtime_nodes: list[dict[str, Any]]
) -> list[str]:
    """The model ids this agent's runtime reports on the computers it runs on.

    Like skills, the list is node-reported and resolved on read: the runtime is
    the source of truth for its own catalog, so nothing is stored on the agent.
    """
    executor_kind = agent.get("executorKind")
    if not executor_kind:
        return []
    models: dict[str, None] = {}
    for node in runtime_nodes:
        for model in (node.get("agentModels") or {}).get(executor_kind) or []:
            models.setdefault(model, None)
    return list(models)


def _agent_skills(
    ctx: AppContextDep, agent: dict[str, Any], runtime_nodes: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The skills this agent's runtime actually has on the computers it runs on.

    Skills are node-reported inventory rather than a stored agent field, so they
    are resolved on read from each placement's live node and deduped across
    placements by namespace/name.
    """
    executor_kind = agent.get("executorKind")
    if not executor_kind:
        return []
    skills: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for node in runtime_nodes:
        inventory = node.get("agentInventory") or {}
        entry = inventory.get(executor_kind) or {}
        for skill in entry.get("skills") or []:
            name = skill.get("name")
            if not name:
                continue
            key = (skill.get("namespace") or "", name)
            if key in seen:
                continue
            seen.add(key)
            skills.append({**skill, "source": "node"})

    bundle, skipped = resolve_bundle(ctx, agent)
    available = {entry["skillId"] for entry in (bundle or {}).get("skills", [])}
    reasons = {entry["skillId"]: entry["reason"] for entry in skipped}
    for grant in read_grants(agent):
        skill_id = grant["skillId"]
        skill = ctx.skill_store.get_skill(skill_id)
        skills.append({
            "source": "catalog", "skillId": skill_id,
            "name": skill["name"] if skill else skill_id,
            "namespace": (skill or {}).get("namespace"),
            "description": (skill or {}).get("description", ""),
            "slug": (skill or {}).get("slug", skill_id),
            "available": skill_id in available,
            "pin": grant.get("pin"),
            **({"reason": reasons[skill_id]} if skill_id in reasons else {}),
        })
    return sorted(skills, key=lambda skill: (skill.get("namespace") or "", skill["name"]))


def _placement_view(
    ctx: AppContextDep,
    placement: dict[str, Any],
    *,
    nodes: NodeMap | None = None,
    agent: dict[str, Any] | None = None,
) -> dict[str, Any]:
    node_map = _node_map(ctx) if nodes is None else nodes
    node = placement_node(placement, node_map)
    if agent is None:
        agent = ctx.agent_store.get_agent(placement["agentId"])
    view = placement_status(
        placement, agent, node
    )
    resolved_computer_id = (
        placement.get("computerId")
        or (agent or {}).get("computerId")
        or (computer_id(node) if node else None)
    )
    view = {
        **view,
        **({"computerId": resolved_computer_id} if resolved_computer_id else {}),
        **({"runtimeNodeId": node["id"]} if node else {}),
    }
    if not node:
        return {**view, "nodeOwnership": "unknown"}
    return {
        **view,
        "nodeDisplayName": computer_display_name(ctx, node),
        "nodeOwnership": node.get("nodeLocation") or "unknown",
        **(
            {"nodeSandboxMode": node["sandboxMode"]}
            if node.get("sandboxMode") in ("boxlite", "none")
            else {}
        ),
    }
