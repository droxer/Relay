"""Run-bound MCP tools. Provider credentials never leave the control plane."""

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from ...core.connections import ConnectionError
from ...core.ids import now_iso
from ..actors import bearer_token
from ..bodies import JsonBodyDep
from ..deps import AppContext, AppContextDep
from .routes import connection_errors, service

router = APIRouter()


def _active_command(ctx: AppContext, node_id: str, command_id: str, lease_id: str) -> dict[str, Any]:
    record = ctx.daemon_store.get_command(command_id)
    node = ctx.daemon_store.get_node(node_id)
    if not (record and node and not node.get("retiredAt") and node.get("status") != "deleted"
            and record.get("nodeId") == node_id and record.get("status") == "dispatched"
            and record.get("leaseId") == lease_id and record.get("leaseExpiresAt", "") > now_iso()
            and (record.get("command") or {}).get("type") == "run.start"):
        raise HTTPException(409, "connection_run_unavailable")
    return record["command"]


@router.post("/daemon-nodes/{node_id}/commands/{command_id}/connections")
def issue_access(node_id: str, command_id: str, request: Request, ctx: AppContextDep, *, body: JsonBodyDep) -> dict[str, Any]:
    try:
        ctx.registry.assert_node_event_authorized(node_id, bearer_token(request))
    except (PermissionError, KeyError) as error:
        raise HTTPException(401, "Unauthorized daemon node.") from error
    lease_id = body.get("leaseId")
    if not isinstance(lease_id, str):
        raise HTTPException(400, "connection_lease_required")
    command = _active_command(ctx, node_id, command_id, lease_id)
    session = ctx.session_store.get_session(command["sessionId"])
    owner = session.get("ownerUserId")
    if not owner or not command.get("connections"):
        raise HTTPException(409, "connection_run_unavailable")
    with connection_errors():
        credential = service(ctx).issue_run_token({"owner": owner, "nodeId": node_id, "commandId": command_id,
            "leaseId": lease_id, "runId": command["runId"]})
    return {"token": credential}


@router.post("/connection-tools")
def tools(request: Request, ctx: AppContextDep, *, body: JsonBodyDep) -> Response:
    try:
        claims = service(ctx).read_run_token(bearer_token(request) or "")
    except ConnectionError as error:
        raise HTTPException(401, "connection_run_credential_invalid") from error
    command = _active_command(ctx, claims["nodeId"], claims["commandId"], claims["leaseId"])
    if command["runId"] != claims["runId"]:
        raise HTTPException(409, "connection_run_unavailable")
    method, request_id = body.get("method"), body.get("id")
    snapshot = command.get("connections") or []
    if request_id is None:
        return Response(status_code=202)
    if method == "initialize":
        params = body.get("params") or {}
        if not isinstance(params, dict):
            raise HTTPException(400, "connection_arguments_invalid")
        result: dict[str, Any] = {"protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}}, "serverInfo": {"name": "relay-connections", "version": "1.0.0"}}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [{"name": "connection_call", "description":
            "Use an authenticated service within this run's explicitly granted access. Available grants: " + json.dumps(snapshot),
            "inputSchema": {"type": "object", "properties": {
                "connectionId": {"type": "string"}, "action": {"type": "string"},
                "resource": {"type": "string"}, "arguments": {"type": "object"}},
                "required": ["connectionId", "action", "resource", "arguments"], "additionalProperties": False}}]}
    elif method == "tools/call":
        params = body.get("params")
        args = params.get("arguments") if isinstance(params, dict) else None
        try:
            if (not isinstance(params, dict) or params.get("name") != "connection_call" or not isinstance(args, dict)
                    or not all(isinstance(args.get(key), str) for key in ("connectionId", "action", "resource"))):
                raise ConnectionError("connection_arguments_invalid")
            if service(ctx).tool_limiter.consume(claims["owner"]) is not None:
                raise ConnectionError("connection_rate_limited", 429)
            output = service(ctx).call(claims["owner"], snapshot, args["connectionId"], args["action"],
                args["resource"], args.get("arguments"))
            result = {"content": [{"type": "text", "text": json.dumps(output)}]}
        except ConnectionError as error:
            result = {"isError": True, "content": [{"type": "text", "text": error.code}]}
    else:
        return _response({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}})
    return _response({"jsonrpc": "2.0", "id": request_id, "result": result})


def _response(value: dict[str, Any]) -> Response:
    return Response(json.dumps(value), media_type="application/json", headers={"Cache-Control": "private, no-store"})
