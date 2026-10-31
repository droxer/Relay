from __future__ import annotations

from typing import Any


def remove_agent_from_teams(
    team_store: Any, agent_id: str, owner_user_id: str
) -> list[dict[str, Any]]:
    updated: list[dict[str, Any]] = []
    for team in team_store.list_teams(
        owner_user_id=owner_user_id
    ):
        if agent_id in team.get("memberAgentIds", []):
            updated.append(team_store.remove_member(team["id"], agent_id))
    return updated


def reconcile_team_memberships(
    team_store: Any, agent_store: Any
) -> list[dict[str, Any]]:
    """Remove historical Team members whose agent no longer exists."""
    updated: list[dict[str, Any]] = []
    try:
        teams = team_store.list_teams()
    except Exception as error:
        if "no such table" in str(error) or "does not exist" in str(error):
            return updated
        raise
    for team in teams:
        stale_members = [
            agent_id
            for agent_id in team.get("memberAgentIds", [])
            if not (agent := agent_store.get_agent(agent_id))
            or agent.get("deletedAt")
        ]
        current = team
        for agent_id in stale_members:
            current = team_store.remove_member(team["id"], agent_id)
        if stale_members:
            updated.append(current)
    return updated


def with_member_roles(
    agent_store: Any, members: list[str], configs: dict[str, Any]
) -> dict[str, Any]:
    """Every member's config with a team role, a missing one taken from the
    agent's own role. The team role is the team's from then on: changing the
    agent's role later does not rewrite a team it already belongs to."""
    result = dict(configs)
    for agent_id in members:
        config = result.get(agent_id)
        if isinstance(config, dict) and config.get("role"):
            continue
        agent = agent_store.get_agent(agent_id)
        role = agent.get("defaultRole") if agent else None
        if not role:
            continue
        base = config if isinstance(config, dict) else {}
        result[agent_id] = {**base, "role": role}
    return result
