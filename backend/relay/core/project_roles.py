"""Project Lead management, with legacy manager wire fields for compatibility.

The Project's leadAgentId is authoritative. projectManager and managerAgentId
are derived aliases so existing daemons and clients keep the same tool contract.
Execution roles remain independent of project leadership.
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
    lead_id = project.get("leadAgentId")
    members = [
        {**{k: v for k, v in member.items() if k != "projectManager"},
         **({"projectManager": True} if member["agentId"] == lead_id else {})}
        for member in upgrade_members(project.get("members") or [])
    ]
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
    holder = project.get("leadAgentId")
    if not any(m["agentId"] == holder and m.get("enabled", True) for m in project.get("members", [])):
        return None
    if not holder or agent_id != holder:
        return None
    return {"projectId": project["id"], "agentId": holder, "bindingRevision": project["version"]}


def round_manager_context(project_snapshot: dict[str, Any] | None, assignments: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The manager context a round carries, from its pinned project snapshot.

    Any round in a Project that includes the role holder carries it: a thread
    message, a task run, an automation occurrence, or a continuation. The
    registry hands the tools to the holder's own assignment only.
    """
    if not project_snapshot:
        return None
    project = {"id": project_snapshot["projectId"], "version": project_snapshot["projectRevision"],
               "members": project_snapshot.get("members") or [], "leadAgentId": project_snapshot.get("leadAgentId")}
    return next((context for assignment in assignments
                 if (context := manager_run_context(project, assignment.get("agentId")))), None)


def project_reader_context(project_snapshot: dict[str, Any] | None, agent_id: str | None) -> dict[str, Any] | None:
    """Read-only Project access for an enabled roster member other than the holder.

    Every Agent working in the Project may read its Tasks and records through
    Relay MCP; only the holder's context (``round_manager_context``) can stage
    Task changes.
    """
    if not project_snapshot or not agent_id:
        return None
    members = [m for m in project_snapshot.get("members") or [] if m.get("enabled", True)]
    if not any(m.get("agentId") == agent_id for m in members) or project_snapshot.get("leadAgentId") == agent_id:
        return None
    return {"projectId": project_snapshot["projectId"], "agentId": agent_id,
            "bindingRevision": project_snapshot["projectRevision"]}


def command_project_access(state: dict[str, Any], logical_agent_id: str | None) -> tuple[dict[str, Any], str] | None:
    """The Project scope a run's state grants its own Agent, and whether it may manage."""
    for key, access in (("project_manager", "manage"), ("project_reader", "read")):
        scope = state.get(key)
        if scope and scope.get("agentId") == logical_agent_id:
            return scope, access
    return None
