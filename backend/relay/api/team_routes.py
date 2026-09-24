from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..persistence.team_store import TeamValidationError, validate_team_payload
from ..security.auth import require_admin_session
from .agent_routes import _agent_with_placements, _employee_exists
from .deps import AppContextDep
from .helpers import (
    JsonBodyDep,
    request_actor,
    string_field,
)

router = APIRouter()


def _team_error(error: ValueError) -> HTTPException:
    code = error.code if isinstance(error, TeamValidationError) else str(error)
    return HTTPException(409 if code == "team_name_taken" else 400, code)


def _active_team(ctx: AppContextDep, team_id: str) -> dict[str, Any]:
    team = ctx.team_store.get_team(team_id)
    if not team or team.get("deletedAt"):
        raise HTTPException(404, "Team not found.")
    return team


def _owned_team(
    ctx: AppContextDep, team_id: str, employee_id: str
) -> dict[str, Any]:
    team = _active_team(ctx, team_id)
    if team.get("ownerEmployeeId") != employee_id:
        raise HTTPException(403, "Cannot access another employee's team.")
    return team


def _team_view(ctx: AppContextDep, team: dict[str, Any]) -> dict[str, Any]:
    members = []
    for agent_id in team.get("memberAgentIds", []):
        agent = ctx.agent_store.get_agent(agent_id)
        if agent and not agent.get("deletedAt"):
            view = _agent_with_placements(ctx, agent)
            members.append(
                {
                    "id": view["id"],
                    "displayName": view["displayName"],
                    "profileImageUrl": view.get("profileImageUrl"),
                    "executorKind": view["executorKind"],
                    "defaultRole": agent.get("defaultRole"),
                    "enabled": view.get("enabled", True),
                    "availability": view.get("availability", "offline"),
                }
            )
    lead = next(
        (member for member in members if member["id"] == team.get("leadAgentId")),
        None,
    )
    return {**team, "members": members, "lead": lead}


@router.get("/teams")
def list_teams(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    return {
        "teams": [
            _team_view(ctx, team)
            for team in ctx.team_store.list_teams(actor["employeeId"])
        ]
    }


@router.post("/teams", status_code=201)
def create_team(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = _request_body
    try:
        lead, members = validate_team_payload(
            actor["employeeId"],
            body,
            ctx.agent_store,
        )
        team = ctx.team_store.create_team(
            actor["employeeId"],
            {**body, "leadAgentId": lead, "memberAgentIds": members},
        )
    except ValueError as error:
        raise _team_error(error) from error
    return {"team": _team_view(ctx, team)}


@router.patch("/teams/{team_id}")
def update_team(
    team_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = _owned_team(ctx, team_id, actor["employeeId"])
    body = _request_body
    try:
        lead, members = validate_team_payload(
            actor["employeeId"],
            body,
            ctx.agent_store,
            current=current,
        )
        patch = dict(body)
        if "leadAgentId" in body:
            patch["leadAgentId"] = lead
        if "memberAgentIds" in body:
            patch["memberAgentIds"] = members
        team = ctx.team_store.update_team(team_id, patch)
    except ValueError as error:
        raise _team_error(error) from error
    return {"team": _team_view(ctx, team)}


@router.delete("/teams/{team_id}", status_code=200)
def delete_team(team_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    _owned_team(ctx, team_id, actor["employeeId"])
    deleted = ctx.team_store.delete_team(team_id)
    ctx.profile_image_store.delete("teams", team_id)
    return {"team": _team_view(ctx, deleted)}


@router.get("/admin/teams")
def list_control_panel_teams(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    owner_employee_id = request.query_params.get("ownerEmployeeId") or None
    return {
        "teams": [
            _team_view(ctx, team)
            for team in ctx.team_store.list_teams(owner_employee_id)
        ]
    }


@router.post("/admin/teams", status_code=201)
def create_control_panel_team(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    owner_employee_id = string_field(body, "ownerEmployeeId")
    if not owner_employee_id:
        raise HTTPException(400, "ownerEmployeeId is required.")
    if not _employee_exists(ctx.auth_store, owner_employee_id):
        raise HTTPException(404, "Employee not found.")
    try:
        lead, members = validate_team_payload(
            owner_employee_id,
            body,
            ctx.agent_store,
        )
        team = ctx.team_store.create_team(
            owner_employee_id,
            {
                "name": body.get("name"),
                "profileImageUrl": body.get("profileImageUrl"),
                "enabled": body.get("enabled", True),
                "memberConfigs": body.get("memberConfigs", {}),
                "acceptanceCriteria": body.get("acceptanceCriteria", []),
                "collaborationStyle": body.get("collaborationStyle"),
                "leadAgentId": lead,
                "memberAgentIds": members,
            },
        )
    except ValueError as error:
        raise _team_error(error) from error
    return {"team": _team_view(ctx, team)}


@router.get("/admin/teams/{team_id}")
def get_control_panel_team(
    team_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return {"team": _team_view(ctx, _active_team(ctx, team_id))}


@router.patch("/admin/teams/{team_id}")
def update_control_panel_team(
    team_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    current = _active_team(ctx, team_id)
    body = _request_body
    try:
        lead, members = validate_team_payload(
            current["ownerEmployeeId"],
            body,
            ctx.agent_store,
            current=current,
        )
        patch = dict(body)
        if "leadAgentId" in body:
            patch["leadAgentId"] = lead
        if "memberAgentIds" in body:
            patch["memberAgentIds"] = members
        team = ctx.team_store.update_team(team_id, patch)
    except ValueError as error:
        raise _team_error(error) from error
    return {"team": _team_view(ctx, team)}


@router.delete("/admin/teams/{team_id}", status_code=200)
def delete_control_panel_team(
    team_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    _active_team(ctx, team_id)
    deleted = ctx.team_store.delete_team(team_id)
    ctx.profile_image_store.delete("teams", team_id)
    return {"team": _team_view(ctx, deleted)}
