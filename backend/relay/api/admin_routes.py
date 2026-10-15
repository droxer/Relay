from __future__ import annotations

import asyncio
import secrets
from collections import Counter
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Request, Response
from loguru import logger

from ..automations.service import automation_triggers_enabled
from ..core.legacy_names import with_legacy_user_id
from ..daemon_registry import public_sandbox_record
from ..persistence.store_common import split_cache_tokens
from ..persistence.org_settings_store import (
    OrgSettingsValidationError,
    normalize_max_local_computers,
    normalize_max_task_rounds,
    normalize_skill_import_hosts,
)
from ..security.auth import (
    admin_token_configured,
    reissue_admin_token,
    require_admin_session,
    validate_password,
)
from ..services.computer_limits import (
    assert_local_computer_allowed,
    decorate_user_limits,
)
from ..services.computer_names import normalize_computer_display_name, present_computer
from ..services.user_lifecycle import (
    soft_delete_user as soft_delete_user_cascade,
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
    assert_user_device_runtime,
    daemon_start_command,
    daemon_start_env,
    user_record,
    normalize_user_handle,
    resolve_user_id,
    string_field,
    valid_user_workspace_path,
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
        # Editing a user — display name, email, or their own computer
        # limit — writes the users table, which only the database auth
        # store has. Reported so the admin UI can leave those controls out
        # instead of offering an edit that would come back a 400.
        "capabilities": {
            "userEdits": hasattr(ctx.auth_store, "update_user"),
            # Off: automations may hold only schedule triggers.
            "automationTriggers": automation_triggers_enabled(),
            # Off: the waitlist routes are not mounted (RELAY_WAITLIST_ENABLED).
            "waitlist": bool(getattr(request.app.state, "waitlist_enabled", False)),
        },
        # Whether the bootstrap/supervisor bearer token exists. Only its hash
        # is stored, so the value itself is shown once, by the reissue route.
        "adminTokenConfigured": admin_token_configured(),
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
    if not {"maxLocalComputersPerUser", "maxTaskRounds", "skillImportAllowedHosts"}.intersection(body):
        raise HTTPException(
            400, "maxLocalComputersPerUser, maxTaskRounds or skillImportAllowedHosts is required."
        )
    try:
        settings = ctx.org_settings_store.update_settings(
            max_local_computers_per_user=(
                normalize_max_local_computers(body["maxLocalComputersPerUser"])
                if "maxLocalComputersPerUser" in body
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


@router.get("/admin/accounts")
def list_accounts(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return {"accounts": ctx.auth_store.list_accounts()}


@router.post("/admin/accounts", status_code=201)
def create_account(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        account = ctx.auth_store.create_account(
            string_field(body, "username"),
            string_field(body, "password"),
            role=string_field(body, "role") or "user",
            email=string_field(body, "email") or None,
            user_id=string_field(body, "userId") or None,
            display_name=string_field(body, "displayName") or None,
            department_id=string_field(body, "departmentId") or None,
            department_name=string_field(body, "departmentName") or None,
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"account": account}


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


@router.get("/admin/users")
def list_users(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return {"users": _user_records(ctx)}


@router.get("/admin/employees", deprecated=True)
def list_users_for_legacy_supervisor(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    """The pre-rename route a supervisor older than the user rename still polls."""
    require_admin_session(request, ctx.auth_store)
    return {"employees": _user_records(ctx)}


def _user_records(ctx: Any) -> list[dict[str, Any]]:
    if hasattr(ctx.auth_store, "list_users"):
        return decorate_user_limits(ctx, ctx.auth_store.list_users())
    deleted_ids = ctx.auth_store.deleted_user_ids() if hasattr(ctx.auth_store, "deleted_user_ids") else set()
    users = []
    seen = set()
    for account in ctx.auth_store.list_accounts():
        user_id = account.get("userId")
        if not user_id or user_id in seen or user_id in deleted_ids:
            continue
        seen.add(user_id)
        users.append({
            "id": user_id,
            "displayName": account.get("displayName") or account.get("username") or user_id,
            "email": account.get("email"),
            "createdAt": account.get("createdAt"),
            "updatedAt": account.get("createdAt"),
        })
    return decorate_user_limits(ctx, users)


@router.delete("/admin/users/{user_id}", status_code=200)
def soft_delete_user(
    user_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if not hasattr(ctx.auth_store, "soft_delete_user"):
        raise HTTPException(400, "User soft-delete is not supported by this auth store.")
    try:
        return soft_delete_user_cascade(ctx, user_id)
    except KeyError as error:
        raise HTTPException(404, "User not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.patch("/admin/users/{user_id}")
def update_user(
    user_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if not hasattr(ctx.auth_store, "update_user"):
        raise HTTPException(
            400, "Editing a user requires the database auth store."
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
        user = ctx.auth_store.update_user(user_id, **patch)
    except KeyError as error:
        raise HTTPException(404, "User not found.") from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"user": decorate_user_limits(ctx, [user])[0]}


@router.post("/admin/users", status_code=201)
def create_user(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    user_id = normalize_user_handle(string_field(body, "userId"))
    username = string_field(body, "username")
    password = string_field(body, "password")
    node_id = string_field(body, "nodeId") or None
    email = string_field(body, "email") or None
    display_name = string_field(body, "displayName") or username or user_id
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
            password, identifiers=(username, user_id, display_name, email)
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    # A user id that already exists is a collision, not a second user.
    # The stores' ensure_user reuses a matching row and patches the profile
    # onto it, so without this check "Add user" silently rewrote a live
    # colleague's display name, email, and computer limit and attached a second
    # login to them. Resolution goes through the store because the database
    # store maps handles onto UUIDs — comparing raw handles would never match.
    # Soft-deleted users are deliberately not blocked: re-creating a removed
    # user is an existing, intended path.
    if user_record(ctx.auth_store, resolve_user_id(ctx.auth_store, user_id)):
        raise HTTPException(409, f"User @{user_id} already exists.")
    # Node assignment is optional at onboarding — a user may be created
    # first and bound to a sandbox later via the assign-node flow. Only validate
    # the node when one was supplied.
    if node_id:
        existing_node = ctx.registry.get(node_id)
        if not existing_node:
            raise HTTPException(404, "Daemon node not found.")
        if existing_node.get("userId"):
            raise HTTPException(409, "Daemon node is already assigned.")
    try:
        account = ctx.auth_store.create_account(
            username,
            password,
            role="user",
            email=email,
            user_id=user_id,
            display_name=display_name,
        )
    except ValueError as error:
        message = str(error)
        status = 409 if "already exists" in message else 400
        raise HTTPException(status, message) from error
    if hasattr(ctx.auth_store, "ensure_user"):
        user = ctx.auth_store.ensure_user(
            account.get("userId") or user_id,
            display_name=display_name,
            email=email,
            max_local_computers=max_local_computers,
        )
    else:
        # The file auth store keeps no user row, so an override has nowhere
        # to live. Say so rather than accepting a limit that would be dropped.
        if max_local_computers is not None:
            raise HTTPException(
                400,
                "Per-user computer limits require the database auth store.",
            )
        user = {
            "id": user_id,
            "handle": user_id,
            "displayName": display_name,
            "email": email,
            "createdAt": account.get("createdAt"),
            "updatedAt": account.get("createdAt"),
        }
    user = decorate_user_limits(ctx, [user])[0]
    public_node: dict[str, Any] | None = None
    assignment_error: str | None = None
    if node_id:
        # The user is already committed by this point, so a computer that
        # got claimed in the meantime cannot be reported as a failed request:
        # raising here left a created user behind an error message, and the
        # retry then failed on "username already exists" with no way forward.
        # The user is the outcome; the unattached computer is a warning the
        # admin resolves from the assign flow.
        try:
            assigned_node = ctx.registry.assign_user(node_id, user["id"])
            sync_node_agents(ctx, assigned_node)
            public_node = _public_control_panel_node(ctx, assigned_node)
        except KeyError:
            assignment_error = "Computer not found."
        except ValueError as error:
            assignment_error = str(error)
        if assignment_error:
            logger.warning(
                "User created but computer assignment failed",
                user_id=user["id"],
                node_id=node_id,
                error=assignment_error,
            )
    return {
        "user": user,
        "account": account,
        **({"node": public_node} if public_node else {}),
        **({"assignmentError": assignment_error} if assignment_error else {}),
    }


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
    public_node = _public_control_panel_node(ctx, assigned_node)
    return {"user": user, "node": public_node}


@router.delete("/admin/daemon-nodes/{node_id}/assignment")
def unassign_control_panel_daemon_node(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    existing_node = ctx.registry.get(node_id)
    if not existing_node:
        raise HTTPException(404, "Daemon node not found.")
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
    if hasattr(ctx.auth_store, "ensure_user"):
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
        with ctx.registry.dispatch_lock:
            if not ctx.registry.find_by_user(user_id, workspace_path):
                assert_local_computer_allowed(ctx, user_id)
            node = ctx.backend.provision_daemon_node(provision_payload)
    else:
        node = ctx.backend.provision_daemon_node(provision_payload)
    effective_sandbox_mode = node.get("sandboxMode") if node.get("sandboxMode") in ("boxlite", "none") else sandbox_mode
    public_node = _public_control_panel_node(ctx, node)
    response = {
        "node": with_legacy_user_id(public_node),
        "daemonEnv": daemon_start_env(request, node, effective_sandbox_mode),
    }
    if node.get("sandboxToken"):
        response["sandboxToken"] = node["sandboxToken"]
    if node.get("nodeToken"):
        response["nodeToken"] = node["nodeToken"]
        response["daemonCommand"] = daemon_start_command(request, node, effective_sandbox_mode)
    return response


# ── Chat integrations ───────────────────────────────────────────────────

def _actor_name(account: dict[str, Any]) -> str:
    return str(account.get("username") or account.get("id") or "admin")


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
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.create_integration(body, actor=_actor_name(account))
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
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.update_integration(integration_id, body, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.post("/admin/chat-integrations/{integration_id}/activations")
async def activate_chat_integration(integration_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    try:
        ctx.chat_store.validate_activation(integration_id)
        settings = ctx.chat_store.connection_settings(integration_id)
        if settings.get("provider") == "telegram":
            provisioned, message = await request.app.state.chat_provision(settings, integration_id)
            if not provisioned:
                raise ValueError(message)
        else:
            message = "Integration activated."
        integration = ctx.chat_store.activate_integration(integration_id, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration, "provisioning": {"ok": True, "message": message}}


@router.post("/admin/chat-integrations/{integration_id}/health-checks")
async def check_chat_integration(integration_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    try:
        settings = ctx.chat_store.connection_settings(integration_id)
        provider_health = await request.app.state.chat_probe(settings)
        integration = ctx.chat_store.check_integration(
            integration_id,
            actor=_actor_name(account),
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
    account = require_admin_session(request, ctx.auth_store)
    locks = request.app.state.chat_rotation_locks
    lock = locks.setdefault(integration_id, asyncio.Lock())
    async with lock:
        return await _rotate_telegram_webhook_secret(integration_id, request, ctx, account)


async def _rotate_telegram_webhook_secret(
    integration_id: str,
    request: Request,
    ctx: AppContextDep,
    account: dict[str, Any],
) -> dict[str, Any]:
    try:
        ctx.chat_store.validate_telegram_webhook_rotation(integration_id)
        previous_settings = ctx.chat_store.connection_settings(integration_id)
        previous_secret = previous_settings.get("secrets", {}).get("webhookSecret")
        webhook_secret = secrets.token_urlsafe(32)
        integration = ctx.chat_store.set_telegram_webhook_secret(
            integration_id,
            webhook_secret,
            actor=_actor_name(account),
        )
        settings = ctx.chat_store.connection_settings(integration_id)
        provisioned, message = await request.app.state.chat_provision(settings, integration_id)
        if not provisioned:
            if isinstance(previous_secret, str) and previous_secret:
                restored, restore_message = await request.app.state.chat_provision(previous_settings, integration_id)
                if restored:
                    ctx.chat_store.set_telegram_webhook_secret(integration_id, previous_secret, actor=_actor_name(account))
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
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    user_id = string_field(body, "userId")
    default_agent_id = string_field(body, "defaultAgentId")
    if not user_record(ctx.auth_store, user_id):
        raise HTTPException(404, "User not found.")
    if default_agent_id:
        agent = ctx.agent_store.get_agent(default_agent_id)
        if (
            not agent
            or agent.get("deletedAt")
            or not agent.get("enabled", True)
            or agent.get("supervisorUserId") != user_id
        ):
            raise HTTPException(
                400, "defaultAgentId must reference an enabled agent owned by the linked user."
            )
    try:
        integration = ctx.chat_store.add_identity_link(integration_id, body, actor=_actor_name(account))
    except (KeyError, ValueError) as error:
        raise _chat_error(error) from error
    return {"integration": integration}


@router.delete("/admin/chat-integrations/{integration_id}/identity-links/{link_id}")
def delete_chat_identity_link(
    integration_id: str, link_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    account = require_admin_session(request, ctx.auth_store)
    try:
        integration = ctx.chat_store.delete_identity_link(integration_id, link_id, actor=_actor_name(account))
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
    account = require_admin_session(request, ctx.auth_store)
    body = _request_body
    try:
        integration = ctx.chat_store.add_allowed_conversation(integration_id, body, actor=_actor_name(account))
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
    account = require_admin_session(request, ctx.auth_store)
    try:
        integration = ctx.chat_store.delete_allowed_conversation(integration_id, conversation_record_id, actor=_actor_name(account))
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
# Aggregated, read-only stats for the admin Dashboard view, built on the
# session store and its per-run token-usage ledger.

_DAY_WINDOW = 14
_SUMMARY_DAYS = 7
_TOKEN_KEYS = ("input", "output", "cacheRead", "cacheWrite")


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
    per_user: Counter[str] = Counter()

    one_day = now - timedelta(hours=24)
    seven_day = now - timedelta(days=7)

    for session in sessions:
        created = _parse_timestamp(session.get("createdAt"))
        status = str(session.get("status") or "unknown")
        status_counts[status] += 1
        owner = session.get("ownerUserId")
        if owner:
            per_user[str(owner)] += 1
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
    top_users = [
        {"userId": user_id, "sessionCount": count}
        for user_id, count in per_user.most_common(5)
    ]

    return {
        "total": total,
        "last24h": last_24h,
        "last7d": last_7d,
        "statusCounts": dict(status_counts),
        "dailyCounts": daily_counts,
        "topUsers": top_users,
    }


@router.get("/admin/dashboard/tokens")
def dashboard_tokens(
    request: Request, ctx: AppContextDep, tz: str | None = None
) -> dict[str, Any]:
    """Token usage per calendar day in the viewer's time zone (``tz``).

    The headline is fresh tokens — input, output, and cache writes. Cache reads
    are reported beside it but kept out of the headline: they dominate a long
    agent run's total while costing a tenth of input.
    """
    require_admin_session(request, ctx.auth_store)
    zone = _dashboard_zone(tz)
    today = datetime.now(zone).date()
    window_start = today - timedelta(days=_DAY_WINDOW - 1)
    summary_start = today - timedelta(days=_SUMMARY_DAYS - 1)
    usage_since = datetime.combine(window_start, datetime.min.time(), tzinfo=zone)
    usage_rows = (
        ctx.session_store.list_dashboard_token_usage(since=usage_since)
        if hasattr(ctx.session_store, "list_dashboard_token_usage")
        else ctx.session_store.list_token_usage()
    )
    buckets = {
        (window_start + timedelta(days=offset)).isoformat(): _empty_token_counts()
        for offset in range(_DAY_WINDOW)
    }
    totals = _empty_token_counts()
    unreported: Counter[str] = Counter()
    for row in usage_rows:
        timestamp = _parse_timestamp(row.get("completedAt") or row.get("updatedAt"))
        if timestamp is None:
            continue
        day = timestamp.astimezone(zone).date()
        in_summary = day >= summary_start
        if row.get("reported") is False:
            if in_summary and row.get("agent"):
                unreported[str(row["agent"])] += 1
            continue
        usage = _token_usage(row)
        if not usage:
            continue
        bucket = buckets.get(day.isoformat())
        if bucket is not None:
            _add_token_counts(bucket, usage)
        if in_summary:
            _add_token_counts(totals, usage)
    daily = [{"date": day, **_with_derived_counts(counts)} for day, counts in buckets.items()]
    summary = _with_derived_counts(totals)
    return {
        "available": any(point["total"] > 0 for point in daily),
        "timeZone": str(zone),
        "totalInput": summary["input"],
        "totalOutput": summary["output"],
        "totalCacheRead": summary["cacheRead"],
        "totalCacheWrite": summary["cacheWrite"],
        "totalCache": summary["cache"],
        "total": summary["total"],
        "fresh": summary["fresh"],
        "daily": daily,
        "unreportedRuns": [
            {"agent": agent, "runs": runs} for agent, runs in unreported.most_common()
        ],
    }


def _dashboard_zone(name: str | None) -> tzinfo:
    if not name or len(name) > 64:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def _empty_token_counts() -> dict[str, int]:
    return dict.fromkeys(_TOKEN_KEYS, 0)


def _add_token_counts(target: dict[str, int], usage: dict[str, int]) -> None:
    for key in _TOKEN_KEYS:
        target[key] += usage[key]


def _with_derived_counts(counts: dict[str, int]) -> dict[str, int]:
    cache = counts["cacheRead"] + counts["cacheWrite"]
    fresh = counts["input"] + counts["output"] + counts["cacheWrite"]
    return {**counts, "cache": cache, "total": fresh + counts["cacheRead"], "fresh": fresh}


def _token_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    cache_read, cache_write = split_cache_tokens(value)
    usage = {
        "input": int(value.get("input") or 0),
        "output": int(value.get("output") or 0),
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
    }
    return usage if any(usage.values()) else None
