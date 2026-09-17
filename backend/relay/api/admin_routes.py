from __future__ import annotations

import asyncio
import secrets
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from loguru import logger

from ..daemon_registry import public_sandbox_record
from ..persistence.org_settings_store import (
    OrgSettingsValidationError,
    normalize_max_local_computers,
    normalize_max_task_rounds,
    normalize_skill_import_hosts,
)
from ..security.auth import (
    get_admin_token,
    reissue_admin_token,
    require_admin_session,
    validate_password,
)
from ..services.computer_limits import (
    assert_local_computer_allowed,
    decorate_employee_limits,
)
from ..services.computer_names import normalize_computer_display_name, present_computer
from ..services.employee_lifecycle import (
    soft_delete_employee as soft_delete_employee_cascade,
)
from ..services.managed_nodes import managed_node_placeholder
from ..services.node_agents import (
    assert_node_agent_runs_drained,
    remove_node_agents,
    sync_node_agents,
)
from .deps import AppContextDep
from .helpers import (
    JsonBodyDep,
    assert_employee_device_runtime,
    daemon_start_command,
    daemon_start_env,
    employee_record,
    normalize_employee_handle,
    resolve_employee_id,
    string_field,
    valid_employee_workspace_path,
)

router = APIRouter()


@router.get("/admin/control-plane/metrics")
def control_plane_metrics(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    bridge = getattr(request.app.state, "notification_bridge", None)
    return {
        "notifications": ctx.control_plane_notifier.stats(),
        "notificationBridge": (
            bridge.stats()
            if bridge is not None
            else {"enabled": False, "connected": False}
        ),
    }


def _with_node_display_name(ctx: AppContextDep, node: dict[str, Any]) -> dict[str, Any]:
    return present_computer(ctx, node)


def _public_control_panel_node(ctx: AppContextDep, node: dict[str, Any]) -> dict[str, Any]:
    public_node = next(
        (item for item in ctx.registry.control_panel_nodes() if item["id"] == node["id"]),
        public_sandbox_record(node),
    )
    return _with_node_display_name(ctx, public_node)


@router.get("/admin/settings")
def get_org_settings(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return {
        "settings": ctx.org_settings_store.get_settings(),
        # Editing an employee — display name, email, or their own computer
        # limit — writes the employees table, which only the database auth
        # store has. Reported so the admin UI can leave those controls out
        # instead of offering an edit that would come back a 400.
        "capabilities": {
            "employeeEdits": hasattr(ctx.auth_store, "update_employee"),
        },
        # The bootstrap/supervisor bearer token, surfaced so an admin can copy
        # it from the console instead of digging through backend env files.
        # Seeded from RELAY_ADMIN_TOKEN on first boot, generated otherwise,
        # and reissuable via the route below.
        "adminToken": get_admin_token(),
    }


@router.post("/admin/admin-token/reissue")
def reissue_admin_token_route(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        token = reissue_admin_token()
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {"adminToken": token}


@router.put("/admin/settings")
def update_org_settings(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    if not {"maxLocalComputersPerEmployee", "maxTaskRounds", "skillImportAllowedHosts"}.intersection(body):
        raise HTTPException(
            400, "maxLocalComputersPerEmployee, maxTaskRounds or skillImportAllowedHosts is required."
        )
    try:
        settings = ctx.org_settings_store.update_settings(
            max_local_computers_per_employee=(
                normalize_max_local_computers(body["maxLocalComputersPerEmployee"])
                if "maxLocalComputersPerEmployee" in body
                else None
            ),
            max_task_rounds=(
                normalize_max_task_rounds(body["maxTaskRounds"])
                if "maxTaskRounds" in body
                else None
            ),
            skill_import_allowed_hosts=(
                normalize_skill_import_hosts(body["skillImportAllowedHosts"])
                if "skillImportAllowedHosts" in body else None
            ),
        )
    except OrgSettingsValidationError as error:
        raise HTTPException(400, str(error)) from error
    return {"settings": settings}


@router.get("/admin/users")
def list_users(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return {"users": ctx.auth_store.list_users()}


@router.post("/admin/users", status_code=201)
def create_user(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        user = ctx.auth_store.create_user(
            string_field(body, "username"),
            string_field(body, "password"),
            role=string_field(body, "role") or "user",
            email=string_field(body, "email") or None,
            employee_id=string_field(body, "employeeId") or None,
            display_name=string_field(body, "displayName") or None,
            department_id=string_field(body, "departmentId") or None,
            department_name=string_field(body, "departmentName") or None,
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"user": user}


@router.get("/admin/departments")
def list_departments(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if hasattr(ctx.auth_store, "list_departments"):
        return {"departments": ctx.auth_store.list_departments()}
    return {"departments": []}


@router.post("/admin/departments", status_code=201)
def create_department(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if not hasattr(ctx.auth_store, "ensure_department"):
        raise HTTPException(400, "Department storage is only available with database auth storage.")
    body = _request_body
    department_id = string_field(body, "id") or string_field(body, "departmentId")
    name = string_field(body, "name") or department_id
    if not department_id:
        raise HTTPException(400, "departmentId is required.")
    try:
        department = ctx.auth_store.ensure_department(
            department_id,
            name=name,
            parent_department_id=string_field(body, "parentDepartmentId") or None,
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"department": department}


@router.get("/admin/employees")
def list_employees(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if hasattr(ctx.auth_store, "list_employees"):
        return {
            "employees": decorate_employee_limits(ctx, ctx.auth_store.list_employees())
        }
    deleted_ids = ctx.auth_store.deleted_employee_ids() if hasattr(ctx.auth_store, "deleted_employee_ids") else set()
    employees = []
    seen = set()
    for user in ctx.auth_store.list_users():
        employee_id = user.get("employeeId")
        if not employee_id or employee_id in seen or employee_id in deleted_ids:
            continue
        seen.add(employee_id)
        employees.append({
            "id": employee_id,
            "displayName": user.get("displayName") or user.get("username") or employee_id,
            "email": user.get("email"),
            "createdAt": user.get("createdAt"),
            "updatedAt": user.get("createdAt"),
        })
    return {"employees": decorate_employee_limits(ctx, employees)}


@router.delete("/admin/employees/{employee_id}", status_code=200)
def soft_delete_employee(
    employee_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if not hasattr(ctx.auth_store, "soft_delete_employee"):
        raise HTTPException(400, "Employee soft-delete is not supported by this auth store.")
    try:
        return soft_delete_employee_cascade(ctx, employee_id)
    except KeyError as error:
        raise HTTPException(404, "Employee not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.patch("/admin/employees/{employee_id}")
def update_employee(
    employee_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if not hasattr(ctx.auth_store, "update_employee"):
        raise HTTPException(
            400, "Editing an employee requires the database auth store."
        )
    body = _request_body
    patch: dict[str, Any] = {}
    if "displayName" in body:
        patch["display_name"] = string_field(body, "displayName")
    if "email" in body:
        patch["email"] = string_field(body, "email")
    if "maxLocalComputers" in body:
        # An explicit null is the "inherit the org default" instruction, which
        # is a different edit from leaving the field alone.
        if body["maxLocalComputers"] is None:
            patch["clear_max_local_computers"] = True
        else:
            try:
                patch["max_local_computers"] = normalize_max_local_computers(
                    body["maxLocalComputers"]
                )
            except OrgSettingsValidationError as error:
                raise HTTPException(400, str(error)) from error
    try:
        employee = ctx.auth_store.update_employee(employee_id, **patch)
    except KeyError as error:
        raise HTTPException(404, "Employee not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"employee": decorate_employee_limits(ctx, [employee])[0]}


@router.post("/admin/employees", status_code=201)
def create_employee(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    employee_id = normalize_employee_handle(string_field(body, "employeeId"))
    username = string_field(body, "username")
    password = string_field(body, "password")
    node_id = string_field(body, "nodeId") or None
    email = string_field(body, "email") or None
    display_name = string_field(body, "displayName") or username or employee_id
    max_local_computers: int | None = None
    if body.get("maxLocalComputers") is not None:
        try:
            max_local_computers = normalize_max_local_computers(body["maxLocalComputers"])
        except OrgSettingsValidationError as error:
            raise HTTPException(400, str(error)) from error
    if not username:
        raise HTTPException(400, "username is required.")
    # Up front, so a rejected password is answered before anything else is
    # looked up or created. The account's own names go in: they are the first
    # guesses anyone makes, so a password built from them is refused.
    try:
        validate_password(
            password, identifiers=(username, employee_id, display_name, email)
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    # An employee id that already exists is a collision, not a second employee.
    # The stores' ensure_employee reuses a matching row and patches the profile
    # onto it, so without this check "Add employee" silently rewrote a live
    # colleague's display name, email, and computer limit and attached a second
    # login to them. Resolution goes through the store because the database
    # store maps handles onto UUIDs — comparing raw handles would never match.
    # Soft-deleted employees are deliberately not blocked: re-creating a removed
    # employee is an existing, intended path.
    if employee_record(ctx.auth_store, resolve_employee_id(ctx.auth_store, employee_id)):
        raise HTTPException(409, f"Employee @{employee_id} already exists.")
    # Node assignment is optional at onboarding — an employee may be created
    # first and bound to a sandbox later via the assign-node flow. Only validate
    # the node when one was supplied.
    if node_id:
        existing_node = ctx.registry.get(node_id)
        if not existing_node:
            raise HTTPException(404, "Daemon node not found.")
        if existing_node.get("employeeId"):
            raise HTTPException(409, "Daemon node is already assigned.")
    try:
        user = ctx.auth_store.create_user(
            username,
            password,
            role="user",
            email=email,
            employee_id=employee_id,
            display_name=display_name,
        )
    except ValueError as error:
        message = str(error)
        status = 409 if "already exists" in message else 400
        raise HTTPException(status, message) from error
    if hasattr(ctx.auth_store, "ensure_employee"):
        employee = ctx.auth_store.ensure_employee(
            user.get("employeeId") or employee_id,
            display_name=display_name,
            email=email,
            max_local_computers=max_local_computers,
        )
    else:
        # The file auth store keeps no employee row, so an override has nowhere
        # to live. Say so rather than accepting a limit that would be dropped.
        if max_local_computers is not None:
            raise HTTPException(
                400,
                "Per-employee computer limits require the database auth store.",
            )
        employee = {
            "id": employee_id,
            "handle": employee_id,
            "displayName": display_name,
            "email": email,
            "createdAt": user.get("createdAt"),
            "updatedAt": user.get("createdAt"),
        }
    employee = decorate_employee_limits(ctx, [employee])[0]
    public_node: dict[str, Any] | None = None
    assignment_error: str | None = None
    if node_id:
        # The employee is already committed by this point, so a computer that
        # got claimed in the meantime cannot be reported as a failed request:
        # raising here left a created employee behind an error message, and the
        # retry then failed on "username already exists" with no way forward.
        # The employee is the outcome; the unattached computer is a warning the
        # admin resolves from the assign flow.
        try:
            assigned_node = ctx.registry.assign_employee(node_id, employee["id"])
            sync_node_agents(ctx, assigned_node)
            public_node = _public_control_panel_node(ctx, assigned_node)
        except KeyError:
            assignment_error = "Computer not found."
        except ValueError as error:
            assignment_error = str(error)
        if assignment_error:
            logger.warning(
                "Employee created but computer assignment failed",
                employee_id=employee["id"],
                node_id=node_id,
                error=assignment_error,
            )
    return {
        "employee": employee,
        "user": user,
        **({"node": public_node} if public_node else {}),
        **({"assignmentError": assignment_error} if assignment_error else {}),
    }


@router.put("/admin/daemon-nodes/{node_id}/assignment")
def assign_control_panel_daemon_node(
    node_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    employee_id = string_field(body, "employeeId")
    if not employee_id:
        raise HTTPException(400, "employeeId is required.")
    existing_node = ctx.registry.get(node_id)
    if not existing_node:
        raise HTTPException(404, "Daemon node not found.")
    if existing_node.get("employeeId"):
        raise HTTPException(409, "Daemon node is already assigned.")
    employee = employee_record(ctx.auth_store, employee_id)
    if not employee:
        raise HTTPException(404, "Employee not found.")
    try:
        assigned_node = ctx.registry.assign_employee(node_id, employee_id)
        sync_node_agents(ctx, assigned_node)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    public_node = _public_control_panel_node(ctx, assigned_node)
    return {"employee": employee, "node": public_node}


@router.delete("/admin/daemon-nodes/{node_id}/assignment")
def unassign_control_panel_daemon_node(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    existing_node = ctx.registry.get(node_id)
    if not existing_node:
        raise HTTPException(404, "Daemon node not found.")
    if not existing_node.get("employeeId"):
        raise HTTPException(409, "Daemon node is not assigned.")
    try:
        updated = ctx.registry.unassign_employee(node_id)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    for placement in ctx.agent_placement_store.list_placements(daemon_node_id=node_id):
        if placement.get("desiredState") != "removed":
            ctx.agent_placement_store.update_placement(placement["id"], {"desiredState": "removed"})
    public_node = _public_control_panel_node(ctx, updated)
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
    if not ctx.registry.get(node_id):
        raise HTTPException(404, "Daemon node not found.")
    try:
        updated = ctx.registry.set_disabled_agents(node_id, raw)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    public_node = _public_control_panel_node(ctx, updated)
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
    if not ctx.registry.get(node_id):
        raise HTTPException(404, "Daemon node not found.")
    try:
        updated = ctx.registry.set_agent_role_defaults(node_id, raw)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    public_node = _public_control_panel_node(ctx, updated)
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
        observed.append(_with_node_display_name(ctx, node))
    observed_managed_ids = {
        node["managedNodeId"] for node in observed if node.get("managedNodeId")
    }
    pending = [
        managed_node_placeholder(node)
        for node in ctx.managed_node_store.list_nodes()
        if node["id"] not in observed_managed_ids
    ]
    return {"nodes": [*observed, *pending]}


@router.post("/admin/daemon-nodes", status_code=201)
def create_control_panel_daemon_node(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    employee_id = string_field(body, "employeeId") or None
    sandbox_mode = string_field(body, "sandboxMode") or "boxlite"
    requested_location = string_field(body, "nodeLocation") or None
    if sandbox_mode not in ("boxlite", "none"):
        raise HTTPException(400, 'sandboxMode must be "boxlite" or "none".')
    workspace_path = string_field(body, "workspacePath") or None
    try:
        display_name = normalize_computer_display_name(body.get("displayName"))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if requested_location not in (None, "employee-device"):
        raise HTTPException(400, 'nodeLocation must be "employee-device".')
    if requested_location == "employee-device" and not valid_employee_workspace_path(workspace_path):
        raise HTTPException(
            400, "An absolute workspacePath on the employee device is required."
        )
    assert_employee_device_runtime(requested_location, sandbox_mode)
    if hasattr(ctx.auth_store, "ensure_employee"):
        if employee_id:
            ctx.auth_store.ensure_employee(employee_id)
    provision_payload = {
        **({"employeeId": employee_id} if employee_id else {}),
        **({"displayName": display_name} if display_name else {}),
        "workspacePath": workspace_path,
        "sandboxMode": sandbox_mode,
        **({"nodeLocation": "employee-device"} if requested_location else {}),
    }
    if requested_location == "employee-device" and employee_id:
        # Admin-provisioned hardware is unbounded; a personal computer is not,
        # and this route creates one just as self-enrollment does. Check and
        # provision share the (reentrant) lock so two concurrent creates cannot
        # both pass a limit with one slot left. Adopting a workspace the
        # employee already enrolled is not a new computer, so it is exempt.
        with ctx.registry.dispatch_lock:
            if not ctx.registry.find_by_employee(employee_id, workspace_path):
                assert_local_computer_allowed(ctx, employee_id)
            node = ctx.backend.provision_daemon_node(provision_payload)
    else:
        node = ctx.backend.provision_daemon_node(provision_payload)
    effective_sandbox_mode = node.get("sandboxMode") if node.get("sandboxMode") in ("boxlite", "none") else sandbox_mode
    public_node = _public_control_panel_node(ctx, node)
    response = {
        "node": public_node,
        "daemonEnv": daemon_start_env(request, node, effective_sandbox_mode),
    }
    if node.get("sandboxToken"):
        response["sandboxToken"] = node["sandboxToken"]
    if node.get("nodeToken"):
        response["nodeToken"] = node["nodeToken"]
        response["daemonCommand"] = daemon_start_command(request, node, effective_sandbox_mode)
    return response


# ── Chat integrations ───────────────────────────────────────────────────

def _actor_name(user: dict[str, Any]) -> str:
    return str(user.get("username") or user.get("id") or "admin")


def _chat_error(error: Exception) -> HTTPException:
    if isinstance(error, KeyError):
        return HTTPException(404, "Chat integration record not found.")
    if isinstance(error, ValueError):
        return HTTPException(400, str(error))
    return HTTPException(500, "Chat integration operation failed.")


@router.get("/admin/chat-integrations")
def list_chat_integrations(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return {"integrations": ctx.chat_store.list_integrations()}


@router.post("/admin/chat-integrations", status_code=201)
def create_chat_integration(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.create_integration(body, actor=_actor_name(user))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.get("/admin/chat-integrations/{integration_id}")
def get_chat_integration(
    integration_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        integration = ctx.chat_store.get_integration(integration_id)
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.patch("/admin/chat-integrations/{integration_id}")
def update_chat_integration(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.update_integration(integration_id, body, actor=_actor_name(user))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.post("/admin/chat-integrations/{integration_id}/activations")
async def activate_chat_integration(integration_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    try:
        ctx.chat_store.validate_activation(integration_id)
        settings = ctx.chat_store.connection_settings(integration_id)
        if settings.get("provider") == "telegram":
            provisioned, message = await request.app.state.chat_provision(settings, integration_id)
            if not provisioned:
                raise ValueError(message)
        else:
            message = "Integration activated."
        integration = ctx.chat_store.activate_integration(integration_id, actor=_actor_name(user))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration, "provisioning": {"ok": True, "message": message}}


@router.post("/admin/chat-integrations/{integration_id}/health-checks")
async def check_chat_integration(integration_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    try:
        settings = ctx.chat_store.connection_settings(integration_id)
        provider_health = await request.app.state.chat_probe(settings)
        integration = ctx.chat_store.check_integration(
            integration_id,
            actor=_actor_name(user),
            provider_health=provider_health,
        )
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.post("/admin/chat-integrations/{integration_id}/webhook-secret-rotations")
async def rotate_telegram_webhook_secret(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    locks = request.app.state.chat_rotation_locks
    lock = locks.setdefault(integration_id, asyncio.Lock())
    async with lock:
        return await _rotate_telegram_webhook_secret(integration_id, request, ctx, user)


async def _rotate_telegram_webhook_secret(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    user: dict[str, Any],
) -> dict[str, Any]:
    try:
        ctx.chat_store.validate_telegram_webhook_rotation(integration_id)
        previous_settings = ctx.chat_store.connection_settings(integration_id)
        previous_secret = previous_settings.get("secrets", {}).get("webhookSecret")
        webhook_secret = secrets.token_urlsafe(32)
        integration = ctx.chat_store.set_telegram_webhook_secret(
            integration_id,
            webhook_secret,
            actor=_actor_name(user),
        )
        settings = ctx.chat_store.connection_settings(integration_id)
        provisioned, message = await request.app.state.chat_provision(settings, integration_id)
        if not provisioned:
            if isinstance(previous_secret, str) and previous_secret:
                restored, restore_message = await request.app.state.chat_provision(previous_settings, integration_id)
                if restored:
                    ctx.chat_store.set_telegram_webhook_secret(integration_id, previous_secret, actor=_actor_name(user))
                else:
                    raise ValueError(
                        f"{message} The previous webhook could not be restored ({restore_message}); "
                        "Relay retained the new secret to avoid rejecting a webhook that Telegram may have accepted."
                    )
            raise ValueError(message)
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration, "provisioning": {"ok": True, "message": message}}


@router.post("/admin/chat-integrations/{integration_id}/identity-links", status_code=201)
def add_chat_identity_link(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    body = _request_body
    employee_id = string_field(body, "employeeId")
    default_agent_id = string_field(body, "defaultAgentId")
    if not employee_record(ctx.auth_store, employee_id):
        raise HTTPException(404, "Employee not found.")
    if default_agent_id:
        agent = ctx.agent_store.get_agent(default_agent_id)
        if (
            not agent
            or agent.get("deletedAt")
            or not agent.get("enabled", True)
            or agent.get("supervisorEmployeeId") != employee_id
        ):
            raise HTTPException(
                400, "defaultAgentId must reference an enabled agent owned by the linked employee."
            )
    try:
        integration = ctx.chat_store.add_identity_link(integration_id, body, actor=_actor_name(user))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.delete("/admin/chat-integrations/{integration_id}/identity-links/{link_id}")
def delete_chat_identity_link(
    integration_id: str, link_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    try:
        integration = ctx.chat_store.delete_identity_link(integration_id, link_id, actor=_actor_name(user))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.post("/admin/chat-integrations/{integration_id}/allowed-conversations", status_code=201)
def add_chat_allowed_conversation(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.add_allowed_conversation(integration_id, body, actor=_actor_name(user))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.delete("/admin/chat-integrations/{integration_id}/allowed-conversations/{conversation_record_id}")
def delete_chat_allowed_conversation(
    integration_id: str,
    conversation_record_id: str,
    request: Request,
    ctx: AppContextDep,
) -> dict[str, Any]:
    user = require_admin_session(request, ctx.auth_store)
    try:
        integration = ctx.chat_store.delete_allowed_conversation(integration_id, conversation_record_id, actor=_actor_name(user))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.get("/admin/chat-integrations/{integration_id}/audit")
def list_chat_integration_audit(
    integration_id: str, request: Request, ctx: AppContextDep, limit: int = 50
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        ctx.chat_store.get_integration(integration_id)
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"events": ctx.chat_store.audit_events(integration_id, limit=limit)}


# ── Dashboard ────────────────────────────────────────────────────────────
# Aggregated, read-only stats for the admin Dashboard view. Built on the
# existing session/task event stores — no schema changes. Token-usage stats
# (TODO: GET /api/v1/admin/dashboard/tokens) will land once agent runs record token
# counts on their session events.

_DAY_WINDOW = 14
_TOKEN_USAGE_UNSUPPORTED_AGENTS = ("kimi",)


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    raw = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@router.get("/admin/dashboard/sessions")
def dashboard_sessions(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if hasattr(ctx.session_store, "dashboard_session_metrics"):
        return ctx.session_store.dashboard_session_metrics(day_window=_DAY_WINDOW)
    sessions = ctx.session_store.list_sessions()
    now = datetime.now(timezone.utc)
    window_start = (now - timedelta(days=_DAY_WINDOW - 1)).date()

    buckets: dict[str, dict[str, int]] = {
        (window_start + timedelta(days=offset)).isoformat(): {"count": 0, "completed": 0, "failed": 0}
        for offset in range(_DAY_WINDOW)
    }

    total = len(sessions)
    last_24h = 0
    last_7d = 0
    status_counts: Counter[str] = Counter()
    per_employee: Counter[str] = Counter()

    one_day = now - timedelta(hours=24)
    seven_day = now - timedelta(days=7)

    for session in sessions:
        created = _parse_timestamp(session.get("createdAt"))
        status = str(session.get("status") or "unknown")
        status_counts[status] += 1
        owner = session.get("ownerEmployeeId")
        if owner:
            per_employee[str(owner)] += 1
        if created is None:
            continue
        if created >= one_day:
            last_24h += 1
        if created >= seven_day:
            last_7d += 1
        day_key = created.date().isoformat()
        if day_key in buckets:
            bucket = buckets[day_key]
            bucket["count"] += 1
            if status == "completed":
                bucket["completed"] += 1
            elif status == "failed":
                bucket["failed"] += 1

    daily_counts = [{"date": day, **stats} for day, stats in buckets.items()]
    top_employees = [
        {"employeeId": employee_id, "sessionCount": count}
        for employee_id, count in per_employee.most_common(5)
    ]

    return {
        "total": total,
        "last24h": last_24h,
        "last7d": last_7d,
        "statusCounts": dict(status_counts),
        "dailyCounts": daily_counts,
        "topEmployees": top_employees,
    }


@router.get("/admin/dashboard/tokens")
def dashboard_tokens(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    now = datetime.now(timezone.utc)
    window_start = (now - timedelta(days=_DAY_WINDOW - 1)).date()
    usage_since = datetime.combine(
        window_start, datetime.min.time(), tzinfo=timezone.utc
    )
    usage_rows = ctx.session_store.list_dashboard_token_usage(
        since=usage_since, recent_session_limit=10
    ) if hasattr(ctx.session_store, "list_dashboard_token_usage") else ctx.session_store.list_token_usage() if hasattr(ctx.session_store, "list_token_usage") else [
        {
            "sessionId": session.get("id"),
            "ownerEmployeeId": session.get("ownerEmployeeId"),
            "taskGoal": session.get("taskGoal"),
            "updatedAt": session.get("updatedAt"),
            **usage,
        }
        for session in ctx.session_store.list_sessions()
        for usage in [_token_usage(session.get("tokenUsage"))]
        if usage
    ]
    summary_start = (now - timedelta(days=6)).date()
    buckets: dict[str, dict[str, int]] = {
        (window_start + timedelta(days=offset)).isoformat(): {"input": 0, "output": 0, "cache": 0, "total": 0}
        for offset in range(_DAY_WINDOW)
    }
    totals = {"input": 0, "output": 0, "cache": 0, "total": 0}
    by_employee: dict[str, dict[str, Any]] = {}
    employee_sessions: dict[str, set[str]] = {}
    recent_by_session: dict[str, dict[str, Any]] = {}

    for row in usage_rows:
        usage = _token_usage(row)
        if not usage:
            continue
        usage_timestamp = row.get("completedAt") or row.get("updatedAt")
        timestamp = _parse_timestamp(usage_timestamp)
        in_summary_window = False
        if timestamp:
            day_key = timestamp.date().isoformat()
            if day_key in buckets:
                for key in buckets[day_key]:
                    buckets[day_key][key] += usage[key]
            in_summary_window = timestamp.date() >= summary_start
        if in_summary_window:
            for key in totals:
                totals[key] += usage[key]
            employee_id = str(row.get("ownerEmployeeId") or "unassigned")
            employee = by_employee.setdefault(
                employee_id,
                {"employeeId": employee_id, "input": 0, "output": 0, "cache": 0, "total": 0, "sessionCount": 0},
            )
            for key in ("input", "output", "cache", "total"):
                employee[key] += usage[key]
            session_id = str(row.get("sessionId") or "")
            if session_id:
                employee_sessions.setdefault(employee_id, set()).add(session_id)
        session_id = str(row.get("sessionId") or row.get("runId") or "unknown")
        recent = recent_by_session.setdefault(session_id, {
            "sessionId": row.get("sessionId"),
            "employeeId": row.get("ownerEmployeeId"),
            "taskGoal": row.get("taskGoal"),
            "updatedAt": usage_timestamp,
            "input": 0,
            "output": 0,
            "cache": 0,
            "total": 0,
        })
        for key in ("input", "output", "cache", "total"):
            recent[key] += usage[key]
        if str(usage_timestamp or "") > str(recent.get("updatedAt") or ""):
            recent["updatedAt"] = usage_timestamp

    for employee_id, employee in by_employee.items():
        employee["sessionCount"] = len(employee_sessions.get(employee_id, set()))
    recent_sessions = list(recent_by_session.values())
    recent_sessions.sort(key=lambda item: item.get("updatedAt") or "", reverse=True)
    ranked_employees = sorted(by_employee.values(), key=lambda item: item["total"], reverse=True)
    return {
        "available": totals["total"] > 0,
        "totalInput": totals["input"],
        "totalOutput": totals["output"],
        "totalCache": totals["cache"],
        "total": totals["total"],
        "unsupportedAgents": list(_TOKEN_USAGE_UNSUPPORTED_AGENTS),
        "daily": [{"date": day, **stats} for day, stats in buckets.items()],
        "byEmployee": ranked_employees,
        "recentSessions": recent_sessions[:10],
    }


def _token_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    usage = {
        "input": int(value.get("input") or 0),
        "output": int(value.get("output") or 0),
        "cache": int(value.get("cache") or 0),
    }
    usage["total"] = usage["input"] + usage["output"] + usage["cache"]
    return usage if usage["total"] > 0 else None
