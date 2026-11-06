"""MCP bearer authentication and Project scope shared by all transports."""

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
        # A run token carries its Agent's Project access: the manager may
        # stage Task changes, every other roster member only reads.
        scope = command_project_access(command["command"].get("state", {}), command["command"].get("logicalAgentId"))
        return {**grant, "access": scope[1] if scope else "read"}
    if grant.get("computerId") and not any(
        computer_id(node) == grant["computerId"]
        and node.get("userId") == grant["ownerUserId"]
        and not node.get("retiredAt")
        for node in ctx.registry.monitor_nodes()
    ):
        raise McpError(401, "This Computer is no longer connected to its owner.")
    return {**grant, "access": "manage"}


def may_manage(grant: dict[str, Any]) -> bool:
    return grant.get("access") == "manage"


def scoped_project(ctx: Any, grant: dict[str, Any], project_id: str) -> dict[str, Any]:
    if names_no_uuid_row(ctx.project_store.engine, project_id):
        raise McpError(404, "project_not_found")
    project = ctx.project_store.get_project(project_id)
    if not project:
        raise McpError(404, "project_not_found")
    if (
        project["ownerUserId"] != grant["ownerUserId"]
        or (grant.get("projectIds") is not None and project_id not in grant["projectIds"])
        or (grant.get("computerId") and project["computerId"] != grant["computerId"])
    ):
        raise McpError(403, "This token does not grant access to this Project.")
    return project
