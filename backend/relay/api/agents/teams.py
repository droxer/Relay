from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...persistence.team.store import TeamValidationError, validate_team_payload
from ...security.request_auth import require_admin_session
from ...teams.computer import resolve_team_computer
from ...teams.membership import with_member_roles
from .agents import _agent_views, _user_exists
from ..deps import AppContextDep
from ..actors import request_actor
from ..bodies import JsonBodyDep, string_field

router = APIRouter()

ROSTER_FIELDS = frozenset({"leadAgentId", "memberAgentIds", "computerId"})


def _team_error(error: ValueError) -> HTTPException:
    code = error.code if isinstance(error, TeamValidationError) else str(error)
    return HTTPException(409 if code == "team_name_taken" else 400, code)


def _active_team(ctx: AppContextDep, team_id: str) -> dict[str, Any]:
    team = ctx.team_store.get_team(team_id)
    if not team or team.get("deletedAt"):
        raise HTTPException(404, "Team not found.")
    return team


def _owned_team(
    ctx: AppContextDep, team_id: str, user_id: str
) -> dict[str, Any]:
    team = _active_team(ctx, team_id)
    if team.get("ownerUserId") != user_id:
        raise HTTPException(403, "Cannot access another user's team.")
    return team


def _validated_roster(
    ctx: AppContextDep,
    owner_user_id: str,
    body: dict[str, Any],
    *,
    current: dict[str, Any] | None = None,
) -> tuple[str | None, list[str], dict[str, Any]]:
    """Validate a team write's roster and pin it to one computer.

    Returns the lead, the members, and the computer fields to persist — empty
    when the write touches neither roster nor computer.
    """
    if current is not None and not ROSTER_FIELDS & body.keys():
        # Nothing about who is on the team or where it runs changes, so the
        # stored roster is not re-judged. That keeps a team emptied by agent
        # deletion renamable; the store still refuses to enable it.
        return current.get("leadAgentId"), list(current.get("memberAgentIds") or []), {}
    lead, members = validate_team_payload(
        owner_user_id, body, ctx.agent_store, current=current
    )
    computer = resolve_team_computer(
        owner_user_id,
        body,
        members,
        current=current,
        registry=ctx.registry,
        agent_store=ctx.agent_store,
        placement_store=ctx.agent_placement_store,
    )
    return lead, members, ({"computerId": computer} if computer else {})


def _team_patch(
    ctx: AppContextDep,
    current: dict[str, Any],
    body: dict[str, Any],
    roster: tuple[str | None, list[str], dict[str, Any]],
) -> dict[str, Any]:
    lead, members, computer = roster
    patch = dict(body)
    if "leadAgentId" in body:
        patch["leadAgentId"] = lead
    if "memberAgentIds" in body:
        patch["memberAgentIds"] = members
    if "memberAgentIds" in body or "memberConfigs" in body:
        configs = body.get("memberConfigs", current.get("memberConfigs") or {})
        if isinstance(configs, dict):
            kept = {key: value for key, value in configs.items() if key in members}
            patch["memberConfigs"] = with_member_roles(ctx.agent_store, members, kept)
    return {**patch, **computer}


def _member_configs(
    ctx: AppContextDep, body: dict[str, Any], members: list[str]
) -> Any:
    """A new team's member configs, each member carrying a team role."""
    configs = body.get("memberConfigs", {})
    if not isinstance(configs, dict):
        return configs  # the store rejects it with its own message
    return with_member_roles(ctx.agent_store, members, configs)


def _member_views(
    ctx: AppContextDep, teams: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Agent views for every live member across ``teams``, computed once.

    One agent read per distinct member, then one placement read and one node
    read for the whole batch, instead of the full placement chain per member
    per team.
    """
    member_ids: dict[str, None] = {}
    for team in teams:
        for agent_id in team.get("memberAgentIds", []):
            member_ids.setdefault(agent_id, None)
    agents = [
        agent
        for agent in (ctx.agent_store.get_agent(agent_id) for agent_id in member_ids)
        if agent and not agent.get("deletedAt")
    ]
    return {
        view["id"]: view
        for view in _agent_views(ctx, agents)
    }


def _team_views(ctx: AppContextDep, teams: list[dict[str, Any]]) -> list[dict[str, Any]]:
    views = _member_views(ctx, teams)
    return [_team_view(ctx, team, member_views=views) for team in teams]


def _team_view(
    ctx: AppContextDep,
    team: dict[str, Any],
    *,
    member_views: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    views = _member_views(ctx, [team]) if member_views is None else member_views
    members = []
    for agent_id in team.get("memberAgentIds", []):
        view = views.get(agent_id)
        if view is None:
            continue
        members.append(
            {
                "id": view["id"],
                "displayName": view["displayName"],
                "profileImageUrl": view.get("profileImageUrl"),
                "executorKind": view["executorKind"],
                "defaultRole": view.get("defaultRole"),
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
    return {"teams": _team_views(ctx, ctx.team_store.list_teams(actor["userId"]))}


@router.post("/teams", status_code=201)
def create_team(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = _request_body
    try:
        lead, members, computer = _validated_roster(ctx, actor["userId"], body)
        team = ctx.team_store.create_team(
            actor["userId"],
            {
                **body,
                "leadAgentId": lead,
                "memberAgentIds": members,
                "memberConfigs": _member_configs(ctx, body, members),
                **computer,
            },
        )
    except ValueError as error:
        raise _team_error(error) from error
    return {"team": _team_view(ctx, team)}


@router.patch("/teams/{team_id}")
def update_team(
    team_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = _owned_team(ctx, team_id, actor["userId"])
    body = _request_body
    try:
        roster = _validated_roster(ctx, actor["userId"], body, current=current)
        team = ctx.team_store.update_team(
            team_id, _team_patch(ctx, current, body, roster)
        )
    except ValueError as error:
        raise _team_error(error) from error
    return {"team": _team_view(ctx, team)}


@router.delete("/teams/{team_id}", status_code=200)
def delete_team(team_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    _owned_team(ctx, team_id, actor["userId"])
    deleted = ctx.team_store.delete_team(team_id)
    ctx.profile_image_store.delete("teams", team_id)
    return {"team": _team_view(ctx, deleted)}


@router.get("/admin/teams")
def list_control_panel_teams(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    owner_user_id = request.query_params.get("ownerUserId") or None
    return {"teams": _team_views(ctx, ctx.team_store.list_teams(owner_user_id))}


@router.post("/admin/teams", status_code=201)
def create_control_panel_team(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    owner_user_id = string_field(body, "ownerUserId")
    if not owner_user_id:
        raise HTTPException(400, "ownerUserId is required.")
    if not _user_exists(ctx.auth_store, owner_user_id):
        raise HTTPException(404, "User not found.")
    try:
        lead, members, computer = _validated_roster(ctx, owner_user_id, body)
        team = ctx.team_store.create_team(
            owner_user_id,
            {
                "name": body.get("name"),
                "profileImageUrl": body.get("profileImageUrl"),
                "enabled": body.get("enabled", True),
                "memberConfigs": _member_configs(ctx, body, members),
                "acceptanceCriteria": body.get("acceptanceCriteria", []),
                "collaborationStyle": body.get("collaborationStyle"),
                "humanApproval": body.get("humanApproval"),
                "leadAgentId": lead,
                "memberAgentIds": members,
                **computer,
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
        roster = _validated_roster(ctx, current["ownerUserId"], body, current=current)
        team = ctx.team_store.update_team(
            team_id, _team_patch(ctx, current, body, roster)
        )
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
