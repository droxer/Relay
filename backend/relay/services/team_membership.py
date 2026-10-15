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
