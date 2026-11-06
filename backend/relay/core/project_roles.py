"""Project responsibilities, distinct from an Agent's global execution role."""
from typing import Any
from .models import AGENT_ROLES

PROJECT_MANAGER_ROLE = "project_manager"
PROJECT_ROLES = (*AGENT_ROLES, PROJECT_MANAGER_ROLE)
PROJECT_MANAGER_RESPONSIBILITIES = (
    "Keep the Project understandable: explain its goal, progress, backlog and next actions; "
    "read current records, coordinate its Agents, and propose Task changes for the owner."
)


def project_manager_id(members: list[dict[str, Any]]) -> str | None:
    return next((m["agentId"] for m in members if m.get("role") == PROJECT_MANAGER_ROLE), None)


def manager_roster(members: list[dict[str, Any]], agent_id: str, fallback_roles: dict[str, str]) -> list[dict[str, Any]]:
    result = []
    found = False
    for member in members:
        if member["agentId"] == agent_id:
            found = True
            result.append({**member, "role": PROJECT_MANAGER_ROLE, "enabled": True, "responsibilities": member.get("responsibilities") or PROJECT_MANAGER_RESPONSIBILITIES})
        elif member.get("role") == PROJECT_MANAGER_ROLE:
            result.append({**member, "role": fallback_roles.get(member["agentId"], "planner")})
        else:
            result.append(dict(member))
    if not found:
        result.append({"agentId": agent_id, "role": PROJECT_MANAGER_ROLE, "enabled": True, "responsibilities": PROJECT_MANAGER_RESPONSIBILITIES})
    return result
