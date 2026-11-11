"""Project MCP operations reuse existing application rules, never HTTP self-calls."""

from typing import Any
from ..core.computer_identity import computer_id
from ..projects.manager import ManagerError, ensure_manager_thread
from ..projects.manager_reads import read_manager_tool
from ..projects.manager_proposals import stage_proposal
from ..projects.runtime import project_work_error
from .access import assert_project_manage, scoped_project
from .errors import McpError


def list_projects(ctx: Any, grant: dict[str, Any]) -> dict[str, Any]:
    if grant.get("computerId") and not grant.get("commandId"):
        return {"projects": []}
    projects = ctx.project_store.list_projects(grant["ownerUserId"], include_archived=True)
    return {
        "projects": [
            {k: p.get(k) for k in ("id", "name", "goal", "computerId", "managerAgentId", "archivedAt")}
            for p in projects
            if (grant.get("projectIds") is None or p["id"] in grant["projectIds"])
            and (not grant.get("computerId") or p["computerId"] == grant["computerId"])
            and (not grant.get("commandId") or any(
                m.get("agentId") == grant.get("agentId") and m.get("enabled", True)
                for m in p.get("members") or []))
        ]
    }


def invoke(ctx: Any, grant: dict[str, Any], project_id: str, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    project = scoped_project(ctx, grant, project_id)
    if not isinstance(tool, str) or not isinstance(arguments, dict):
        raise McpError(400, "Invalid MCP tool request.")
    if arguments.get("projectId", project_id) != project_id:
        raise McpError(403, "Project scope mismatch.")
    try:
        if tool == "workspace":
            if code := project_work_error(project):
                raise ManagerError(code)
            node = next((n for n in ctx.registry.monitor_nodes() if computer_id(n) == project["computerId"]), None)
            return {
                "workspace": {
                    "root": (node or {}).get("workspacePath"),
                    "subpath": project["workspaceSubpath"],
                    "linkedPath": project.get("workspaceHostPath"),
                }
            }
        if tool == "propose":
            assert_project_manage(grant, project)
            if code := project_work_error(project):
                raise ManagerError(code)
            if not project.get("managerAgentId"):
                raise ManagerError("manager_unconfigured")
            command: dict[str, Any]
            if grant.get("commandId"):
                active_command = ctx.daemon_store.get_command(grant["commandId"])
                if not active_command:
                    raise McpError(401, "This Relay run has ended.")
                command = {**active_command["command"], "mcpTokenId": grant["id"]}
            else:
                project, thread_id = ensure_manager_thread(ctx, project)
                command = {"sessionId": thread_id, "runId": None, "mcpTokenId": grant["id"]}
            return {"proposal": stage_proposal(ctx, project, command, arguments.get("operations"))}
        return read_manager_tool(ctx, project, tool, arguments)
    except ManagerError as error:
        raise McpError(error.status, error.code) from error
