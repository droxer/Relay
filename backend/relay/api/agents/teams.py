from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response

from ...persistence.team.store import TeamValidationError, validate_team_payload
from ...security.request_auth import require_admin_session, require_user_session
from ...security.user_handles import user_record
from ...core.team_workflows import is_workflow_team
from ...core.workflows import (
    team_workflows, workflow_catalog, workflow_execution_snapshot, workflow_preview, workflow_step_agent_ids,
)
from ...core.workflow_selection import (
    PREDEFINED_WORKFLOWS, RETIRED_WORKFLOW_ID, default_workflow_id, predefined_style, require_selectable_workflow,
)
from ...teams.workflow import validate_workflow_write
from ...teams.computer import resolve_team_computer
from ...teams.membership import with_member_roles
from .agents import _agent_views, _node_map
from ..deps import AppContextDep
from ..actors import request_actor, chat_service_user_header
from ..bodies import JsonBodyDep, string_field
from ..conditional_get import private_conditional_json

router = APIRouter()

ROSTER_FIELDS = frozenset({"leadAgentId", "memberAgentIds", "computerId"})
SUMMARY_FIELDS = (
    "id", "ownerUserId", "name", "profileImageUrl", "leadAgentId", "memberAgentIds",
    "computerId", "enabled", "createdAt", "updatedAt", "version", "projectId",
    "collaborationStyle", "humanApproval", "projectWorkflowDefaults",
)


def _workflow_owner(
    request: Request, ctx: AppContextDep, owner: str,
    body: dict[str, Any], current: dict[str, Any] | None = None,
) -> None:
    if not is_workflow_team({**(current or {}), **body}):
        return
    if chat_service_user_header(request):
        raise HTTPException(403, "Service actors cannot manage workflow Teams.")
    account = require_user_session(request, ctx.auth_store)
    if account.get("userId") != owner:
        raise HTTPException(403, "Only the Project owner may manage workflow Teams.")
    project_id = (current or {}).get("projectId") or body.get("projectId")
    if isinstance(project_id, str):
        project = ctx.project_store.get_project(project_id)
        if project and project.get("ownerUserId") != owner:
            raise HTTPException(403, "Only the Project owner may manage workflow Teams.")


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
    validate_workflow_write(ctx, owner_user_id, body, current=current)
    if body.get("defaultWorkflowId") == RETIRED_WORKFLOW_ID and default_workflow_id(current) != RETIRED_WORKFLOW_ID:
        require_selectable_workflow(RETIRED_WORKFLOW_ID)
    if body.get("collaborationStyle") == "pipeline" and (
        (current or {}).get("collaborationStyle") != "pipeline" or default_workflow_id(current) != RETIRED_WORKFLOW_ID
    ):
        require_selectable_workflow(RETIRED_WORKFLOW_ID)
    if "defaultWorkflowId" in body and predefined_style(body["defaultWorkflowId"]) is None:
        snapshot = workflow_execution_snapshot({**(current or {}), **body}, body["defaultWorkflowId"])
        validate_workflow_write(ctx, owner_user_id, snapshot)
    if isinstance(body.get('projectWorkflowDefaults'), dict):
        for workflow_id in body['projectWorkflowDefaults'].values():
            snapshot = workflow_execution_snapshot({**(current or {}), **body}, workflow_id)
            validate_workflow_write(ctx, owner_user_id, snapshot)
    if current is not None and not ROSTER_FIELDS & body.keys():
        # Nothing about who is on the team or where it runs changes, so the
        # legacy roster is not re-judged (workflows were checked above). That keeps a team emptied by agent
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
    # A legacy echo must not restore Pipeline after a concurrent replacement.
    if patch.get("defaultWorkflowId") == RETIRED_WORKFLOW_ID:
        patch.pop("defaultWorkflowId")
    if patch.get("collaborationStyle") == "pipeline" and "defaultWorkflowId" not in patch:
        patch.pop("collaborationStyle")
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
    ctx: AppContextDep, teams: list[dict[str, Any]], *, scoped: bool = False,
) -> dict[str, dict[str, Any]]:
    """Agent views for every live member across ``teams``, computed once.

    One batched agent lookup, then one placement read and one node read for
    the whole batch, instead of a checkout and query per distinct member.
    """
    member_ids: dict[str, None] = {}
    for team in teams:
        for agent_id in team.get("memberAgentIds", []):
            member_ids.setdefault(agent_id, None)
    if not member_ids:
        return {}
    agents = ctx.agent_store.get_agents_by_ids(list(member_ids))
    return {
        view["id"]: view
        for view in _agent_views(ctx, agents, summary=True, scope_to_placements=scoped)
    }


def _team_views(
    ctx: AppContextDep, teams: list[dict[str, Any]], *, summary: bool = False, scoped: bool = False,
) -> list[dict[str, Any]]:
    views = _member_views(ctx, teams, scoped=scoped)
    return [_team_view(ctx, team, member_views=views, view="summary" if summary else "full") for team in teams]


def _workflow_options_summary(team: dict[str, Any], *, include_presets: bool = True) -> list[dict[str, Any]]:
    definitions = team.get("workflows")
    if definitions is None:
        definitions = [team] if "workflowSteps" in team else []
    custom = [
        {
            **{key: definition[key] for key in ("id", "name", "projectId", "enabled", "updatedAt", "version") if key in definition},
            "kind": "steps",
            "stepCount": len(definition["workflowSteps"]),
            "stepAgentIds": workflow_step_agent_ids(definition),
        } for definition in definitions
    ]
    return [*PREDEFINED_WORKFLOWS, *custom] if include_presets else custom


def _member_summary(agent: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": agent["id"],
        "displayName": agent["displayName"],
        "profileImageUrl": agent.get("profileImageUrl"),
        "executorKind": agent["executorKind"],
        "defaultRole": agent.get("defaultRole"),
        **({"roleLevel": agent["roleLevel"]} if agent.get("roleLevel") else {}),
        "enabled": agent.get("enabled", True),
        "availability": agent.get("availability", "offline"),
    }


def _preview_member(agent: dict[str, Any], owner: str) -> dict[str, Any]:
    member = _member_summary(agent)
    visible = member["enabled"] and agent.get("supervisorUserId") == owner
    return {
        **member,
        "placements": [
            {key: placement[key] for key in (
                "id", "daemonNodeId", "runtimeNodeId", "computerId", "nodeDisplayName", "desiredState", "priority",
            ) if key in placement}
            for placement in agent["placements"]
            if placement.get("supervisorUserId") == owner and placement.get("desiredState") != "removed"
        ] if visible else [],
        **({"computerId": agent["computerId"]} if visible and agent.get("computerId") else {}),
    }


def _team_summary(team: dict[str, Any], *, include_presets: bool = True) -> dict[str, Any]:
    return {
        **{key: team[key] for key in SUMMARY_FIELDS if key in team},
        "defaultWorkflowId": default_workflow_id(team),
        **({"workflowStepCount": len(team["workflowSteps"])} if "workflowSteps" in team else {}),
        "memberConfigs": {
            agent_id: {key: config[key] for key in ("role", "roleLevel", "participation") if key in config}
            for agent_id, config in (team.get("memberConfigs") or {}).items()
        },
        "workflowOptions": _workflow_options_summary(team, include_presets=include_presets),
    }


def _team_view(
    ctx: AppContextDep,
    team: dict[str, Any],
    *,
    member_views: dict[str, dict[str, Any]] | None = None,
    view: Literal["full", "summary", "record", "preview"] = "full",
    scoped: bool = False,
) -> dict[str, Any]:
    views = _member_views(ctx, [team], scoped=scoped) if member_views is None else member_views
    members = [_member_summary(views[agent_id]) for agent_id in team.get("memberAgentIds", []) if agent_id in views]
    lead = next(
        (member for member in members if member["id"] == team.get("leadAgentId")),
        None,
    )
    if view == "summary":
        return {**_team_summary(team), "members": members, "lead": lead}
    roster = {"defaultWorkflowId": default_workflow_id(team), "members": members, "lead": lead}
    legacy_count = {"workflowStepCount": len(team["workflowSteps"])} if "workflowSteps" in team else {}
    if view == "preview":
        definitions = team["workflows"] if "workflows" in team else team_workflows(team)
        return {
            **{key: value for key, value in team.items() if key not in {"workflows", "workflowSteps"}},
            **roster,
            "members": [_preview_member(views[member["id"]], team["ownerUserId"]) for member in members],
            **legacy_count,
            "workflowPreviews": [workflow_preview(definition) for definition in definitions],
            "workflowOptions": _workflow_options_summary(team),
        }
    return {
        **team, **roster,
        "workflows": team_workflows(team),
        **({"workflowOptions": workflow_catalog(team)} if view == "full"
           else {"workflowOptions": _workflow_options_summary(team)}),
    }


@router.get("/teams")
def list_teams(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    summary = request.query_params.get("view") == "summary"
    teams = ctx.team_store.list_teams(actor["userId"])
    if summary and request.query_params.get("format") == "compact":
        members = _member_views(ctx, teams, scoped=True)
        return {
            "view": "summary",
            "teams": [_team_summary(team, include_presets=False) for team in teams],
            "memberDirectory": [_member_summary(members[agent_id]) for agent_id in sorted(members)],
            "predefinedWorkflows": PREDEFINED_WORKFLOWS,
        }
    return {"teams": _team_views(ctx, teams, summary=summary, scoped=True), **({"view": "summary"} if summary else {})}


@router.get("/teams/{team_id}")
def get_team(team_id: str, request: Request, ctx: AppContextDep) -> Response:
    actor = request_actor(request, ctx.auth_store)
    team = _owned_team(ctx, team_id, actor["userId"])
    view: Literal["preview", "record"] = "preview" if request.query_params.get("view") == "preview" else "record"
    return private_conditional_json(request, {"team": _team_view(ctx, team, view=view, scoped=True)})


def _active_computers(agent: dict[str, Any]) -> list[str]:
    placed = dict.fromkeys(
        item["computerId"] for item in agent["placements"]
        if item.get("computerId") and item["desiredState"] == "active"
    )
    return list(placed) or ([agent["computerId"]] if agent.get("computerId") else [])


@router.get("/teams/{team_id}/member-choices")
def list_team_member_choices(team_id: str, request: Request, ctx: AppContextDep) -> Response:
    owner = require_user_session(request, ctx.auth_store)["userId"]
    team = _owned_team(ctx, team_id, owner)
    member_ids = set(team.get("memberAgentIds", []))
    records = [agent for agent in ctx.agent_store.list_agent_summaries(owner) if agent.get("enabled", True)]
    views = _agent_views(ctx, records, nodes=_node_map(ctx, owner=owner), owner=owner, summary=True) if records else []
    computers = {agent["id"]: _active_computers(agent) for agent in views}
    target = team.get("computerId")
    if not target and member_ids:
        shared = set.intersection(*(set(computers.get(member_id, ())) for member_id in member_ids))
        lead_computers = computers.get(team.get("leadAgentId"), [])
        target = min(shared, default=next(iter(lead_computers), ""))
    choices = [
        _preview_member(agent, owner) for agent in views
        if agent["id"] in member_ids or target in computers[agent["id"]]
    ]
    return private_conditional_json(request, {"computerId": target or "", "agents": choices})


@router.post("/teams", status_code=201)
def create_team(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = _request_body
    _workflow_owner(request, ctx, actor["userId"], body)
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
    _workflow_owner(request, ctx, current["ownerUserId"], body, current)
    try:
        roster = _validated_roster(ctx, actor["userId"], body, current=current)
        team = ctx.team_store.update_team(
            team_id, _team_patch(ctx, current, body, roster)
        )
    except ValueError as error:
        raise _team_error(error) from error
    if body.keys() == {"defaultWorkflowId"} and request.query_params.get("format") == "delta":
        return _team_workflow_default_update(team)
    view: Literal["preview", "full"] = "preview" if request.query_params.get("view") == "preview" else "full"
    return {"team": _team_view(ctx, team, view=view)}


def _team_workflow_default_update(team: dict[str, Any], *, project_id: str | None = None) -> dict[str, Any]:
    version = team["version"]
    update = {
        "teamId": team["id"], "baseVersion": version - 1, "version": version,
        "updatedAt": team["updatedAt"], "defaultWorkflowId": default_workflow_id(team),
        "legacyWorkflow": is_workflow_team(team),
    }
    if project_id is not None:
        update["projectDefault"] = {
            "projectId": project_id, "workflowId": team["projectWorkflowDefaults"].get(project_id),
        }
    return {"teamWorkflowUpdate": update}


@router.patch("/teams/{team_id}/members/{agent_id}")
def update_team_member(
    team_id: str, agent_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = _owned_team(ctx, team_id, actor["userId"])
    _workflow_owner(request, ctx, current["ownerUserId"], {}, current)
    try:
        agent = ctx.agent_store.get_agent(agent_id)
        if not agent or agent.get("deletedAt"):
            raise TeamValidationError("team_member_not_found")
        if agent.get("supervisorUserId") != actor["userId"]:
            raise TeamValidationError("team_member_wrong_supervisor")
        update = ctx.team_store.update_member_config(
            team_id, agent_id, _request_body, default_role=agent.get("defaultRole") or "implementer",
        )
    except KeyError as error:
        raise HTTPException(404, "Team not found.") from error
    except ValueError as error:
        raise _team_error(error) from error
    return {"teamMemberUpdate": update}


@router.delete("/teams/{team_id}", status_code=200)
def delete_team(team_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = _owned_team(ctx, team_id, actor["userId"])
    _workflow_owner(request, ctx, current["ownerUserId"], {}, current)
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
    if not user_record(ctx.auth_store, owner_user_id):
        raise HTTPException(404, "User not found.")
    _workflow_owner(request, ctx, owner_user_id, body)
    try:
        lead, members, computer = _validated_roster(ctx, owner_user_id, body)
        team = ctx.team_store.create_team(
            owner_user_id,
            {
                **{key: value for key, value in body.items() if key != "ownerUserId"},
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
    _workflow_owner(request, ctx, current["ownerUserId"], body, current)
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
    current = _active_team(ctx, team_id)
    _workflow_owner(request, ctx, current["ownerUserId"], {}, current)
    deleted = ctx.team_store.delete_team(team_id)
    ctx.profile_image_store.delete("teams", team_id)
    return {"team": _team_view(ctx, deleted)}
