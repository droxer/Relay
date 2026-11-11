"""MCP bearer authentication and resource permissions shared by all transports."""

from typing import Any
from ..core.computer_identity import computer_id
from ..core.project_roles import command_project_access
from ..persistence.account.mcp_tokens import DatabaseMcpTokenStore
from ..persistence.sql import names_no_uuid_row
from .errors import McpError


def token_store(ctx: Any) -> DatabaseMcpTokenStore:
    return DatabaseMcpTokenStore(ctx.project_store.engine)


def authorize(ctx: Any, token: str | None) -> dict[str, Any]:
    grant = token_store(ctx).authenticate(token)
    if not grant or not ctx.auth_store.list_users(user_ids=[grant["ownerUserId"]]):
        raise McpError(401, "Relay MCP token is invalid, revoked, or expired.")
    if grant.get("commandId"):
        command = ctx.daemon_store.get_command(grant["commandId"])
        active = (
            ctx.daemon_store.active_run_request_for_session_any_node(command["command"]["sessionId"])
            if command
            else None
        )
        if (
            not command
            or command["status"] != "dispatched"
            or not active
            or active.get("currentCommandId") != grant["commandId"]
            or active.get("status") != "running"
        ):
            raise McpError(401, "This Relay run has ended.")
        # A run token carries its Agent's Project access: the lead may manage
        # Project work, while other roster members only read it.
        scope = command_project_access(command["command"].get("state", {}), command["command"].get("logicalAgentId"))
        session = ctx.session_store.get_session_header(command["command"]["sessionId"])
        project_id = session.get("projectId")
        execution_scope = command["command"].get("workspaceScope")
        if execution_scope and (execution_scope.get("computerId") != grant.get("computerId")
                                or execution_scope.get("projectId") != project_id):
            raise McpError(403, "Execution workspace scope mismatch.")
        if scope and scope[0]["projectId"] != project_id:
            raise McpError(403, "Project workspace scope mismatch.")
        return {**grant, "workspaceProjectId": project_id, "projectIds": [project_id] if project_id else [],
                "access": scope[1] if scope else "read",
                "agentId": command["command"].get("logicalAgentId")}
    if grant.get("computerId") and not any(
        computer_id(node) == grant["computerId"]
        and node.get("userId") == grant["ownerUserId"]
        and not node.get("retiredAt")
        for node in ctx.registry.monitor_nodes()
    ):
        raise McpError(401, "This Computer is no longer connected to its owner.")
    # A local CLI credential identifies its owner/Computer, never a Project
    # Agent. Only a command-bound identity can exercise the lead's authority.
    return {**grant, "access": "read"}


def may_manage(grant: dict[str, Any]) -> bool:
    return grant.get("access") == "manage"


def assert_project_manage(grant: dict[str, Any], project: dict[str, Any]) -> None:
    agent_id = grant.get("agentId")
    if not (grant.get("commandId") and may_manage(grant) and agent_id
            and project.get("leadAgentId") == agent_id
            and any(m.get("agentId") == agent_id and m.get("enabled", True)
                    for m in project.get("members") or [])):
        raise McpError(403, "project_manager_required")


def assert_standalone(grant: dict[str, Any]) -> None:
    if grant.get("commandId") and grant.get("workspaceProjectId"):
        raise McpError(403, "Project runs cannot access standalone work.")
    if not grant.get("commandId") and grant.get("projectIds") is not None:
        raise McpError(403, "This token is limited to Projects.")


def scoped_project(ctx: Any, grant: dict[str, Any], project_id: str) -> dict[str, Any]:
    if names_no_uuid_row(ctx.project_store.engine, project_id):
        raise McpError(404, "project_not_found")
    if grant.get("computerId") and not grant.get("commandId"):
        raise McpError(403, "Project workspace scope required.")
    project = ctx.project_store.get_project(project_id)
    if not project:
        raise McpError(404, "project_not_found")
    if (
        project["ownerUserId"] != grant["ownerUserId"]
        or (grant.get("projectIds") is not None and project_id not in grant["projectIds"])
        or (grant.get("computerId") and project["computerId"] != grant["computerId"])
    ):
        raise McpError(403, "This token does not grant access to this Project.")
    if grant.get("commandId") and not any(
        m.get("agentId") == grant.get("agentId") and m.get("enabled", True)
        for m in project.get("members") or []
    ):
        raise McpError(403, "Project roster membership required.")
    return project
