"""Project Lead management and ordinary Project conversations.

Legacy manager API names remain compatible; assigning through them changes the
Project Lead. The lead keeps its Agent identity and execution role.
"""
from __future__ import annotations

from typing import Any
from ..core.computer_identity import computer_id
from ..core.project_roles import manager_roster
from ..persistence.events import relay_event
from ..agents.routing import AgentRoutingError, resolve_agent_assignments
from ..agents.location import agent_placed_on_computer
from .runtime import project_work_error

PROJECT_MEMBER_MAX_COUNT = 32


class ManagerError(ValueError):
    def __init__(self, code: str, status: int = 409):
        self.code, self.status = code, status
        super().__init__(code)


def manager_candidates(ctx: Any, project: dict[str, Any]) -> list[dict[str, Any]]:
    disabled = {m["agentId"] for m in project.get("members", []) if not m.get("enabled", True)}
    node_ids = {n["id"] for n in ctx.registry.monitor_nodes() if computer_id(n) == project["computerId"]}
    return sorted([
        agent for agent in ctx.agent_store.list_agents(supervisor_user_id=project["ownerUserId"])
        if not agent.get("deletedAt") and agent.get("enabled", True)
        and agent["id"] not in disabled
        and agent_placed_on_computer(agent["id"], project["computerId"], node_ids=node_ids, placement_store=ctx.agent_placement_store)
    ], key=lambda agent: (agent.get("createdAt", ""), agent["id"]))


def manager_role_patch(ctx: Any, project: dict[str, Any], agent_id: str) -> dict[str, Any]:
    """The roster update that hands the role to ``agent_id``; roles stay put."""
    defaults = {a["id"]: a.get("defaultRole") or "planner" for a in ctx.agent_store.list_agents(supervisor_user_id=project["ownerUserId"])}
    members = manager_roster(project.get("members", []), agent_id, defaults)
    if len(members) > PROJECT_MEMBER_MAX_COUNT:
        raise ManagerError("project_members_too_many", 400)
    return {"members": members, "leadAgentId": agent_id}


def initial_manager_id(ctx: Any, project: dict[str, Any], requested: Any = None) -> str | None:
    """The holder a new Project starts with: the owner's choice, else its lead."""
    ids = [agent["id"] for agent in manager_candidates(ctx, project)]
    if requested is not None:
        if not isinstance(requested, str) or requested not in ids:
            raise ManagerError("manager_agent_ineligible", 400)
        return requested
    lead = project.get("leadAgentId")
    return lead if lead in ids else None


def _manager_reason(
    ctx: Any,
    project: dict[str, Any],
    agent: dict[str, Any] | None,
    nodes: list[dict[str, Any]],
    tools: bool,
) -> str | None:
    if reason := project_work_error(project):
        return reason
    if not project.get("managerAgentId"):
        return "manager_unconfigured"
    if not agent:
        return "manager_agent_unavailable"
    if not nodes:
        return "project_computer_offline"
    if not tools:
        return "project_manager_update_required"
    try:
        resolve_agent_assignments(
            [{"agentId": project["managerAgentId"], "mode": "action"}],
            user_id=project["ownerUserId"],
            is_admin=False,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
            daemon_nodes=ctx.registry.monitor_nodes(),
            session_store=ctx.session_store,
        )
    except AgentRoutingError as error:
        return "manager_computer_busy" if error.code == "capacity_exhausted" else "manager_runtime_unavailable"
    return None


def visible_manager_proposals(ctx: Any, project_id: str, *, thread_id: str | None = None) -> list[dict[str, Any]]:
    return [
        {key: value for key, value in proposal.items() if key not in ("result", "applicationInput")}
        for proposal in ctx.project_store.manager_proposals(project_id, thread_id=thread_id)
    ]


def manager_view(ctx: Any, project: dict[str, Any]) -> dict[str, Any]:
    """What the owner sees about the role. Reads only; never writes."""
    historical_ids: set[str] = set()
    thread_id = project.get("managerThreadId")
    if thread_id:
        try:
            header = ctx.session_store.get_session_header(thread_id)
            historical_ids = {run["logicalAgentId"] for run in header.get("agentRuns", []) if run.get("logicalAgentId")}
        except KeyError:
            thread_id = None
    candidates = manager_candidates(ctx, project)
    names = {a["id"]: a["displayName"] for a in candidates}
    for agent_id in historical_ids - names.keys():
        previous = ctx.agent_store.get_agent(agent_id)
        if previous and previous.get("supervisorUserId") == project["ownerUserId"]:
            names[agent_id] = previous["displayName"]
    agent = next((a for a in candidates if a["id"] == project.get("managerAgentId")), None)
    nodes = [n for n in ctx.registry.monitor_nodes() if n.get("online") and computer_id(n) == project["computerId"]]
    tools = any("project-manager-mcp" in (n.get("capabilities") or []) for n in nodes)
    return {"project": {**project, "managerThreadId": thread_id}, "manager": {
        "agentId": project.get("managerAgentId"), "threadId": thread_id,
        "agentName": (agent or {}).get("displayName"), "agentNames": names, "toolsAvailable": tools,
        "reason": _manager_reason(ctx, project, agent, nodes, tools),
        "candidates": [{"id": a["id"], "displayName": a["displayName"]} for a in candidates],
    }, "proposals": visible_manager_proposals(ctx, project["id"]),
        "teams": [{"id": team["id"], "displayName": team.get("name") or team.get("displayName") or team["id"]}
                  for team in ctx.team_store.list_teams(project["ownerUserId"])
                  if team.get("projectId", project["id"]) == project["id"] and team.get("computerId") == project["computerId"] and team.get("enabled", True)]}


def create_manager_conversation(ctx: Any, project_id: str) -> dict[str, str]:
    """Start a Project Conversation addressed to the Lead role by default."""
    with ctx.project_store.manager_transaction(project_id) as project:
        if code := project_work_error(project):
            raise ManagerError(code)
        agent_id = project.get("managerAgentId")
        if not agent_id:
            raise ManagerError("manager_unconfigured")
        session = ctx.session_store.create_session({
            "workspacePath": "", "workspaceLayout": "project", "workspaceSubpath": project["workspaceSubpath"],
            "ownerUserId": project["ownerUserId"], "computerId": project["computerId"], "projectId": project["id"],
            "projectLeadDiscussion": True,
            "title": f"{project['name']} · Project Lead", "taskGoal": "", "participants": ["human"],
        })
        ctx.session_store.append_event(session["id"], relay_event("thread.participants_joined", session["id"], {
            "agentIds": [agent_id], "actorUserId": project["ownerUserId"],
        }))
        return {"threadId": session["id"], "agentId": agent_id}
