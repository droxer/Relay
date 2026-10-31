from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from ...computer.access import PERSONAL_COMPUTER_READ_ONLY, admin_may_manage_computer
from ...computer.limits import assert_local_computer_allowed, local_computer_enrollment_scope
from ...computer.names import normalize_computer_display_name, present_computer
from ...computer.node_agents import (
    assert_node_agent_runs_drained,
    remove_node_agents,
    sync_node_agents,
)
from ...core.legacy_names import with_legacy_user_id
from ...core.managed_node_policy import managed_node_placeholder
from ...daemon_registry.records import public_sandbox_record
from ...security.request_auth import require_admin_session
from ...security.user_handles import user_record
from ..bodies import JsonBodyDep, string_field
from ..deps import AppContextDep
from .node_install import (
    assert_user_device_runtime,
    daemon_start_command,
    daemon_start_env,
    valid_user_workspace_path,
)

router = APIRouter()


def with_node_display_name(ctx: AppContextDep, node: dict[str, Any]) -> dict[str, Any]:
    return present_computer(ctx, node)


def assert_admin_may_manage(node: dict[str, Any]) -> None:
    if not admin_may_manage_computer(node):
        raise HTTPException(403, PERSONAL_COMPUTER_READ_ONLY)


def public_control_panel_node(ctx: AppContextDep, node: dict[str, Any]) -> dict[str, Any]:
    public_node = next(
        (item for item in ctx.registry.control_panel_nodes() if item["id"] == node["id"]),
        public_sandbox_record(node),
    )
    return with_node_display_name(ctx, public_node)


@router.put("/admin/daemon-nodes/{node_id}/assignment")
def assign_control_panel_daemon_node(
    node_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    user_id = string_field(body, "userId")
    if not user_id:
        raise HTTPException(400, "userId is required.")
    existing_node = ctx.registry.get(node_id)
    if not existing_node:
        raise HTTPException(404, "Daemon node not found.")
    if existing_node.get("userId"):
        raise HTTPException(409, "Daemon node is already assigned.")
    user = user_record(ctx.auth_store, user_id)
    if not user:
        raise HTTPException(404, "User not found.")
    try:
        assigned_node = ctx.registry.assign_user(node_id, user_id)
        sync_node_agents(ctx, assigned_node)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    public_node = public_control_panel_node(ctx, assigned_node)
    return {"user": user, "node": public_node}


@router.delete("/admin/daemon-nodes/{node_id}/assignment")
def unassign_control_panel_daemon_node(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    existing_node = ctx.registry.get(node_id)
    if not existing_node:
        raise HTTPException(404, "Daemon node not found.")
    assert_admin_may_manage(existing_node)
    if not existing_node.get("userId"):
        raise HTTPException(409, "Daemon node is not assigned.")
    try:
        updated = ctx.registry.unassign_user(node_id)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    for placement in ctx.agent_placement_store.list_placements(daemon_node_id=node_id):
        if placement.get("desiredState") != "removed":
            ctx.agent_placement_store.update_placement(placement["id"], {"desiredState": "removed"})
    public_node = public_control_panel_node(ctx, updated)
    return {"node": public_node}


@router.patch("/admin/daemon-nodes/{node_id}/disabled-agents")
def update_control_panel_daemon_node_disabled_agents(
    node_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    raw = body.get("disabledAgents")
    if not isinstance(raw, list) or not all(isinstance(name, str) for name in raw):
        raise HTTPException(400, "disabledAgents must be an array of agent names.")
    existing_node = ctx.registry.get(node_id)
    if not existing_node:
        raise HTTPException(404, "Daemon node not found.")
    assert_admin_may_manage(existing_node)
    try:
        updated = ctx.registry.set_disabled_agents(node_id, raw)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    public_node = public_control_panel_node(ctx, updated)
    return {"node": public_node}


@router.patch("/admin/daemon-nodes/{node_id}/agent-role-defaults")
def update_control_panel_daemon_node_agent_role_defaults(
    node_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    raw = body.get("agentRoleDefaults")
    if not isinstance(raw, dict):
        raise HTTPException(400, "agentRoleDefaults must be an object keyed by agent name.")
    existing_node = ctx.registry.get(node_id)
    if not existing_node:
        raise HTTPException(404, "Daemon node not found.")
    assert_admin_may_manage(existing_node)
    try:
        updated = ctx.registry.set_agent_role_defaults(node_id, raw)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    public_node = public_control_panel_node(ctx, updated)
    return {"node": public_node}


@router.delete("/admin/daemon-nodes/{node_id}", status_code=204)
def delete_control_panel_daemon_node(
    node_id: str, request: Request, ctx: AppContextDep
) -> Response:
    require_admin_session(request, ctx.auth_store)
    try:
        with ctx.registry.dispatch_lock:
            node = ctx.registry.get(node_id)
            if not node:
                raise KeyError(node_id)
            assert_admin_may_manage(node)
            if not node.get("retiredAt"):
                assert_node_agent_runs_drained(ctx, node_id)
            if node.get("managedNodeId"):
                ctx.managed_node_store.update_node(
                    node["managedNodeId"], {"desiredState": "deleted"}
                )
                ctx.registry.fence_managed_node(node_id)
            else:
                ctx.registry.retire_deleted(node_id)
            remove_node_agents(ctx, node_id)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return Response(status_code=204)


@router.get("/admin/daemon-nodes")
def control_panel_nodes(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    observed = []
    for node in ctx.registry.control_panel_nodes():
        if node.get("retiredAt"):
            continue
        managed_node = (
            ctx.managed_node_store.get_node(node["managedNodeId"])
            if node.get("managedNodeId")
            else None
        )
        if managed_node and managed_node.get("desiredState") == "deleted":
            continue
        observed.append(with_node_display_name(ctx, node))
    observed_managed_ids = {
        node["managedNodeId"] for node in observed if node.get("managedNodeId")
    }
    pending = [
        managed_node_placeholder(node)
        for node in ctx.managed_node_store.list_nodes()
        if node["id"] not in observed_managed_ids
    ]
    return {"nodes": [with_legacy_user_id(node) for node in [*observed, *pending]]}


@router.post("/admin/daemon-nodes", status_code=201)
def create_control_panel_daemon_node(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    user_id = string_field(body, "userId") or None
    sandbox_mode = string_field(body, "sandboxMode") or "boxlite"
    requested_location = string_field(body, "nodeLocation") or None
    if sandbox_mode not in ("boxlite", "none"):
        raise HTTPException(400, 'sandboxMode must be "boxlite" or "none".')
    workspace_path = string_field(body, "workspacePath") or None
    try:
        display_name = normalize_computer_display_name(body.get("displayName"))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if requested_location not in (None, "user-device"):
        raise HTTPException(400, 'nodeLocation must be "user-device".')
    if requested_location == "user-device" and not valid_user_workspace_path(workspace_path):
        raise HTTPException(
            400, "An absolute workspacePath on the user device is required."
        )
    assert_user_device_runtime(requested_location, sandbox_mode)
    if user_id:
        ctx.auth_store.ensure_user(user_id)
    provision_payload = {
        **({"userId": user_id} if user_id else {}),
        **({"displayName": display_name} if display_name else {}),
        "workspacePath": workspace_path,
        "sandboxMode": sandbox_mode,
        **({"nodeLocation": "user-device"} if requested_location else {}),
    }
    if requested_location == "user-device" and user_id:
        # Admin-provisioned hardware is unbounded; a personal computer is not,
        # and this route creates one just as self-enrollment does. Check and
        # provision share the (reentrant) lock so two concurrent creates cannot
        # both pass a limit with one slot left. Adopting a workspace the
        # user already enrolled is not a new computer, so it is exempt.
        with local_computer_enrollment_scope(ctx, user_id):
            if not ctx.registry.find_by_user(user_id, workspace_path):
                assert_local_computer_allowed(ctx, user_id)
            node = ctx.backend.provision_daemon_node(provision_payload)
    else:
        node = ctx.backend.provision_daemon_node(provision_payload)
    effective_sandbox_mode: str = (
        node["sandboxMode"] if node.get("sandboxMode") in ("boxlite", "none") else sandbox_mode
    )
    public_node = public_control_panel_node(ctx, node)
    response: dict[str, Any] = {
        "node": with_legacy_user_id(public_node),
        "daemonEnv": daemon_start_env(request, node, effective_sandbox_mode),
    }
    if node.get("sandboxToken"):
        response["sandboxToken"] = node["sandboxToken"]
    if node.get("nodeToken"):
        response["nodeToken"] = node["nodeToken"]
        response["daemonCommand"] = daemon_start_command(request, node, effective_sandbox_mode)
    return response
