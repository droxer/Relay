"""Who holds a Project's manager role, and the Project's manager conversation.

The holder is an ordinary roster member carrying the ``projectManager`` flag
(``core/project_roles.py``); nothing here gives that Agent another identity.
Only the owner picks it: creation takes an explicit choice, else the Project's
lead, and no read ever assigns one. The conversation is an ordinary Project
Thread the owner opens; reassigning the role never rewrites who owns it.
"""
from __future__ import annotations

from typing import Any
from ..core.computer_identity import computer_id
from ..core.project_roles import manager_roster
from ..persistence.events import relay_event
from ..agents.routing import AgentRoutingError, resolve_agent_assignments
from ..agents.location import agent_placed_on_computer
from ..persistence.resource_lock import resource_transaction
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
    # A roster that was empty has no lead; its only member must become it.
    return {"members": members, "leadAgentId": project.get("leadAgentId") or agent_id}


def initial_manager_id(ctx: Any, project: dict[str, Any], requested: Any = None) -> str | None:
    """The holder a new Project starts with: the owner's choice, else its lead."""
    ids = [agent["id"] for agent in manager_candidates(ctx, project)]
    if requested is not None:
        if not isinstance(requested, str) or requested not in ids:
            raise ManagerError("manager_agent_ineligible", 400)
        return requested
    lead = project.get("leadAgentId")
    return lead if lead in ids else None


def _manager_reason(ctx: Any, project: dict[str, Any], agent: dict[str, Any] | None, nodes: list[dict[str, Any]], tools: bool) -> str | None:
    reason = project_work_error(project) or (
        "manager_unconfigured" if not project.get("managerAgentId") else
        "manager_agent_unavailable" if not agent else
        "project_computer_offline" if not nodes else
        "project_manager_update_required" if not tools else None
    )
    if reason is not None:
        return reason
    try:
        resolve_agent_assignments([{"agentId": project["managerAgentId"], "mode": "action"}],
            user_id=project["ownerUserId"], is_admin=False, agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store, daemon_nodes=ctx.registry.monitor_nodes(),
            session_store=ctx.session_store,
        )
    except AgentRoutingError as error:
        return "manager_computer_busy" if error.code == "capacity_exhausted" else "manager_runtime_unavailable"
    return None


def manager_view(ctx: Any, project: dict[str, Any]) -> dict[str, Any]:
    """What the owner sees about the role. Reads only; never writes."""
    historical_ids: set[str] = set()
    thread_id = project.get("managerThreadId")
    if thread_id:
        try:
            header = ctx.session_store.get_session_header(thread_id)
            historical_ids = {run["logicalAgentId"] for run in header.get("agentRuns", []) if run.get("logicalAgentId")}
        except KeyError:
            thread_id = None  # Deleted; opening the conversation starts a new one.
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
    }, "proposals": [{k:v for k,v in p.items() if k not in ("result", "applicationInput")} for p in ctx.project_store.manager_proposals(project["id"])],
        "teams": [{"id": team["id"], "displayName": team.get("name") or team.get("displayName") or team["id"]}
                  for team in ctx.team_store.list_teams(project["ownerUserId"])
                  if team.get("computerId") == project["computerId"] and team.get("enabled", True)]}


def ensure_manager_thread(ctx: Any, project: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """The Project's manager conversation, started on first use.

    It is an ordinary Project Thread: no Agent owns it, and the current role
    holder is simply its first participant. Who answers a later message is the
    message's own address, as in any Project Thread.
    """
    with resource_transaction(ctx.project_store.engine, f"project-manager:{project['id']}"):
        project = ctx.project_store.get_project(project["id"])
        thread_id = project.get("managerThreadId")
        if thread_id:
            try:
                ctx.session_store.get_session_header(thread_id)
                return project, thread_id
            except KeyError:
                pass  # A deleted conversation is replaced below.
        if code := project_work_error(project):
            raise ManagerError(code)
        session = ctx.session_store.create_session({
            "workspacePath": "", "workspaceLayout": "project", "workspaceSubpath": project["workspaceSubpath"],
            "ownerUserId": project["ownerUserId"], "computerId": project["computerId"], "projectId": project["id"],
            "taskGoal": f"{project['name']} · Project Manager", "participants": ["human"],
        })
        agent_id = project.get("managerAgentId")
        if agent_id:
            ctx.session_store.append_event(session["id"], relay_event("thread.participants_joined", session["id"], {"agentIds": [agent_id], "actorUserId": project["ownerUserId"]}))
        project = ctx.project_store.mutate_manager(project["id"], lambda _latest: {"managerThreadId": session["id"]})
        return project, session["id"]
