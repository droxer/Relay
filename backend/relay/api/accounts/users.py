from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger

from ...accounts.user_lifecycle import soft_delete_user as soft_delete_user_cascade
from ...computer.limits import decorate_user_limits
from ...computer.node_agents import sync_node_agents
from ...persistence.org.settings import (
    OrgSettingsValidationError,
    normalize_max_local_computers,
)
from ...security.passwords import validate_password
from ...security.request_auth import require_admin_session
from ...security.user_handles import normalize_user_handle, resolve_user_id, user_record
from ..bodies import JsonBodyDep, string_field
from ..computers.admin_nodes import public_control_panel_node
from ..deps import AppContextDep

router = APIRouter()


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
    return {"departments": ctx.auth_store.list_departments()}


@router.post("/admin/departments", status_code=201)
def create_department(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
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
    return decorate_user_limits(ctx, ctx.auth_store.list_users())


@router.delete("/admin/users/{user_id}", status_code=200)
def soft_delete_user(
    user_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
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
    user = ctx.auth_store.ensure_user(
        account.get("userId") or user_id,
        display_name=display_name,
        email=email,
        max_local_computers=max_local_computers,
    )
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
            public_node = public_control_panel_node(ctx, assigned_node)
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
