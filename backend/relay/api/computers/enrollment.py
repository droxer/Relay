from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...computer.limits import assert_local_computer_allowed, local_computer_enrollment_scope
from ...computer.access import actor_may_manage_computer
from ...computer.names import (
    normalize_computer_display_name,
    present_computer,
)
from ...daemon_registry.records import public_sandbox_record
from ...security.actor import Actor
from ..actors import (
    request_actor,
)
from ..bodies import JsonBodyDep, string_field
from ..deps import AppContextDep
from .installer import computer_install_command, computer_windows_install_command
from .node_install import (
    USER_DEVICE_SANDBOX_MODE,
    assert_user_device_runtime,
    daemon_start_command,
    daemon_start_env,
    valid_user_workspace_path,
)

router = APIRouter()


# A self-enrolled personal computer is direct-run only; the rule is shared with
# the admin create route, so it lives in node_install.py rather than here.
LOCAL_ENROLLMENT_SANDBOX_MODE = USER_DEVICE_SANDBOX_MODE


@router.post("/daemon-node-enrollments/local", status_code=201)
def create_local_device_enrollment(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    # Enrolling a machine is a signed-in human action; a chat-service actor
    # carries no device to connect. Matches the rename route's gate.
    if not actor.get("account"):
        raise HTTPException(401, "Authentication required.")
    body = _request_body
    workspace_path = string_field(body, "workspacePath")
    # A user's own machine runs its agents directly, against the agent
    # installs already on it. BoxLite isolation belongs to hardware an admin
    # provisions, so this route offers no runtime choice — but it refuses a
    # caller that asks for the isolated one rather than silently substituting.
    sandbox_mode = body.get("sandboxMode", LOCAL_ENROLLMENT_SANDBOX_MODE)
    try:
        display_name = normalize_computer_display_name(body.get("displayName"))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if not valid_user_workspace_path(workspace_path):
        raise HTTPException(
            400, "An absolute workspacePath on the user device is required."
        )
    assert_user_device_runtime("user-device", sandbox_mode)
    # Provisioning adopts an existing computer for this user rather than
    # stacking duplicates, so say which happened — the client cannot infer it,
    # and "connected" and "already connected" need different instructions.
    # Adoption can still reissue a token for an unfinished enrollment, so token
    # presence does not answer this; the probe has to run, and it shares the
    # provision's (reentrant) lock so a second enrollment cannot land between
    # the two and report a new computer as adopted.
    with local_computer_enrollment_scope(ctx, actor["userId"]):
        reused = (
            ctx.registry.find_by_user(actor["userId"], workspace_path)
            is not None
        )
        # Only a genuinely new computer consumes a slot. A user at their
        # limit must still be able to re-enroll a machine they already have,
        # or they could never restart their own daemon.
        if not reused:
            assert_local_computer_allowed(ctx, actor["userId"])
        node = ctx.backend.provision_daemon_node(
            {
                "userId": actor["userId"],
                **({"displayName": display_name} if display_name else {}),
                "workspacePath": workspace_path,
                "sandboxMode": sandbox_mode,
                "nodeLocation": "user-device",
            }
        )
        # A concurrent backend replica may have won the durable claim after
        # this process's initial probe. Only a newly created node receives the
        # one-time UI token, so derive the response from the atomic outcome.
        reused = not bool(node.get("sandboxToken"))
    # Existing credentials cannot be recovered from storage. Callers without
    # a launch token must use explicit reissue or the browser device exchange.
    node_token = node.get("nodeToken")
    response: dict[str, Any] = {
        "node": present_computer(
            ctx, public_sandbox_record(ctx.registry.get(node["id"]) or node)
        ),
        "daemonEnv": daemon_start_env(request, node, sandbox_mode),
        "daemonCommand": daemon_start_command(
            request, node, sandbox_mode, prompt_for_token=bool(node_token)
        ),
        "reused": reused,
        "installCommand": computer_install_command(request, node),
        "windowsInstallCommand": computer_windows_install_command(request, node),
    }
    if node.get("sandboxToken"):
        response["sandboxToken"] = node["sandboxToken"]
    if node_token:
        response["nodeToken"] = node_token
    return response


def _owned_live_node(actor: Actor, ctx: AppContextDep, sandbox_id: str) -> dict[str, Any]:
    node = ctx.registry.get(sandbox_id)
    if not node:
        raise HTTPException(404, "Daemon node not found.")
    if not actor_may_manage_computer(actor, node):
        raise HTTPException(403, "Daemon node access denied.")
    if node.get("managedNodeId"):
        # Supervisor-provisioned hardware cycles credentials through the
        # managed node lifecycle, not through the self-service surface.
        raise HTTPException(
            403, "This computer is managed by an admin; its token is not available here."
        )
    return node


def _token_response(request: Request, node: dict[str, Any], token: str) -> dict[str, Any]:
    sandbox_mode = node.get("sandboxMode") or LOCAL_ENROLLMENT_SANDBOX_MODE
    response = {
        "nodeToken": token,
        "daemonEnv": daemon_start_env(request, {**node, "nodeToken": token}, sandbox_mode),
        "daemonCommand": daemon_start_command(
            request, node, sandbox_mode, prompt_for_token=True
        ),
    }

    if (
        sandbox_mode == "none"
        and node.get("nodeLocation") == "user-device"
        and node.get("userId")
        and node.get("workspacePath")
    ):
        response["installCommand"] = computer_install_command(request, node)
        response["windowsInstallCommand"] = computer_windows_install_command(request, node)
    return response


@router.get("/daemon-nodes/{sandbox_id}/token")
def reveal_daemon_node_token(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Compatibility route: authenticated owners are directed to reissue."""
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("account"):
        raise HTTPException(401, "Authentication required.")
    node = _owned_live_node(actor, ctx, sandbox_id)
    token = ctx.registry.reveal_node_token(sandbox_id)
    if not token:
        # Only a hash is stored, so recovery always requires explicit rotation.
        raise HTTPException(
            409, "This computer's token is not recoverable. Reissue it instead."
        )
    return _token_response(request, node, token)


@router.post("/daemon-nodes/{sandbox_id}/token/reissue")
def reissue_daemon_node_token(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Rotate a computer's launch token; the old one stops working at once.

    A daemon still running with the previous token must be restarted with the
    reissued one.
    """
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("account"):
        raise HTTPException(401, "Authentication required.")
    _owned_live_node(actor, ctx, sandbox_id)
    try:
        updated, token = ctx.registry.reissue_node_token(sandbox_id)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(403, str(error)) from error
    return _token_response(request, updated, token)
