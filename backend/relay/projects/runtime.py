from __future__ import annotations

from typing import Any
from ..core.project_predefined_workflows import selected_agent_ids
from ..core.project_roles import PROJECT_MANAGER_RESPONSIBILITIES, project_member_ids

from ..collaboration.styles import LEAD_LED, pipeline_order, resolve_collaboration_style
from ..collaboration.templates import SOLO_BRIEF, StyleTurn, compile_style
from ..core.computer_identity import computer_id
from ..core.role_charters import COORDINATOR_CHARTER, role_charter
from ..core.workflow_selection import predefined_style, workflow_id_for_style
from ..agents.location import agent_placed_on_computer
from ..agents.routing import resolve_agent_assignments
from ..teams.dispatch import TeamDispatchError, team_agents, team_assignment_phase, team_member_assignments
from ..core.workspace_capabilities import required_workspace_capabilities
from ..core.daemon_capabilities import has_capability


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


def project_listed_agent_ids(project: dict[str, Any]) -> set[str]:
    """Every agent the roster names, enabled or not."""
    return {member["agentId"] for member in project.get("members", [])}


def agent_on_project_computer(
    project: dict[str, Any], agent_id: str, placement_store: Any
) -> bool:
    """True when the agent lives on the project's computer.

    Used by project conversations and setup drafting, which may address
    Agents before they join the project roster.
    """
    return any(
        placement.get("desiredState") != "removed"
        and placement.get("computerId") == project.get("computerId")
        for placement in placement_store.list_placements(agent_id=agent_id)
    )


def project_computer_assignment_error(
    project: dict[str, Any],
    *,
    agent_id: str | None,
    team: dict[str, Any] | None,
    placement_store: Any,
) -> str | None:
    """Computer admission for project conversations and setup drafting.

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


def project_task_assignment_error(
    project: dict[str, Any], *, agent_id: str | None, team: dict[str, Any] | None,
) -> str | None:
    """Tasks and Automations may run only enabled Project Agents."""
    if team and team.get("projectId") and team["projectId"] != project["id"]:
        return "team_workflow_project_mismatch"
    members = project_member_ids(project)
    if agent_id and agent_id not in members:
        return "project_agent_not_member"
    if team and any(
        member_id not in members for member_id in team.get("memberAgentIds") or []
    ):
        return "project_team_not_member"
    return None


def project_workflow_members(
    project: dict[str, Any], *, style: str, agent_store: Any, placement_store: Any,
    daemon_nodes: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Resolve the enabled Project Agents available to the Workflow."""
    project_computer_id = project["computerId"]
    node_ids = {node["id"] for node in daemon_nodes if computer_id(node) == project_computer_id}
    selected = selected_agent_ids(project, style)
    eligible = set(selected) if selected is not None else None
    if eligible is not None and style == LEAD_LED and project.get("leadAgentId"):
        eligible.add(project["leadAgentId"])
    members = {}
    for member in project.get("members", []):
        if not member.get("enabled", True):
            continue
        agent_id = member["agentId"]
        if eligible is not None and agent_id not in eligible:
            continue
        agent = agent_store.get_agent(agent_id)
        if (
            not agent or agent.get("deletedAt") or not agent.get("enabled", True)
            or agent.get("supervisorUserId") != project["ownerUserId"]
            or not agent_placed_on_computer(
                agent_id, project_computer_id, node_ids=node_ids, placement_store=placement_store,
            )
        ):
            continue
        role = member.get("role") or agent.get("defaultRole") or "implementer"
        members[agent_id] = {**member, "id": agent_id, "defaultRole": role, "role": role}
    if not members:
        raise ProjectDispatchError("project_roster_invalid", permanent=True)
    if style == LEAD_LED and project.get("leadAgentId") not in members:
        raise ProjectDispatchError("project_lead_required", permanent=True)
    return members


def project_styled_assignments(
    project: dict[str, Any], *, style: str, agent_store: Any, placement_store: Any,
    daemon_nodes: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    members = project_workflow_members(
        project, style=style, agent_store=agent_store, placement_store=placement_store,
        daemon_nodes=daemon_nodes,
    )
    agents = list(members.values())
    lead_id = project.get("leadAgentId")
    snapshot = {
        **project_runtime_snapshot(project),
        "workflowId": workflow_id_for_style(style),
        "workflowKind": "predefined",
    }
    if style == LEAD_LED:
        assert isinstance(lead_id, str)
        lead = members[lead_id]
        specialists = pipeline_order([agent for agent in agents if agent["id"] != lead_id])
        turns = [
            StyleTurn(
                lead, lead["role"], "action", not specialists,
                COORDINATOR_CHARTER if specialists else SOLO_BRIEF,
            ),
            *(StyleTurn(agent, agent["role"], "action", False, role_charter(agent["role"]))
              for agent in specialists),
        ]
        if specialists:
            turns.append(StyleTurn(
                lead, lead["role"], "action", True,
                "Review the required contributions against the goal and synthesize one final result.",
            ))
    else:
        compiled = compile_style(style, agents, lead_id, role_brief=role_charter)
        style = compiled.style
        turns = list(compiled.turns)
        if compiled.fallback_from:
            snapshot["styleFallbackFrom"] = compiled.fallback_from
    snapshot["collaborationStyle"] = style
    snapshot["participantAgentIds"] = list(dict.fromkeys(turn.agent["id"] for turn in turns))
    if len(turns) > 1:
        snapshot["workContractVersion"] = 1
    assignments = []
    for index, turn in enumerate(turns):
        coordinator = style == LEAD_LED and index == 0
        agent_id = turn.agent["id"]
        assignments.append({
            "agentId": agent_id,
            "role": turn.role,
            "mode": turn.mode,
            "phase": team_assignment_phase(turn.role, turn.mode, coordinator),
            "coordinator": coordinator,
            "synthesizer": turn.synthesizer,
            "required": True,
            "brief": " ".join([turn.brief, *_member_details(turn.agent, lead=agent_id == lead_id)]),
            "projectSnapshot": snapshot,
        })
    return assignments, snapshot


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
    if task.get("assignedTeamId"):
        # Project Tasks and Automations never assign a Team directly. A saved
        # team assignment predates this scope rule and must be reassigned
        # before it can run, without enqueueing any daemon command.
        raise ProjectDispatchError("project_team_assignment_forbidden", permanent=True)
    # Only an unassigned task falls back to the project's full roster.
    workflow_id = task.get("assignedWorkflowId")
    names_runner = task.get("assignedAgentId") or workflow_id
    if not names_runner and project.get("leadAgentId") not in project_member_ids(project):
        raise ProjectDispatchError("project_roster_invalid", permanent=True)
    style = predefined_style(workflow_id) if workflow_id else None
    if style:
        if task.get("assignedAgentId"):
            raise ProjectDispatchError("workflow_agent_conflict", permanent=True)
        assignments, snapshot = project_styled_assignments(
            project, style=style, agent_store=agent_store, placement_store=placement_store,
            daemon_nodes=daemon_nodes,
        )
    else:
        snapshot = project_runtime_snapshot(project)
        assignments = _project_task_assignments(
            task, project, snapshot, agent_store=agent_store, team_store=team_store
        )
    node = project_runtime_node(project, daemon_nodes)
    if node is None:
        raise ProjectDispatchError("project_computer_offline")
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

    Recheck roster membership at dispatch, including old saved assignments.
    Placement resolution also pins every Agent to the project's Computer.
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
        if code := project_task_assignment_error(project, agent_id=None, team=team):
            raise ProjectDispatchError(code, permanent=True)
        return [
            {**assignment, "projectSnapshot": snapshot}
            for assignment in team_member_assignments(
                agents, team=team, style=resolve_collaboration_style(team, task, None)
            )
        ]
    assigned_agent_id = task.get("assignedAgentId")
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
                has_capability(node, capability)
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
            "brief": _member_brief(member, lead=member["agentId"] == project["leadAgentId"]),
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
    project's computer may be addressed by name to contribute to the conversation.
    A bare message goes to the crew, or, in a project without
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
            if not project_computer_assignment_error(
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
        code = project_computer_assignment_error(
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


def _member_brief(member: dict[str, Any], *, lead: bool) -> str:
    return " ".join([role_charter(member.get("role")), *_member_details(member, lead=lead)])


def _member_details(member: dict[str, Any], *, lead: bool) -> list[str]:
    parts = [
        *([f"Project lead: {PROJECT_MANAGER_RESPONSIBILITIES}"] if lead else []),
    ]
    if member.get("responsibilities") and member["responsibilities"] != role_charter(member.get("role")):
        parts.append(f"Responsibilities: {member['responsibilities']}.")
    if member.get("instructions"):
        parts.append(f"Project instructions: {member['instructions']}")
    return parts
