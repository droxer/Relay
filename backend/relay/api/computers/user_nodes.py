from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from ...computer.names import (
    present_computer,
    rename_computer_for_actor,
)
from ...computer.node_agents import (
    assert_node_agent_runs_drained,
    remove_node_agents,
)
from ...core.daemon_capabilities import DAEMON_CAPABILITY_RUNTIME_REFRESH, has_capability
from ...core.ids import new_database_id
from ...core.managed_node_policy import managed_node_placeholder
from ...daemon_registry.records import public_sandbox_record
from ..actors import (
    actor_can_access_sandbox,
    authorized_sandbox_for_token,
    bearer_token,
    request_actor,
    request_actor_or_none,
)
from ..bodies import JsonBodyDep
from ..deps import AppContextDep

router = APIRouter()


@router.get("/daemon-nodes")
def list_daemon_nodes(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    deleted_managed_node_ids = {
        node["id"]
        for node in ctx.managed_node_store.list_nodes(include_deleted=True)
        if node.get("desiredState") == "deleted"
    }

    def visible_computers(
        nodes: list[dict[str, Any]], managed_nodes: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        observed = [
            node
            for node in nodes
            if node.get("managedNodeId") not in deleted_managed_node_ids
            and not node.get("retiredAt")
        ]
        observed_managed_ids = {
            node["managedNodeId"] for node in observed if node.get("managedNodeId")
        }
        pending = [
            managed_node_placeholder(node)
            for node in managed_nodes
            if node["id"] not in observed_managed_ids
        ]
        presented = [present_computer(ctx, node) for node in observed]
        return [*presented, *pending]

    token = bearer_token(request)
    if token:
        nodes = ctx.registry.monitor_nodes_for_token(token)
        if nodes is not None:
            managed_ids = {
                node["managedNodeId"] for node in nodes if node.get("managedNodeId")
            }
            managed_nodes = [
                node
                for node in ctx.managed_node_store.list_nodes()
                if node["id"] in managed_ids
            ]
            return {"nodes": visible_computers(nodes, managed_nodes)}
    actor = request_actor_or_none(request, ctx.auth_store)
    if actor:
        nodes = [
            node
            for node in ctx.registry.monitor_nodes()
            if actor_can_access_sandbox(actor, node)
        ]
        managed_nodes = [
            node
            for node in ctx.managed_node_store.list_nodes()
            if actor["isAdmin"] or node.get("userId") == actor["userId"]
        ]
        return {"nodes": visible_computers(nodes, managed_nodes)}
    raise HTTPException(401, "Authentication required.")


@router.patch("/daemon-nodes/{sandbox_id}")
def update_daemon_node(
    sandbox_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("account"):
        raise HTTPException(401, "Authentication required.")
    body = _request_body
    if set(body) != {"displayName"}:
        raise HTTPException(400, "Only displayName can be updated.")
    try:
        updated = rename_computer_for_actor(
            ctx, actor, sandbox_id, body.get("displayName")
        )
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except PermissionError as error:
        raise HTTPException(403, "Daemon node access denied.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    monitor_node = next(
        (node for node in ctx.registry.monitor_nodes() if node["id"] == sandbox_id),
        public_sandbox_record(updated),
    )
    return {"node": present_computer(ctx, monitor_node)}


@router.patch("/daemon-nodes/{sandbox_id}/disabled-agents")
def update_daemon_node_disabled_agents(
    sandbox_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    node = ctx.registry.get(sandbox_id)
    if not node:
        raise HTTPException(404, "Daemon node not found.")
    if not actor_can_access_sandbox(actor, node):
        raise HTTPException(403, "Daemon node access denied.")
    body = _request_body
    raw = body.get("disabledAgents")
    if not isinstance(raw, list) or not all(isinstance(name, str) for name in raw):
        raise HTTPException(400, "disabledAgents must be an array of agent names.")
    try:
        updated = ctx.registry.set_disabled_agents(sandbox_id, raw)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    monitor_node = next(
        (node for node in ctx.registry.monitor_nodes() if node["id"] == sandbox_id),
        public_sandbox_record(updated),
    )
    return {"node": present_computer(ctx, monitor_node)}


def _runtime_refresh_node(request: Request, ctx: AppContextDep, sandbox_id: str) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("account"):
        raise HTTPException(401, "Authentication required.")
    node = ctx.registry.get(sandbox_id)
    if not node or node.get("status") == "deleted":
        raise HTTPException(404, "Computer not found.")
    if not actor_can_access_sandbox(actor, node):
        raise HTTPException(403, "Daemon node access denied.")
    return node


@router.post("/daemon-nodes/{sandbox_id}/runtime-refresh", status_code=202)
def request_runtime_refresh(sandbox_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    node = _runtime_refresh_node(request, ctx, sandbox_id)
    if not has_capability(node, DAEMON_CAPABILITY_RUNTIME_REFRESH):
        raise HTTPException(409, "Update Relay Computer to refresh runtimes.")
    if not ctx.registry.is_live(sandbox_id):
        raise HTTPException(409, "Connect this computer before refreshing runtimes.")
    command_id = new_database_id()
    try:
        ctx.registry.enqueue(sandbox_id, {"id": command_id, "type": "runtime.refresh"})
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {"commandId": command_id}


@router.get("/daemon-nodes/{sandbox_id}/runtime-refresh/{command_id}")
def runtime_refresh_status(sandbox_id: str, command_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    _runtime_refresh_node(request, ctx, sandbox_id)
    command = ctx.daemon_store.get_command(command_id)
    if not command or command["nodeId"] != sandbox_id or command["command"]["type"] != "runtime.refresh":
        raise HTTPException(404, "Refresh request not found.")
    return {"status": command["status"]}


@router.delete("/daemon-nodes/{sandbox_id}", status_code=204)
def disconnect_daemon_node(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> Response:
    """Self-service removal of a computer, scoped by the same ownership seam.

    The counterpart to enrollment: a user who can connect a machine must
    be able to take it off the roster, or a mistyped workspace leaves a row
    only an admin can clear.
    """
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("account"):
        raise HTTPException(401, "Authentication required.")
    try:
        with ctx.registry.dispatch_lock:
            node = ctx.registry.get(sandbox_id)
            if not node:
                raise KeyError(sandbox_id)
            if not actor_can_access_sandbox(actor, node):
                raise HTTPException(403, "Daemon node access denied.")
            # Supervisor-provisioned hardware is torn down through the managed
            # node lifecycle, not by the user sitting in front of it.
            if node.get("managedNodeId"):
                raise HTTPException(
                    403, "This computer is managed by an admin and cannot be removed here."
                )
            assert_node_agent_runs_drained(ctx, sandbox_id)
            ctx.registry.retire_deleted(sandbox_id)
            remove_node_agents(ctx, sandbox_id)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return Response(status_code=204)


@router.patch("/daemon-nodes/{sandbox_id}/agent-role-overrides")
def update_daemon_node_agent_role_overrides(
    sandbox_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    sandbox = ctx.registry.get(sandbox_id)
    if not sandbox:
        raise HTTPException(404, "Daemon node not found.")
    token = bearer_token(request)
    authorized_sandbox = authorized_sandbox_for_token(ctx.registry, token)
    actor = (
        None if authorized_sandbox else request_actor_or_none(request, ctx.auth_store)
    )
    if authorized_sandbox:
        if authorized_sandbox["id"] != sandbox_id:
            raise HTTPException(403, "Daemon node access denied.")
    elif actor:
        if not actor_can_access_sandbox(actor, sandbox):
            raise HTTPException(403, "Daemon node access denied.")
    else:
        raise HTTPException(401, "Authentication required.")
    body = _request_body
    raw = body.get("agentRoleOverrides")
    if not isinstance(raw, dict):
        raise HTTPException(
            400, "agentRoleOverrides must be an object keyed by agent name."
        )
    try:
        updated = ctx.registry.set_agent_role_overrides(sandbox_id, raw)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {
        "node": next(
            (node for node in ctx.registry.monitor_nodes() if node["id"] == sandbox_id),
            public_sandbox_record(updated),
        )
    }
