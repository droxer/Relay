"""Relay API for MCP clients using scoped bearer tokens."""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, HTTPException, Request, Response
from ...core.computer_identity import computer_id
from ...persistence.account.mcp_tokens import DatabaseMcpTokenStore
from ...persistence.sql import names_no_uuid_row
from ...projects.manager import ManagerError, ensure_manager_thread, initialize_manager
from ...projects.manager_reads import read_manager_tool
from ...projects.manager_proposals import stage_proposal
from ...projects.runtime import project_work_error
from ...daemon_registry.records import DeletedDaemonNodeError
from ..actors import request_actor, bearer_token
from ..bodies import JsonBodyDep
from ..deps import AppContextDep

router = APIRouter()


def _store(ctx: AppContextDep) -> DatabaseMcpTokenStore:
    return DatabaseMcpTokenStore(ctx.project_store.engine)


def _grant(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    grant = _store(ctx).authenticate(bearer_token(request))
    if not grant or not ctx.auth_store.list_users(user_ids=[grant["ownerUserId"]]):
        raise HTTPException(401, "Relay MCP token is invalid, revoked, or expired.")
    if grant.get("commandId"):
        command = ctx.daemon_store.get_command(grant["commandId"])
        active = ctx.daemon_store.active_run_request_for_session_any_node(command["command"]["sessionId"]) if command else None
        if not command or command["status"] != "dispatched" or not active or active.get("currentCommandId") != grant["commandId"] or active.get("status") != "running":
            raise HTTPException(401, "This Relay run has ended.")
    elif grant.get("computerId") and not any(
        computer_id(node) == grant["computerId"] and node.get("userId") == grant["ownerUserId"] and not node.get("retiredAt")
        for node in ctx.registry.monitor_nodes()
    ):
        raise HTTPException(401, "This Computer is no longer connected to its owner.")
    return grant


def _project(ctx: AppContextDep, grant: dict[str, Any], project_id: str) -> dict[str, Any]:
    if names_no_uuid_row(ctx.project_store.engine, project_id):
        raise HTTPException(404, "project_not_found")
    project = ctx.project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "project_not_found")
    if project["ownerUserId"] != grant["ownerUserId"] or (
        grant.get("projectIds") is not None and project_id not in grant["projectIds"]
    ) or (grant.get("computerId") and project["computerId"] != grant["computerId"]):
        raise HTTPException(403, "This token does not grant access to this Project.")
    return project


@router.post("/mcp/tokens", status_code=201)
def issue_token(request: Request, response: Response, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    ids = _request_body.get("projectIds")
    name = _request_body.get("name", "Relay MCP")
    if not isinstance(name, str) or not name.strip() or len(name) > 100 or not isinstance(ids, list) or not 1 <= len(ids) <= 100 or any(not isinstance(key, str) for key in ids):
        raise HTTPException(400, "A name and 1–100 owned Project IDs are required.")
    for project_id in ids:
        _project(ctx, {"ownerUserId": actor["userId"]}, project_id)
    response.headers["Cache-Control"] = "no-store"
    return _store(ctx).issue(actor["userId"], name.strip(), project_ids=list(dict.fromkeys(ids)))


@router.get("/mcp/tokens")
def list_tokens(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return {"tokens": _store(ctx).list_tokens(request_actor(request, ctx.auth_store)["userId"])}


@router.delete("/mcp/tokens/{token_id}")
def revoke_token(token_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    if not _store(ctx).revoke(request_actor(request, ctx.auth_store)["userId"], token_id):
        raise HTTPException(404, "MCP token not found.")
    return {"revoked": True}


@router.post("/daemon-nodes/{sandbox_id}/mcp-token", status_code=201)
def computer_mcp_token(sandbox_id: str, request: Request, response: Response, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    try:
        ctx.registry.assert_node_authenticated(sandbox_id, bearer_token(request))
    except DeletedDaemonNodeError as error:
        raise HTTPException(410, "Computer deleted.") from error
    except (PermissionError, KeyError) as error:
        raise HTTPException(401, "Unauthorized Computer.") from error
    node = next((n for n in ctx.registry.monitor_nodes() if n["id"] == sandbox_id), None)
    if not node or not node.get("userId"):
        raise HTTPException(403, "MCP requires an owned Computer.")
    ids = None
    command_id = _request_body.get("commandId")
    if command_id is not None:
        if not isinstance(command_id, str):
            raise HTTPException(400, "Invalid command ID.")
        command = ctx.daemon_store.get_command(command_id)
        if not command or command["nodeId"] != sandbox_id or command["status"] != "dispatched" or command.get("leaseId") != _request_body.get("leaseId"):
            raise HTTPException(409, "Run lease is no longer active.")
        scope = command["command"].get("state", {}).get("project_manager")
        if not scope:
            raise HTTPException(403, "Project Manager role required.")
        project = ctx.project_store.get_project(scope["projectId"])
        if not project or project["ownerUserId"] != node["userId"] or project["computerId"] != computer_id(node):
            raise HTTPException(403, "Project scope mismatch.")
        ids = [project["id"]]
    response.headers["Cache-Control"] = "no-store"
    return _store(ctx).issue(node["userId"], "Relay run" if command_id else "Local Computer MCP",
        computer_id=computer_id(node), project_ids=ids, command_id=command_id)


@router.get("/mcp/projects")
def mcp_projects(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    grant = _grant(request, ctx)
    projects = ctx.project_store.list_projects(grant["ownerUserId"], include_archived=True)
    return {"projects": [{k: p.get(k) for k in ("id", "name", "goal", "computerId", "managerAgentId", "archivedAt")}
                         for p in projects if (grant.get("projectIds") is None or p["id"] in grant["projectIds"])
                         and (not grant.get("computerId") or p["computerId"] == grant["computerId"])]}


@router.post("/mcp/projects/{project_id}/tools")
def mcp_tool(project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    grant = _grant(request, ctx)
    project = _project(ctx, grant, project_id)
    tool, arguments = _request_body.get("tool"), _request_body.get("arguments", {})
    if not isinstance(tool, str) or not isinstance(arguments, dict):
        raise HTTPException(400, "Invalid MCP tool request.")
    if arguments.get("projectId", project_id) != project_id:
        raise HTTPException(403, "Project scope mismatch.")
    try:
        if tool == "workspace":
            if code := project_work_error(project):
                raise ManagerError(code)
            node = next((n for n in ctx.registry.monitor_nodes() if computer_id(n) == project["computerId"]), None)
            return {"workspace": {"root": (node or {}).get("workspacePath"), "subpath": project["workspaceSubpath"], "linkedPath": project.get("workspaceHostPath")}}
        if tool == "propose":
            if code := project_work_error(project):
                raise ManagerError(code)
            project = initialize_manager(ctx, project)
            if not project.get("managerAgentId"):
                raise ManagerError("manager_unconfigured")
            project, thread_id = ensure_manager_thread(ctx, project)
            command = {"sessionId": thread_id, "runId": None, "mcpTokenId": grant["id"]}
            if grant.get("commandId"):
                active_command = ctx.daemon_store.get_command(grant["commandId"])
                if not active_command:
                    raise HTTPException(401, "This Relay run has ended.")
                command = {**active_command["command"], "mcpTokenId": grant["id"]}
            return {"proposal": stage_proposal(ctx, project, command, arguments.get("operations"))}
        return read_manager_tool(ctx, project, tool, arguments)
    except ManagerError as error:
        raise HTTPException(error.status, error.code) from error
