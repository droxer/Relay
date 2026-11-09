"""MCP credential issuance/renewal; authority stays in the control plane."""

from typing import Any
from datetime import datetime, timedelta, UTC
from ..core.computer_identity import computer_id
from ..core.project_roles import command_project_access
from ..daemon_registry.records import DeletedDaemonNodeError
from ..persistence.engine import store_transaction
from ..persistence.db_time import parse_db_time
from .access import token_store, scoped_project
from .errors import McpError


def issue_owner_token(ctx: Any, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
    ids, name = body.get("projectIds"), body.get("name", "Relay MCP")
    if (
        not isinstance(name, str)
        or not name.strip()
        or len(name) > 100
        or (ids is not None and (not isinstance(ids, list) or not 1 <= len(ids) <= 100
                                or any(not isinstance(key, str) for key in ids)))
    ):
        raise McpError(400, "A name and optionally 1–100 owned Project IDs are required.")
    for project_id in ids or []:
        scoped_project(ctx, {"ownerUserId": user_id}, project_id)
    return token_store(ctx).issue(user_id, name.strip(), project_ids=list(dict.fromkeys(ids)) if ids else None)


def computer_token(ctx: Any, sandbox_id: str, node_token: str | None, body: dict[str, Any]) -> dict[str, Any]:
    try:
        ctx.registry.assert_node_authenticated(sandbox_id, node_token)
    except DeletedDaemonNodeError as error:
        raise McpError(410, "Computer deleted.") from error
    except (PermissionError, KeyError) as error:
        raise McpError(401, "Unauthorized Computer.") from error
    node = next((n for n in ctx.registry.monitor_nodes() if n["id"] == sandbox_id), None)
    if not node or not node.get("userId"):
        raise McpError(403, "MCP requires an owned Computer.")
    existing = body.get("existingToken")
    if existing is not None:
        if not isinstance(existing, str) or body.get("commandId") is not None:
            raise McpError(400, "Invalid MCP renewal request.")
        store = token_store(ctx)
        with store_transaction(store.engine):
            prior = store.credential_status(existing)
            if (
                not prior
                or prior["ownerUserId"] != node["userId"]
                or prior["computerId"] != computer_id(node)
                or prior.get("commandId")
                or prior.get("projectIds") is not None
            ):
                raise McpError(403, "mcp_token_unknown")
            if prior.get("revokedAt"):
                raise McpError(403, "mcp_token_revoked")
            expiry = parse_db_time(prior["expiresAt"])
            if expiry is not None and expiry > datetime.now(UTC) + timedelta(days=7):
                return {**{k: v for k, v in prior.items() if k != "commandId"}, "renewed": False}
            store.revoke(node["userId"], prior["id"])
            return {**store.issue(node["userId"], "Local Computer MCP", computer_id=computer_id(node)), "renewed": True}
    ids = None
    command_id = body.get("commandId")
    if command_id is not None:
        if not isinstance(command_id, str):
            raise McpError(400, "Invalid command ID.")
        command = ctx.daemon_store.get_command(command_id)
        if (
            not command
            or command["nodeId"] != sandbox_id
            or command["status"] != "dispatched"
            or command.get("leaseId") != body.get("leaseId")
        ):
            raise McpError(409, "Run lease is no longer active.")
        active = ctx.daemon_store.active_run_request_for_session_any_node(command["command"]["sessionId"])
        if not active or active.get("currentCommandId") != command_id or active.get("status") != "running":
            raise McpError(409, "Run lease is no longer active.")
        session = ctx.session_store.get_session_header(command["command"]["sessionId"])
        if session.get("ownerUserId") != node["userId"]:
            raise McpError(403, "Run owner mismatch.")
        access = command_project_access(command["command"].get("state", {}), command["command"].get("logicalAgentId"))
        ids = []  # Every run can manage standalone work; no Project access by default.
        if access:
            scope = access[0]
            project = ctx.project_store.get_project(scope["projectId"])
            if not project or project["ownerUserId"] != node["userId"] or project["computerId"] != computer_id(node):
                raise McpError(403, "Project scope mismatch.")
            ids = [project["id"]]
    return token_store(ctx).issue(
        node["userId"],
        "Relay run" if command_id else "Local Computer MCP",
        computer_id=computer_id(node),
        project_ids=ids,
        command_id=command_id,
    )
