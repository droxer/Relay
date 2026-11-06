"""The Project Manager: a responsibility a roster member holds beside its role.

A member's ``role`` stays one of the execution roles every Agent can take
(``AGENT_ROLES``). Managing the Project is a separate ``projectManager`` flag,
held by at most one member, so taking or handing over the responsibility never
changes what the Agent does in the Project's rounds. The roster is the only
source: a Project's ``managerAgentId`` is derived from it on read.
"""
from typing import Any

# Earlier releases stored the responsibility as a member role. It is still
# accepted on the wire and upgraded wherever a roster is read.
LEGACY_PROJECT_MANAGER_ROLE = "project_manager"
LEGACY_MANAGER_FALLBACK_ROLE = "planner"
PROJECT_MANAGER_RESPONSIBILITIES = (
    "Keep the Project understandable: explain its goal, progress, backlog and next actions; "
    "read current records, coordinate its Agents, and propose Task changes for the owner."
)
# Fields that earlier releases stored on the Project beside the roster.
RETIRED_MANAGER_FIELDS = ("managerInitialized",)


def upgrade_member(member: dict[str, Any]) -> dict[str, Any]:
    """Map the legacy ``project_manager`` role onto the flag and a real role."""
    if member.get("role") != LEGACY_PROJECT_MANAGER_ROLE:
        return member
    return {**member, "role": LEGACY_MANAGER_FALLBACK_ROLE, "projectManager": True}


def upgrade_members(members: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [upgrade_member(member) for member in members]


def is_project_manager(member: dict[str, Any]) -> bool:
    return member.get("projectManager") is True or member.get("role") == LEGACY_PROJECT_MANAGER_ROLE


def project_manager_id(members: list[dict[str, Any]]) -> str | None:
    return next((m["agentId"] for m in members if is_project_manager(m)), None)


def project_with_manager(project: dict[str, Any]) -> dict[str, Any]:
    """A stored Project as clients see it: upgraded roster, derived holder."""
    members = upgrade_members(project.get("members") or [])
    current = {k: v for k, v in project.items() if k not in RETIRED_MANAGER_FIELDS}
    return {**current, "members": members, "managerAgentId": project_manager_id(members)}


def manager_roster(members: list[dict[str, Any]], agent_id: str | None, default_roles: dict[str, str]) -> list[dict[str, Any]]:
    """Give the responsibility to ``agent_id`` (or nobody) without touching roles.

    An Agent outside the roster joins it with its own default role, because the
    owner chose it; nobody else is added.
    """
    result = []
    found = False
    for member in upgrade_members(members):
        rest = {k: v for k, v in member.items() if k != "projectManager"}
        if member["agentId"] == agent_id:
            found = True
            result.append({**rest, "projectManager": True, "enabled": True})
        else:
            result.append(rest)
    if agent_id and not found:
        result.append({
            "agentId": agent_id, "role": default_roles.get(agent_id, LEGACY_MANAGER_FALLBACK_ROLE),
            "enabled": True, "projectManager": True, "responsibilities": PROJECT_MANAGER_RESPONSIBILITIES,
        })
    return result


def manager_run_context(project: dict[str, Any], agent_id: str | None) -> dict[str, Any] | None:
    """Resolve capability from the enabled Project role, independently of a Thread."""
    holder = project_manager_id([m for m in project.get("members", []) if m.get("enabled", True)])
    if not holder or agent_id != holder:
        return None
    return {"projectId": project["id"], "agentId": holder, "bindingRevision": project["version"]}
