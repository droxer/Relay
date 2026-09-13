from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger

from ..collaboration.models import RunIntent
from ..collaboration.service import CollaborationConductor, CollaborationError
from ..core.computer_identity import computer_id
from ..persistence.agent_placement_store import create_node_placement, placement_status
from ..security.auth import require_admin_session
from ..services.agent_binding import binding_status
from ..services.agent_creation import AgentCreationError, create_agent_for_employee
from ..services.agent_routing import placement_node
from ..services.computer_names import computer_display_name
from ..services.project_catalog import agent_has_active_project
from ..services.team_membership import remove_agent_from_teams
from .deps import AppContextDep
from .helpers import (
    json_body,
    request_actor,
    string_field,
)

router = APIRouter()


# Employees can adjust their agent's personality at any time; the birth
# certificate (computerId / executorKind / defaultRole) is fixed at creation
# — changing the role is like swapping in a different coworker, so it should
# be a new agent, not an edit.
AGENT_META_FIELDS = frozenset({"displayName", "instructions"})


@router.get("/agents")
async def list_agents(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    agents = ctx.agent_store.list_agents(supervisor_employee_id=actor["employeeId"])
    nodes = ctx.registry.monitor_nodes()
    # An agent an employee explicitly created always stays on the roster.
    # If its computer or runtime is gone, flag it — let the employee decide
    # whether to delete it. The system doesn't make that call for them.
    return {
        "agents": [
            {
                **_agent_with_placements(ctx, agent),
                "bindingStatus": binding_status(agent, nodes),
            }
            for agent in agents
            if agent.get("enabled", True)
        ]
    }


@router.post("/agents", status_code=201)
async def create_agent(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await json_body(request)
    try:
        agent = create_agent_for_employee(ctx, actor["employeeId"], body)
    except AgentCreationError as error:
        raise HTTPException(error.status, str(error)) from error
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error
    return {"agent": _agent_with_placements(ctx, agent)}


@router.patch("/agents/{agent_id}")
async def update_agent(
    agent_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
    if agent.get("supervisorEmployeeId") != actor["employeeId"]:
        raise HTTPException(403, "Cannot update another employee's agent.")
    body = await json_body(request)
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


@router.get("/admin/agents")
async def list_control_panel_agents(
    request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    employee_id = (
        request.query_params.get("employeeId")
        or request.query_params.get("supervisorEmployeeId")
        or None
    )
    return {
        "agents": [
            _agent_with_placements(ctx, agent)
            for agent in ctx.agent_store.list_agents(
                supervisor_employee_id=employee_id, include_deleted=True
            )
        ]
    }


@router.post("/admin/agents", status_code=201)
async def create_control_panel_agent(
    request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = await json_body(request)
    employee_id = string_field(body, "supervisorEmployeeId")
    if not _employee_exists(ctx.auth_store, employee_id):
        raise HTTPException(404, "Employee not found.")
    try:
        agent = create_agent_for_employee(ctx, employee_id, body)
    except AgentCreationError as error:
        raise HTTPException(error.status, str(error)) from error
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error
    return {"agent": agent}


@router.get("/admin/agents/{agent_id}")
async def get_control_panel_agent(
    agent_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, "Agent not found.")
    return {
        "agent": {
            **_agent_with_placements(ctx, agent),
            "bindingStatus": binding_status(agent, ctx.registry.monitor_nodes()),
        }
    }


@router.patch("/admin/agents/{agent_id}")
async def update_control_panel_agent(
    agent_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        return {
            "agent": _update_agent_and_realize_placements(
                ctx, agent_id, await json_body(request)
            )
        }
    except KeyError as error:
        raise HTTPException(404, "Agent not found.") from error
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error


@router.delete("/admin/agents/{agent_id}", status_code=200)
async def delete_control_panel_agent(
    agent_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
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
        remove_agent_from_teams(ctx.team_store, agent_id, agent["supervisorEmployeeId"])
        return {"agent": deleted}
    except KeyError as error:
        raise HTTPException(404, "Agent not found.") from error


@router.get("/admin/agent-placements")
async def list_agent_placements(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    agent_id = request.query_params.get("agentId") or None
    daemon_node_id = request.query_params.get("nodeId") or None
    placements = ctx.agent_placement_store.list_placements(
        agent_id=agent_id,
        daemon_node_id=daemon_node_id,
        include_removed=True,
    )
    return {"placements": [_placement_view(ctx, placement) for placement in placements]}


@router.post("/admin/agents/{agent_id}/placements", status_code=201)
async def create_agent_placement(
    agent_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
    body = await json_body(request)
    daemon_node_id = body.get("daemonNodeId")
    if not isinstance(daemon_node_id, str) or not daemon_node_id.strip():
        raise HTTPException(400, "daemonNodeId is required.")
    node = ctx.registry.get(daemon_node_id)
    if not node:
        raise HTTPException(404, "Daemon node not found.")
    try:
        placement = create_node_placement(ctx.agent_placement_store, agent, node, body)
    except ValueError as error:
        raise HTTPException(
            409 if "already has" in str(error) else 400, str(error)
        ) from error
    return {"placement": _placement_view(ctx, placement)}


@router.patch("/admin/agent-placements/{placement_id}")
async def update_agent_placement(
    placement_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = await json_body(request)
    try:
        placement = ctx.agent_placement_store.update_placement(placement_id, body)
    except KeyError as error:
        raise HTTPException(404, "Agent placement not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"placement": _placement_view(ctx, placement)}


@router.delete("/admin/agent-placements/{placement_id}", status_code=200)
async def delete_agent_placement(
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


def _employee_exists(auth_store: Any, employee_id: str) -> bool:
    if hasattr(auth_store, "list_employees"):
        return any(
            employee.get("id") == employee_id
            for employee in auth_store.list_employees()
        )
    if (
        hasattr(auth_store, "deleted_employee_ids")
        and employee_id in auth_store.deleted_employee_ids()
    ):
        return False
    return any(
        user.get("employeeId") == employee_id for user in auth_store.list_users()
    )


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
            except Exception as error:  # readiness does not depend on this audit field
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


def _agent_with_placements(ctx: AppContextDep, agent: dict[str, Any]) -> dict[str, Any]:
    placements = [
        _placement_view(ctx, placement)
        for placement in ctx.agent_placement_store.list_placements(agent_id=agent["id"])
    ]
    availability = "offline"
    if any(placement["status"] == "ready" for placement in placements):
        availability = "ready"
    elif any(placement["status"] == "busy" for placement in placements):
        availability = "busy"
    elif any(placement["status"] == "pending" for placement in placements):
        availability = "pending"
    # The role shapes what a team member is told to contribute, so the people
    # who own the agent need to see it.
    return {
        **agent,
        "availability": availability,
        "placements": placements,
        "skills": _agent_skills(ctx, agent, placements),
    }


def _agent_skills(
    ctx: AppContextDep, agent: dict[str, Any], placements: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The skills this agent's runtime actually has on the computers it runs on.

    Skills are node-reported inventory rather than a stored agent field, so they
    are resolved on read from each placement's live node and deduped across
    placements by namespace/name.
    """
    executor_kind = agent.get("executorKind")
    if not executor_kind:
        return []
    node_ids = {
        placement["runtimeNodeId"]
        for placement in placements
        if placement.get("runtimeNodeId")
    }
    skills: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for node in ctx.registry.monitor_nodes():
        if node["id"] not in node_ids:
            continue
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
    from ..services.skill_bundle import resolve_bundle
    from ..services.skill_grants import read_grants

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


def _placement_view(ctx: AppContextDep, placement: dict[str, Any]) -> dict[str, Any]:
    nodes = {item["id"]: item for item in ctx.registry.monitor_nodes()}
    node = placement_node(placement, nodes)
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
