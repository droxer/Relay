from __future__ import annotations

from typing import Any

from ..core.computer_identity import computer_id
from .agent_routing import resolve_agent_assignments


class ProjectDispatchError(ValueError):
    def __init__(self, code: str, *, permanent: bool = False):
        self.code = code
        self.permanent = permanent
        super().__init__(code)


def project_work_error(project: dict[str, Any] | None) -> str | None:
    """Shared admission policy; history and already admitted results stay writable."""
    if not project or project.get("archivedAt"):
        return "project_not_found"
    if not project.get("enabled", True):
        return "project_disabled"
    return None


def resolve_project_task_assignments(
    task: dict[str, Any],
    *,
    project_store: Any,
    agent_store: Any,
    placement_store: Any,
    daemon_nodes: list[dict[str, Any]],
    session_store: Any | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    project = project_store.get_project(task.get("projectId"))
    if code := project_work_error(project):
        raise ProjectDispatchError(code, permanent=code == "project_not_found")
    owner = task.get("ownerEmployeeId") or task.get("assigneeEmployeeId")
    if project.get("ownerEmployeeId") != owner:
        raise ProjectDispatchError("project_forbidden", permanent=True)
    members = [
        member for member in project.get("members", []) if member.get("enabled", True)
    ]
    member_ids = [member.get("agentId") for member in members]
    lead_agent_id = project.get("leadAgentId")
    if not members or lead_agent_id not in member_ids:
        raise ProjectDispatchError("project_roster_invalid", permanent=True)
    node = project_runtime_node(project, daemon_nodes)
    if node is None:
        raise ProjectDispatchError("project_computer_offline")
    snapshot = project_runtime_snapshot(project)
    assigned_agent_id = task.get("assignedAgentId")
    assignments = project_member_assignments(
        project,
        selected_agent_ids=[assigned_agent_id] if assigned_agent_id else None,
        snapshot=snapshot,
    )
    return (
        resolve_agent_assignments(
            assignments,
            employee_id=project["ownerEmployeeId"],
            is_admin=False,
            agent_store=agent_store,
            placement_store=placement_store,
            daemon_nodes=daemon_nodes,
            required_node_id=node["id"],
            session_store=session_store,
        ),
        snapshot,
    )


def project_runtime_node(
    project: dict[str, Any], daemon_nodes: list[dict[str, Any]]
) -> dict[str, Any] | None:
    return min(
        (
            node
            for node in daemon_nodes
            if not node.get("retiredAt")
            and computer_id(node) == project["computerId"]
            and node.get("online")
            and not node.get("stale")
            and node.get("status") in ("ready", "busy", "running")
            and "project-workspaces" in (node.get("capabilities") or [])
        ),
        key=lambda item: item["id"],
        default=None,
    )


def project_member_assignments(
    project: dict[str, Any],
    *,
    mode: str = "action",
    selected_agent_ids: list[str] | None = None,
    snapshot: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    enabled = [
        member for member in project.get("members", []) if member.get("enabled", True)
    ]
    by_id = {member["agentId"]: member for member in enabled}
    selected = selected_agent_ids or list(by_id)
    if any(agent_id not in by_id for agent_id in selected):
        raise ProjectDispatchError("project_agent_not_member", permanent=True)
    members = [by_id[agent_id] for agent_id in selected]
    if selected_agent_ids is None:
        members = _ordered_members(members, project["leadAgentId"])
    project_snapshot = snapshot or project_runtime_snapshot(project)
    return [
        {
            "agentId": member["agentId"],
            "role": member["role"],
            "mode": mode,
            "phase": "discussion" if mode == "ask" else _phase(member["role"]),
            "coordinator": member["agentId"] == project["leadAgentId"],
            "brief": _member_brief(member),
            "projectSnapshot": project_snapshot,
        }
        for member in members
    ]


def project_runtime_snapshot(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "projectId": project["id"],
        "projectRevision": project["version"],
        "computerId": project["computerId"],
        "workspaceSubpath": project["workspaceSubpath"],
        "leadAgentId": project["leadAgentId"],
        "members": [dict(member) for member in project.get("members", [])],
    }


def _ordered_members(
    members: list[dict[str, Any]], lead_agent_id: str
) -> list[dict[str, Any]]:
    lead = [member for member in members if member["agentId"] == lead_agent_id]
    rest = [member for member in members if member["agentId"] != lead_agent_id]
    return [*lead, *rest]


def _phase(role: str) -> str:
    return "review" if role == "reviewer" else "execution"


def _member_brief(member: dict[str, Any]) -> str:
    parts = [
        f"Project function: {member['functionTitle']}.",
        f"Responsibilities: {member['responsibilities']}.",
    ]
    if member.get("instructions"):
        parts.append(f"Project instructions: {member['instructions']}")
    return " ".join(parts)
