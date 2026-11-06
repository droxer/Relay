"""The Project's durable manager binding and canonical conversation."""
from __future__ import annotations

from typing import Any
from ..core.computer_identity import computer_id
from ..agents.routing import AgentRoutingError, resolve_agent_assignments
from ..agents.location import agent_placed_on_computer
from ..persistence.resource_lock import resource_transaction
from .runtime import project_work_error


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


def initialize_manager(ctx: Any, project: dict[str, Any]) -> dict[str, Any]:
    if project.get("managerInitialized") or project.get("archivedAt"):
        return project
    candidates = manager_candidates(ctx, project)
    ids = [a["id"] for a in candidates]
    selected = project.get("leadAgentId") if project.get("leadAgentId") in ids else next(iter(ids), None)
    return ctx.project_store.mutate_manager(project["id"], lambda latest: None if latest.get("managerInitialized") else {
        "managerAgentId": selected, "managerInitialized": True,
    })


def initial_manager_id(ctx: Any, project: dict[str, Any], requested: Any = None) -> str | None:
    candidates = manager_candidates(ctx, project)
    ids = [agent["id"] for agent in candidates]
    if requested is not None:
        if not isinstance(requested, str) or requested not in ids:
            raise ManagerError("manager_agent_ineligible", 400)
        return requested
    return project.get("leadAgentId") if project.get("leadAgentId") in ids else next(iter(ids), None)


def manager_view(ctx: Any, project: dict[str, Any]) -> dict[str, Any]:
    project = initialize_manager(ctx, project)
    historical_ids: set[str] = set()
    if project.get("managerThreadId"):
        try:
            header = ctx.session_store.get_session_header(project["managerThreadId"])
            historical_ids = {run["logicalAgentId"] for run in header.get("agentRuns", []) if run.get("logicalAgentId")}
        except KeyError:
            if project.get("archivedAt"):
                project = {**project, "managerThreadId": None}
            else:
                project = ctx.project_store.mutate_manager(project["id"], lambda latest: {"managerThreadId": None} if latest.get("managerThreadId") == project["managerThreadId"] else None)
    candidates = manager_candidates(ctx, project)
    names = {a["id"]: a["displayName"] for a in candidates}
    for agent_id in historical_ids - names.keys():
        previous = ctx.agent_store.get_agent(agent_id)
        if previous and previous.get("supervisorUserId") == project["ownerUserId"]:
            names[agent_id] = previous["displayName"]
    agent = next((a for a in candidates if a["id"] == project.get("managerAgentId")), None)
    nodes = [n for n in ctx.registry.monitor_nodes() if n.get("online") and computer_id(n) == project["computerId"]]
    tools = any("project-manager" in (n.get("capabilities") or []) for n in nodes)
    reason = project_work_error(project) or (
        "manager_unconfigured" if not project.get("managerAgentId") else
        "manager_agent_unavailable" if not agent else
        "project_computer_offline" if not nodes else
        "project_manager_update_required" if not tools else None
    )
    if reason is None:
        try:
            resolve_agent_assignments([{"agentId": project["managerAgentId"], "mode": "action"}],
                user_id=project["ownerUserId"], is_admin=False, agent_store=ctx.agent_store,
                placement_store=ctx.agent_placement_store, daemon_nodes=ctx.registry.monitor_nodes(),
                session_store=ctx.session_store,
            )
        except AgentRoutingError as error:
            reason = "manager_computer_busy" if error.code == "capacity_exhausted" else "manager_runtime_unavailable"
    return {"project": project, "manager": {
        "agentId": project.get("managerAgentId"), "threadId": project.get("managerThreadId"),
        "agentName": (agent or {}).get("displayName"), "agentNames": names, "toolsAvailable": tools,
        "reason": reason, "candidates": [{"id": a["id"], "displayName": a["displayName"]} for a in candidates],
    }, "proposals": [{k:v for k,v in p.items() if k not in ("result", "applicationInput")} for p in ctx.project_store.manager_proposals(project["id"])],
        "teams": [{"id": team["id"], "displayName": team.get("name") or team.get("displayName") or team["id"]}
                  for team in ctx.team_store.list_teams(project["ownerUserId"])
                  if team.get("computerId") == project["computerId"] and team.get("enabled", True)]}


def ensure_manager_thread(ctx: Any, project: dict[str, Any]) -> tuple[dict[str, Any], str]:
    with resource_transaction(ctx.project_store.engine, f"project-manager:{project['id']}"):
        project = ctx.project_store.get_project(project["id"])
        if code := project_work_error(project):
            raise ManagerError(code)
        thread_id = project.get("managerThreadId")
        if thread_id:
            try:
                ctx.session_store.get_session_header(thread_id)
                return project, thread_id
            except KeyError:
                pass  # A deleted canonical Thread is replaced on the next message.
        session = ctx.session_store.create_session({
            "workspacePath": "", "workspaceLayout": "project", "workspaceSubpath": project["workspaceSubpath"],
            "ownerUserId": project["ownerUserId"], "ownerAgentId": project.get("managerAgentId"),
            "computerId": project["computerId"], "projectId": project["id"],
            "taskGoal": f"Relay · {project['name']}", "participants": ["human"],
        })
        project = ctx.project_store.mutate_manager(project["id"], lambda _latest: {"managerThreadId": session["id"]})
        return project, session["id"]
