"""Who a task may be assigned to, judged for the person asking.

Every refusal is a ``TaskRequestError`` carrying the status and detail the
task routes have always answered with.
"""
from __future__ import annotations

from typing import Any

from ..automations.model import EVENT_KINDS
from ..projects.runtime import project_task_assignment_error
from .requests import TaskRequestError
from ..projects.access import ProjectAccessError, project_for_owner
from ..security.actor import Actor

FILTER_SCOPE_KEYS = ("projectId", "assignedAgentId", "assignedTeamId")


def logical_agent_for_assignment(
    ctx: Any,
    actor: Actor,
    agent_id: str | None,
    *,
    expected_user_id: str | None = None,
) -> dict[str, Any] | None:
    if not agent_id:
        return None
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise TaskRequestError(404, "Logical agent not found.")
    if not agent.get("enabled", True):
        raise TaskRequestError(409, "agent_disabled")
    allowed_user_id = expected_user_id or actor["userId"]
    if agent.get("supervisorUserId") != allowed_user_id:
        raise TaskRequestError(403, "Logical agent is not available to the task assignee.")
    if not actor["isAdmin"] and agent.get("supervisorUserId") != actor["userId"]:
        raise TaskRequestError(403, "Logical agent access denied.")
    return agent


def team_for_assignment(
    ctx: Any,
    actor: Actor,
    team_id: str | None,
    *,
    expected_user_id: str,
    require_actor_access: bool = True,
) -> dict[str, Any] | None:
    if not team_id:
        return None
    team = ctx.team_store.get_team(team_id)
    if not team or team.get("deletedAt"):
        raise TaskRequestError(404, "Team not found.")
    if not team.get("enabled", True):
        # Mirrors `team_agents`: an emptied team needs restaffing, not enabling.
        raise TaskRequestError(
            409, "team_disabled" if team.get("memberAgentIds") else "team_invalid"
        )
    if team.get("ownerUserId") != expected_user_id:
        raise TaskRequestError(403, "Team is not available to the task assignee.")
    if (
        require_actor_access
        and not actor["isAdmin"]
        and team.get("ownerUserId") != actor["userId"]
    ):
        raise TaskRequestError(403, "Team access denied.")
    return team


def validate_project_task_assignment(
    ctx: Any,
    task: dict[str, Any],
    *,
    assigned_agent_id: str | None,
    assigned_team_id: str | None,
) -> None:
    project_id = task.get("projectId")
    if not project_id:
        return
    project = ctx.project_store.get_project(project_id)
    if not project:
        raise TaskRequestError(404, "Project not found.")
    validate_project_assignment(
        ctx,
        project,
        assigned_agent_id=assigned_agent_id,
        assigned_team_id=assigned_team_id,
    )


def validate_project_assignment(
    ctx: Any,
    project: dict[str, Any],
    *,
    assigned_agent_id: str | None,
    assigned_team_id: str | None,
) -> None:
    """A project task may go to anyone who shares the project's computer."""
    team = ctx.team_store.get_team(assigned_team_id) if assigned_team_id else None
    if assigned_team_id and (not team or team.get("deletedAt")):
        raise TaskRequestError(404, "Team not found.")
    if code := project_task_assignment_error(
        project,
        agent_id=assigned_agent_id,
        team=team,
        placement_store=ctx.agent_placement_store,
    ):
        raise TaskRequestError(400, code)


def owned_project(
    ctx: Any, project_id: str | None, owner_user_id: str
) -> dict[str, Any] | None:
    """An enabled project of `owner_user_id`, refused like the project routes refuse it."""
    try:
        return project_for_owner(ctx.project_store, project_id, owner_user_id, require_enabled=True)
    except ProjectAccessError as error:
        raise TaskRequestError(error.status, error.detail) from error


def validate_trigger_scope(
    ctx: Any, triggers: list[dict[str, Any]] | None, *, owner: str | None,
) -> None:
    """Filters may observe only work their owner is allowed to assign."""
    for index, trigger in enumerate(triggers or []):
        if trigger.get("kind") in EVENT_KINDS:
            _validate_filter_scope(
                ctx, trigger.get("filters") or {}, f"routineTriggers[{index}]", owner=owner
            )


def _validate_filter_scope(
    ctx: Any, filters: dict[str, Any], at: str, *, owner: str | None,
) -> None:
    if not any(key in filters for key in FILTER_SCOPE_KEYS):
        return
    if not owner:
        # No owner means no assignment scope to check the filter against.
        raise TaskRequestError(
            400, "Only an automation with an owner can filter by project, agent, or team."
        )
    _ensure_filter_targets_exist(ctx, filters, at)
    owner_actor: Actor = {"userId": owner, "isAdmin": False}
    logical_agent_for_assignment(
        ctx, owner_actor, filters.get("assignedAgentId"), expected_user_id=owner
    )
    team_for_assignment(ctx, owner_actor, filters.get("assignedTeamId"), expected_user_id=owner)
    project = owned_project(ctx, filters.get("projectId"), owner)
    if project:
        validate_project_assignment(
            ctx,
            project,
            assigned_agent_id=filters.get("assignedAgentId"),
            assigned_team_id=filters.get("assignedTeamId"),
        )


def _ensure_filter_targets_exist(ctx: Any, filters: dict[str, Any], at: str) -> None:
    lookups = (
        ("projectId", ctx.project_store.get_project),
        ("assignedAgentId", ctx.agent_store.get_agent),
        ("assignedTeamId", ctx.team_store.get_team),
    )
    for key, lookup in lookups:
        if key not in filters:
            continue
        try:
            found = lookup(filters[key])
        except KeyError:
            found = None
        if not found:
            raise TaskRequestError(400, f"{at} filters.{key} does not exist.")
