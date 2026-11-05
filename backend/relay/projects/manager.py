"""The Project's durable manager binding and canonical conversation."""
from __future__ import annotations

from typing import Any
from ..core.computer_identity import computer_id
from ..persistence.resource_lock import resource_transaction
from .runtime import agent_on_project_computer, project_work_error


class ManagerError(ValueError):
    def __init__(self, code: str, status: int = 409):
        self.code, self.status = code, status
        super().__init__(code)


def manager_candidates(ctx: Any, project: dict[str, Any]) -> list[dict[str, Any]]:
    disabled = {m["agentId"] for m in project.get("members", []) if not m.get("enabled", True)}
    return sorted([
        agent for agent in ctx.agent_store.list_agents(supervisor_user_id=project["ownerUserId"])
        if not agent.get("deletedAt") and agent.get("enabled", True)
        and agent["id"] not in disabled
        and agent_on_project_computer(project, agent["id"], ctx.agent_placement_store)
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


def manager_view(ctx: Any, project: dict[str, Any]) -> dict[str, Any]:
    project = initialize_manager(ctx, project)
    candidates = manager_candidates(ctx, project)
    agent = next((a for a in candidates if a["id"] == project.get("managerAgentId")), None)
    nodes = [n for n in ctx.registry.monitor_nodes() if n.get("online") and computer_id(n) == project["computerId"]]
    tools = any("project-manager" in (n.get("capabilities") or []) for n in nodes)
    reason = project_work_error(project) or (
        "manager_unconfigured" if not project.get("managerAgentId") else
        "manager_agent_unavailable" if not agent else
        "project_computer_offline" if not nodes else
        "project_manager_update_required" if not tools else None
    )
    return {"project": project, "manager": {
        "agentId": project.get("managerAgentId"), "threadId": project.get("managerThreadId"),
        "agentName": (agent or {}).get("displayName"), "toolsAvailable": tools,
        "reason": reason, "candidates": [{"id": a["id"], "displayName": a["displayName"]} for a in candidates],
    }, "proposals": ctx.project_store.manager_proposals(project["id"])}


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
