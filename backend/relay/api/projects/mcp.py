"""Compatibility JSON/token routes adapt HTTP to the Python MCP application."""

from collections.abc import Callable
from typing import Any
from fastapi import APIRouter, HTTPException, Request, Response
from ...mcp.access import authorize, token_store
from ...mcp.credentials import computer_token, issue_owner_token
from ...mcp.errors import McpError
from ...mcp.operations import invoke, list_projects
from ..actors import request_actor, bearer_token
from ..bodies import JsonBodyDep
from ..deps import AppContextDep

router = APIRouter()


def _result(operation: Callable[..., dict[str, Any]], *args: Any) -> dict[str, Any]:
    try:
        return operation(*args)
    except McpError as error:
        raise HTTPException(error.status, error.code) from error


@router.post("/mcp/tokens", status_code=201)
def issue_token(
    request: Request, response: Response, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    owner = request_actor(request, ctx.auth_store)["userId"]
    response.headers["Cache-Control"] = "no-store"
    return _result(issue_owner_token, ctx, owner, _request_body)


@router.get("/mcp/tokens")
def list_tokens(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return {"tokens": token_store(ctx).list_tokens(request_actor(request, ctx.auth_store)["userId"])}


@router.delete("/mcp/tokens/{token_id}")
def revoke_token(token_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    if not token_store(ctx).revoke(request_actor(request, ctx.auth_store)["userId"], token_id):
        raise HTTPException(404, "MCP token not found.")
    return {"revoked": True}


@router.post("/daemon-nodes/{sandbox_id}/mcp-token", status_code=201)
def computer_mcp_token(
    sandbox_id: str, request: Request, response: Response, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return _result(computer_token, ctx, sandbox_id, bearer_token(request), _request_body)


@router.get("/mcp/projects")
def mcp_projects(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return _result(list_projects, ctx, _result(authorize, ctx, bearer_token(request)))


@router.post("/mcp/projects/{project_id}/tools")
def mcp_tool(project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    grant = _result(authorize, ctx, bearer_token(request))
    return _result(invoke, ctx, grant, project_id, _request_body.get("tool"), _request_body.get("arguments", {}))
