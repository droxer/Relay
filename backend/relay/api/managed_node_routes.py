from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from loguru import logger

from ..security.auth import require_admin_session
from ..services.computer_names import normalize_computer_display_name
from ..services.node_agents import (
    assert_node_agent_runs_drained,
    remove_node_agents,
    sync_node_agents,
)
from .deps import AppContext, AppContextDep
from .helpers import JsonBodyDep, employee_record

router = APIRouter()


def _assert_employee_exists(ctx: AppContext, employee_id: Any) -> None:
    """Reject a managed node bound to an employee that does not exist.

    Without this the reconciler provisions capacity forever for a typo'd id,
    and the resulting Computer can never be assigned any work.
    """
    if employee_id is None:
        return
    if not isinstance(employee_id, str) or not employee_id.strip():
        raise HTTPException(400, "employeeId must be a non-empty string.")
    if not employee_record(ctx.auth_store, employee_id.strip()):
        raise HTTPException(404, "Employee not found.")


def _admin_error(error: Exception) -> HTTPException:
    if isinstance(error, KeyError):
        return HTTPException(404, "Managed node or provisioning attempt not found.")
    if isinstance(error, ValueError):
        return HTTPException(409, str(error))
    return HTTPException(500, "Managed-node operation failed.")


@router.post("/admin/managed-nodes", status_code=202)
def create_managed_node(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        payload = _request_body
        if "displayName" in payload:
            payload["displayName"] = normalize_computer_display_name(
                payload["displayName"]
            )
        _assert_employee_exists(ctx, payload.get("employeeId"))
        return {"node": ctx.managed_node_store.create_node(payload)}
    except (KeyError, ValueError) as error:
        if isinstance(error, ValueError) and "displayName" in str(error):
            raise HTTPException(400, str(error)) from error
        raise _admin_error(error) from error


@router.get("/admin/managed-nodes")
def list_managed_nodes(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    # Deleting resources remain visible to the reconciler until provider
    # cleanup has converged.
    return {"nodes": ctx.managed_node_store.list_nodes(include_deleted=True)}


@router.get("/admin/managed-nodes/{node_id}")
def get_managed_node(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    node = ctx.managed_node_store.get_node(node_id)
    if not node:
        raise HTTPException(404, "Managed node not found.")
    return {"node": node}


@router.patch("/admin/managed-nodes/{node_id}")
def update_managed_node(
    node_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        patch = _request_body
        if "displayName" in patch:
            try:
                display_name = normalize_computer_display_name(patch["displayName"])
                patch["displayName"] = display_name or node_id
            except ValueError as error:
                raise HTTPException(400, str(error)) from error
        if "employeeId" in patch:
            _assert_employee_exists(ctx, patch["employeeId"])
        with ctx.registry.dispatch_lock:
            if patch.get("desiredState") in ("stopped", "deleted"):
                existing = ctx.managed_node_store.get_node(node_id)
                if not existing:
                    raise KeyError(node_id)
                daemon_node_id = existing.get("activeDaemonNodeId")
                if daemon_node_id:
                    assert_node_agent_runs_drained(ctx, daemon_node_id)
            node = ctx.managed_node_store.update_node(node_id, patch)
            if patch.get("desiredState") in ("stopped", "deleted"):
                _fence_active_runtime(ctx, node)
        return {"node": node}
    except (KeyError, ValueError) as error:
        raise _admin_error(error) from error


@router.delete("/admin/managed-nodes/{node_id}", status_code=202)
def delete_managed_node(node_id: str, request: Request, ctx: AppContextDep) -> Any:
    require_admin_session(request, ctx.auth_store)
    try:
        with ctx.registry.dispatch_lock:
            existing = ctx.managed_node_store.get_node(node_id)
            if not existing:
                orphaned_runtime_ids = [
                    runtime["id"]
                    for runtime in ctx.registry.control_panel_nodes()
                    if runtime.get("managedNodeId") == node_id
                ]
                if not orphaned_runtime_ids:
                    return Response(status_code=204)
                for runtime_id in orphaned_runtime_ids:
                    runtime = ctx.registry.get(runtime_id)
                    if not runtime or not runtime.get("retiredAt"):
                        assert_node_agent_runs_drained(ctx, runtime_id)
                for runtime_id in orphaned_runtime_ids:
                    remove_node_agents(ctx, runtime_id)
                    ctx.registry.delete(runtime_id)
                return Response(status_code=204)
            daemon_node_id = existing.get("activeDaemonNodeId")
            if daemon_node_id:
                assert_node_agent_runs_drained(ctx, daemon_node_id)
            try:
                node = ctx.managed_node_store.update_node(
                    node_id, {"desiredState": "deleted"}
                )
            except KeyError:
                node = None
            if node:
                _fence_active_runtime(ctx, node)
                daemon_node_id = node.get("activeDaemonNodeId")
                # These agents are not deleted — remove_node_agents only strips
                # their placement on this computer. They stay on the roster,
                # flagged computer_gone by binding_status.
                orphaned_agents = (
                    remove_node_agents(ctx, daemon_node_id) if daemon_node_id else []
                )
                return {"node": node, "orphanedAgents": orphaned_agents}
            orphaned_runtime_ids = [
                runtime["id"]
                for runtime in ctx.registry.control_panel_nodes()
                if runtime.get("managedNodeId") == node_id
            ]
            if not orphaned_runtime_ids:
                return Response(status_code=204)
            for runtime_id in orphaned_runtime_ids:
                runtime = ctx.registry.get(runtime_id)
                if not runtime or not runtime.get("retiredAt"):
                    assert_node_agent_runs_drained(ctx, runtime_id)
            for runtime_id in orphaned_runtime_ids:
                remove_node_agents(ctx, runtime_id)
                ctx.registry.delete(runtime_id)
            return Response(status_code=204)
    except (KeyError, ValueError) as error:
        raise _admin_error(error) from error


@router.post("/admin/managed-nodes/{node_id}/recover", status_code=202)
def recover_managed_node(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        with ctx.registry.dispatch_lock:
            existing = ctx.managed_node_store.get_node(node_id)
            if not existing:
                raise KeyError(node_id)
            if existing.get("desiredState") != "deleted":
                raise ValueError("Only a deleted managed node can be recovered.")
            if existing.get("phase") != "deleted":
                raise ValueError(
                    "Managed node is still being deleted; recover it once deletion finishes."
                )
            node = ctx.managed_node_store.update_node(
                node_id, {"desiredState": "running"}
            )
        return {"node": node}
    except (KeyError, ValueError) as error:
        raise _admin_error(error) from error


@router.delete("/admin/managed-nodes/{node_id}/record", status_code=204)
def permanently_delete_managed_node(
    node_id: str, request: Request, ctx: AppContextDep
) -> Response:
    require_admin_session(request, ctx.auth_store)
    try:
        with ctx.registry.dispatch_lock:
            node = ctx.managed_node_store.get_node(node_id)
            if not node:
                raise KeyError(node_id)
            daemon_node_id = node.get("activeDaemonNodeId")
            if daemon_node_id and ctx.registry.get(daemon_node_id):
                assert_node_agent_runs_drained(ctx, daemon_node_id)
                remove_node_agents(ctx, daemon_node_id)
                ctx.registry.delete(daemon_node_id)
            ctx.managed_node_store.purge_node(node_id)
    except (KeyError, ValueError) as error:
        raise _admin_error(error) from error
    return Response(status_code=204)


@router.get("/admin/managed-nodes/{node_id}/attempts")
def list_managed_node_attempts(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    if not ctx.managed_node_store.get_node(node_id):
        raise HTTPException(404, "Managed node not found.")
    return {"attempts": ctx.managed_node_store.list_attempts(node_id)}


@router.post("/admin/managed-nodes/{node_id}/attempts", status_code=201)
def create_managed_node_attempt(
    node_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        body = _request_body
        if body.get("replaceActive") is True:
            active = ctx.managed_node_store.active_attempt(node_id)
            if active:
                ctx.managed_node_store.update_attempt(
                    active["id"],
                    {"status": "cancelled", "errorCode": "admin_retry"},
                )
        attempt, enrollment_credential = ctx.managed_node_store.create_attempt(node_id)
        return {"attempt": attempt, "enrollmentCredential": enrollment_credential}
    except (KeyError, ValueError) as error:
        raise _admin_error(error) from error


@router.patch("/admin/managed-nodes/{node_id}/attempts/{attempt_id}")
def update_managed_node_attempt(
    node_id: str,
    attempt_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        attempt = ctx.managed_node_store.update_attempt(attempt_id, _request_body)
        if attempt["managedNodeId"] != node_id:
            raise KeyError(attempt_id)
        return {"attempt": attempt}
    except (KeyError, ValueError) as error:
        raise _admin_error(error) from error


@router.delete("/admin/managed-nodes/{node_id}/runtime", status_code=204)
def retire_managed_node_runtime(
    node_id: str, request: Request, ctx: AppContextDep
) -> Response:
    require_admin_session(request, ctx.auth_store)
    try:
        with ctx.registry.dispatch_lock:
            node = ctx.managed_node_store.get_node(node_id)
            if not node:
                raise KeyError(node_id)
            daemon_node_id = node.get("activeDaemonNodeId")
            if daemon_node_id and ctx.registry.get(daemon_node_id):
                assert_node_agent_runs_drained(ctx, daemon_node_id)
                runtime = ctx.registry.get(daemon_node_id)
                if node.get("desiredState") != "deleted" and runtime:
                    # Runtime replacement preserves the stable Computer's
                    # Logical Agents and Placements, including while stopped.
                    # The next incarnation will rebind them during registration.
                    sync_node_agents(ctx, runtime)
                else:
                    remove_node_agents(ctx, daemon_node_id)
                # Keep the credential-bearing row fenced so a late heartbeat
                # cannot recreate this runtime as an unmanaged computer.
                ctx.registry.fence_managed_node(daemon_node_id)
    except KeyError as error:
        raise HTTPException(404, "Managed node not found.") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return Response(status_code=204)


def _fence_active_runtime(ctx: AppContext, node: dict[str, Any]) -> None:
    daemon_node_id = node.get("activeDaemonNodeId")
    if daemon_node_id and ctx.registry.get(daemon_node_id):
        ctx.registry.fence_managed_node(daemon_node_id)


@router.post("/daemon-node-enrollments", status_code=201)
def enroll_managed_daemon(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    authorization = request.headers.get("authorization") or ""
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() != "enrollment" or not credential:
        raise HTTPException(401, "Enrollment credential is required.")
    body = _request_body
    managed_node: dict[str, Any] | None = None
    attempt: dict[str, Any] | None = None
    try:
        # Serialize grant validation, runtime allocation, and durable linkage.
        # A retried request recovers the same daemon identity and token.
        with ctx.registry.dispatch_lock:
            managed_node, attempt = (
                ctx.managed_node_store.consume_enrollment_grant(credential)
            )
            daemon_node, runtime_token = ctx.registry.enroll_managed_node(
                managed_node,
                attempt,
                body,
                enrollment_credential=credential,
            )
            ctx.managed_node_store.complete_enrollment(
                managed_node["id"], attempt["id"], daemon_node["id"]
            )
            ctx.managed_node_store.complete_enrollment_grant(
                credential, daemon_node["id"]
            )
        return {
            "sandboxId": daemon_node["id"],
            "token": runtime_token,
            **(
                {"employeeId": daemon_node["employeeId"]}
                if daemon_node.get("employeeId")
                else {}
            ),
            "sandboxMode": daemon_node.get("sandboxMode") or "boxlite",
            "heartbeat": ctx.registry.heartbeat_settings(),
        }
    except PermissionError as error:
        raise HTTPException(401, str(error)) from error
    except (KeyError, ValueError) as error:
        raise HTTPException(409, str(error)) from error
    except (OSError, json.JSONDecodeError) as error:
        logger.error(
            "Managed daemon enrollment I/O error",
            managed_node_id=managed_node.get("id") if managed_node else None,
            attempt_id=attempt.get("id") if attempt else None,
            error=str(error),
        )
        raise HTTPException(500, "Enrollment processing failed.") from error
