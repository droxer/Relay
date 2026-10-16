from __future__ import annotations

from typing import Any

from ..collaboration.styles import resolve_collaboration_style
from ..core.computer_identity import computer_id
from .agent_routing import resolve_agent_assignments
from .team_dispatch import TeamDispatchError, team_agents, team_member_assignments
from .workspace_capabilities import required_workspace_capabilities


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


def project_member_ids(project: dict[str, Any]) -> set[str]:
    return {
        member["agentId"]
        for member in project.get("members", [])
        if member.get("enabled", True)
    }


def project_listed_agent_ids(project: dict[str, Any]) -> set[str]:
    """Every agent the roster names, enabled or not."""
    return {member["agentId"] for member in project.get("members", [])}


def agent_on_project_computer(
    project: dict[str, Any], agent_id: str, placement_store: Any
) -> bool:
    """True when the agent lives on the project's computer.

    A project owns a computer, and every agent on that computer shares its
    workspace root, so a task in the project may be handed to any of them — the
    roster names who answers the project room, not who may ever touch it.
    """
    return any(
        placement.get("desiredState") != "removed"
        and placement.get("computerId") == project.get("computerId")
        for placement in placement_store.list_placements(agent_id=agent_id)
    )


def project_task_assignment_error(
    project: dict[str, Any],
    *,
    agent_id: str | None,
    team: dict[str, Any] | None,
    placement_store: Any,
) -> str | None:
    """The one admission rule for who a project task may be assigned to.

    A member the project disabled stays refused: that is a deliberate project
    decision, not an agent the roster simply never listed.
    """
    if agent_id and agent_id in project_listed_agent_ids(project):
        return None if agent_id in project_member_ids(project) else "project_agent_not_member"
    if agent_id and not agent_on_project_computer(project, agent_id, placement_store):
        return "project_agent_off_computer"
    if team and not all(
        agent_on_project_computer(project, member_id, placement_store)
        for member_id in team.get("memberAgentIds") or []
    ):
        return "project_team_off_computer"
    return None


def resolve_project_task_assignments(
    task: dict[str, Any],
    *,
    project_store: Any,
    agent_store: Any,
    placement_store: Any,
    daemon_nodes: list[dict[str, Any]],
    session_store: Any | None = None,
    team_store: Any | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    project = project_store.get_project(task.get("projectId"))
    if code := project_work_error(project):
        raise ProjectDispatchError(code, permanent=code == "project_not_found")
    owner = task.get("ownerUserId") or task.get("assigneeUserId")
    if project.get("ownerUserId") != owner:
        raise ProjectDispatchError("project_forbidden", permanent=True)
    members = [
        member for member in project.get("members", []) if member.get("enabled", True)
    ]
    member_ids = [member.get("agentId") for member in members]
    lead_agent_id = project.get("leadAgentId")
    # Only a task that names no one falls back to the roster; one assigned to an
    # agent or team on the project's computer runs even when the crew is empty.
    names_runner = task.get("assignedAgentId") or task.get("assignedTeamId")
    if not names_runner and (not members or lead_agent_id not in member_ids):
        raise ProjectDispatchError("project_roster_invalid", permanent=True)
    node = project_runtime_node(project, daemon_nodes)
    if node is None:
        raise ProjectDispatchError("project_computer_offline")
    snapshot = project_runtime_snapshot(project)
    assignments = _project_task_assignments(
        task, project, snapshot, agent_store=agent_store, team_store=team_store
    )
    return (
        resolve_agent_assignments(
            assignments,
            user_id=project["ownerUserId"],
            is_admin=False,
            agent_store=agent_store,
            placement_store=placement_store,
            daemon_nodes=daemon_nodes,
            required_node_id=node["id"],
            session_store=session_store,
        ),
        snapshot,
    )


def _project_task_assignments(
    task: dict[str, Any],
    project: dict[str, Any],
    snapshot: dict[str, Any],
    *,
    agent_store: Any,
    team_store: Any | None,
) -> list[dict[str, Any]]:
    """Who runs a project task: its team, its agent, or the project roster.

    A team or a non-member agent runs inside the project workspace exactly as a
    member would; `resolve_agent_assignments` pins every one of them to the
    project's node, so a placement that moved away fails the round instead of
    running it somewhere without the project's files.
    """
    team_id = task.get("assignedTeamId")
    if team_id:
        try:
            team, agents = team_agents(
                team_id,
                project["ownerUserId"],
                team_store=team_store,
                agent_store=agent_store,
            )
        except TeamDispatchError as error:
            raise ProjectDispatchError(error.code, permanent=error.permanent) from error
        return [
            {**assignment, "projectSnapshot": snapshot}
            for assignment in team_member_assignments(
                agents, team=team, style=resolve_collaboration_style(team, task, None)
            )
        ]
    assigned_agent_id = task.get("assignedAgentId")
    if assigned_agent_id and assigned_agent_id not in project_listed_agent_ids(project):
        return [
            _outside_agent_assignment(
                assigned_agent_id,
                mode="action",
                coordinator=True,
                brief="Complete this project task in the shared project workspace.",
                snapshot=snapshot,
                agent_store=agent_store,
            )
        ]
    return project_member_assignments(
        project,
        selected_agent_ids=[assigned_agent_id] if assigned_agent_id else None,
        snapshot=snapshot,
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
            and all(
                capability in (node.get("capabilities") or [])
                for capability in required_workspace_capabilities(
                    "project", project.get("workspaceSubpath")
                )
            )
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


def project_thread_assignments(
    project: dict[str, Any],
    *,
    mode: str,
    selected_agent_ids: list[str] | None,
    room_agent_ids: list[str],
    snapshot: dict[str, Any],
    agent_store: Any,
    placement_store: Any,
) -> list[dict[str, Any]]:
    """Who answers a message in a project thread.

    Crew members answer as the roster configures them. Any other agent on the
    project's computer may be addressed by name — the rule a project task's
    assignee already follows — so the agent that ran a task can be asked to
    continue it. A bare message goes to the crew, or, in a project without
    one, to the agents already in the thread.
    """
    member_ids = project_member_ids(project)
    selected = selected_agent_ids
    if selected is None and not member_ids:
        # Nobody named anyone, so an agent that has since left the computer
        # drops out of the room instead of failing the whole message.
        selected = [
            agent_id
            for agent_id in room_agent_ids
            if not project_task_assignment_error(
                project, agent_id=agent_id, team=None, placement_store=placement_store
            )
        ]
    if selected is None:
        return project_member_assignments(project, mode=mode, snapshot=snapshot)
    assignments: list[dict[str, Any]] = []
    for agent_id in selected:
        if agent_id in member_ids:
            assignments.extend(
                project_member_assignments(
                    project, mode=mode, selected_agent_ids=[agent_id], snapshot=snapshot
                )
            )
            continue
        code = project_task_assignment_error(
            project, agent_id=agent_id, team=None, placement_store=placement_store
        )
        if code:
            raise ProjectDispatchError(code, permanent=True)
        assignments.append(
            _outside_agent_assignment(
                agent_id,
                mode=mode,
                coordinator=False,
                brief="Work in the shared project workspace; you are not on its crew.",
                snapshot=snapshot,
                agent_store=agent_store,
            )
        )
    return assignments


def _outside_agent_assignment(
    agent_id: str,
    *,
    mode: str,
    coordinator: bool,
    brief: str,
    snapshot: dict[str, Any],
    agent_store: Any,
) -> dict[str, Any]:
    """An agent off the roster, working in the project workspace on its own role."""
    agent = agent_store.get_agent(agent_id) or {}
    role = agent.get("defaultRole") or "implementer"
    return {
        "agentId": agent_id,
        "role": role,
        "mode": mode,
        "phase": "discussion" if mode == "ask" else _phase(role),
        "coordinator": coordinator,
        "brief": brief,
        "projectSnapshot": snapshot,
    }


def project_runtime_snapshot(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "projectId": project["id"],
        "projectRevision": project["version"],
        "name": project.get("name") or "",
        "description": project.get("description") or "",
        "goal": project.get("goal") or "",
        "context": project.get("context") or "",
        "contextRevision": int(project.get("contextRevision") or 0),
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
    parts = [f"Responsibilities: {member['responsibilities']}."]
    if member.get("instructions"):
        parts.append(f"Project instructions: {member['instructions']}")
    return " ".join(parts)
