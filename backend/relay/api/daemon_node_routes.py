from __future__ import annotations

import math
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from loguru import logger
from starlette.concurrency import run_in_threadpool

from ..core.ids import new_database_id
from ..core.models import DaemonNodeRegistration
from ..daemon_registry import public_sandbox_record
from ..daemon_registry.registry import DeletedDaemonNodeError
from ..services.computer_limits import assert_local_computer_allowed
from ..services.computer_names import (
    normalize_computer_display_name,
    present_computer,
    rename_computer_for_actor,
)
from ..services.event_notifier import daemon_command_key
from ..services.managed_nodes import managed_node_placeholder
from ..services.node_agents import (
    assert_node_agent_runs_drained,
    remove_node_agents,
    sync_node_agents,
)
from .computer_installer_routes import computer_install_command
from .deps import AppContextDep
from .helpers import (
    EMPLOYEE_DEVICE_SANDBOX_MODE,
    JsonBodyDep,
    actor_can_access_sandbox,
    assert_employee_device_runtime,
    authorized_sandbox_for_token,
    bearer_token,
    daemon_node_event,
    daemon_start_command,
    daemon_start_env,
    json_body,
    request_actor,
    request_actor_or_none,
    string_field,
    valid_employee_workspace_path,
)

router = APIRouter()
WORKSPACE_EVENT_TYPES = frozenset(
    {"workspace.listing", "workspace.file", "workspace.error"}
)

# A self-enrolled personal computer is direct-run only; the rule is shared with
# the admin create route, so it lives in helpers rather than here.
LOCAL_ENROLLMENT_SANDBOX_MODE = EMPLOYEE_DEVICE_SANDBOX_MODE

MAX_COMMAND_POLL_WAIT_SECONDS = 30.0
MAX_COMMAND_POLL_LIMIT = 50
MAX_COMMAND_LEASE_SECONDS = 60 * 60.0
MAX_ACTIVE_COMMAND_IDS = 50
COMMAND_NOTIFICATION_RECOVERY_SECONDS = 5.0


def bounded_float(
    value: str | None, *, default: float, minimum: float, maximum: float, field: str
) -> float:
    if value in (None, ""):
        return default
    try:
        parsed = float(value)
    except ValueError:
        raise HTTPException(400, f"{field} must be a number.")
    if not math.isfinite(parsed):
        raise HTTPException(400, f"{field} must be a finite number.")
    if parsed < minimum or parsed > maximum:
        raise HTTPException(
            400, f"{field} must be between {minimum:g} and {maximum:g}."
        )
    return parsed


def bounded_int(
    value: str | None, *, default: int, minimum: int, maximum: int, field: str
) -> int:
    if value in (None, ""):
        return default
    try:
        parsed = int(value)
    except ValueError:
        raise HTTPException(400, f"{field} must be an integer.")
    if parsed < minimum or parsed > maximum:
        raise HTTPException(400, f"{field} must be between {minimum} and {maximum}.")
    return parsed


def active_command_leases(
    request: Request, lease_mode: str
) -> list[tuple[str, str | None]]:
    leases: list[tuple[str, str | None]] = []
    if lease_mode == "explicit":
        for raw in request.query_params.getlist("activeCommandLease"):
            command_id, separator, lease_id = raw.strip().partition(":")
            if (
                separator
                and command_id
                and lease_id
                and (command_id, lease_id) not in leases
            ):
                leases.append((command_id, lease_id))
            if len(leases) >= MAX_ACTIVE_COMMAND_IDS:
                return leases
    raw_values = (
        list(request.query_params.getlist("activeCommandId"))
        if lease_mode == "legacy"
        else []
    )
    comma_value = (
        request.query_params.get("activeCommandIds") if lease_mode == "legacy" else None
    )
    if comma_value:
        raw_values.extend(comma_value.split(","))
    for raw in raw_values:
        command_id = raw.strip()
        item = (command_id, None)
        if command_id and item not in leases:
            leases.append(item)
        if len(leases) >= MAX_ACTIVE_COMMAND_IDS:
            break
    return leases


def heartbeat_command_leases(body: dict[str, Any]) -> list[tuple[str, str | None]]:
    leases: list[tuple[str, str | None]] = []
    raw_leases = body.get("activeCommandLeases")
    if not isinstance(raw_leases, list):
        return leases
    for raw in raw_leases:
        if not isinstance(raw, dict):
            continue
        command_id = raw.get("commandId")
        lease_id = raw.get("leaseId")
        if not isinstance(command_id, str) or not command_id.strip():
            continue
        item = (
            command_id.strip(),
            lease_id.strip()
            if isinstance(lease_id, str) and lease_id.strip()
            else None,
        )
        if item not in leases:
            leases.append(item)
        if len(leases) >= MAX_ACTIVE_COMMAND_IDS:
            break
    return leases


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
            if actor["isAdmin"] or node.get("employeeId") == actor["employeeId"]
        ]
        return {"nodes": visible_computers(nodes, managed_nodes)}
    raise HTTPException(401, "Authentication required.")


@router.patch("/daemon-nodes/{sandbox_id}")
def update_daemon_node(
    sandbox_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("user"):
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
    if not actor.get("user"):
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
    if "runtime-refresh" not in (node.get("capabilities") or []):
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


@router.post("/daemon-node-enrollments/local", status_code=201)
def create_local_device_enrollment(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    # Enrolling a machine is a signed-in human action; a chat-service actor
    # carries no device to connect. Matches the rename route's gate.
    if not actor.get("user"):
        raise HTTPException(401, "Authentication required.")
    body = _request_body
    workspace_path = string_field(body, "workspacePath")
    # An employee's own machine runs its agents directly, against the agent
    # installs already on it. BoxLite isolation belongs to hardware an admin
    # provisions, so this route offers no runtime choice — but it refuses a
    # caller that asks for the isolated one rather than silently substituting.
    sandbox_mode = body.get("sandboxMode", LOCAL_ENROLLMENT_SANDBOX_MODE)
    try:
        display_name = normalize_computer_display_name(body.get("displayName"))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if not valid_employee_workspace_path(workspace_path):
        raise HTTPException(
            400, "An absolute workspacePath on the employee device is required."
        )
    assert_employee_device_runtime("employee-device", sandbox_mode)
    # Provisioning adopts an existing computer for this employee rather than
    # stacking duplicates, so say which happened — the client cannot infer it,
    # and "connected" and "already connected" need different instructions.
    # Adoption can still reissue a token for an unfinished enrollment, so token
    # presence does not answer this; the probe has to run, and it shares the
    # provision's (reentrant) lock so a second enrollment cannot land between
    # the two and report a new computer as adopted.
    with ctx.registry.dispatch_lock:
        reused = (
            ctx.registry.find_by_employee(actor["employeeId"], workspace_path)
            is not None
        )
        # Only a genuinely new computer consumes a slot. An employee at their
        # limit must still be able to re-enroll a machine they already have,
        # or they could never restart their own daemon.
        if not reused:
            assert_local_computer_allowed(ctx, actor["employeeId"])
        node = ctx.backend.provision_daemon_node(
            {
                "employeeId": actor["employeeId"],
                **({"displayName": display_name} if display_name else {}),
                "workspacePath": workspace_path,
                "sandboxMode": sandbox_mode,
                "nodeLocation": "employee-device",
            }
        )
        # A concurrent backend replica may have won the durable claim after
        # this process's initial probe. Only a newly created node receives the
        # one-time UI token, so derive the response from the atomic outcome.
        reused = not bool(node.get("sandboxToken"))
    # The launch token is persisted for control-panel computers, so adopting
    # an already-registered computer returns the same token again — matching
    # what the reveal endpoint would answer. The start command still prompts
    # for it rather than embedding the secret.
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
    }
    if node.get("sandboxToken"):
        response["sandboxToken"] = node["sandboxToken"]
    if node_token:
        response["nodeToken"] = node_token
    return response


def _owned_live_node(actor: dict[str, Any], ctx: AppContextDep, sandbox_id: str) -> dict[str, Any]:
    node = ctx.registry.get(sandbox_id)
    if not node:
        raise HTTPException(404, "Daemon node not found.")
    if not actor_can_access_sandbox(actor, node):
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
        and node.get("nodeLocation") == "employee-device"
        and node.get("employeeId")
        and node.get("workspacePath")
    ):
        response["installCommand"] = computer_install_command(request, node)
    return response


@router.get("/daemon-nodes/{sandbox_id}/token")
def reveal_daemon_node_token(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Self-service reveal of a computer's launch token, for reconnecting.

    Enrollment shows the token once; the owner of a personal computer can read
    it again here whenever they need to restart or move the daemon.
    """
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("user"):
        raise HTTPException(401, "Authentication required.")
    node = _owned_live_node(actor, ctx, sandbox_id)
    token = ctx.registry.reveal_node_token(sandbox_id)
    if not token:
        # Nodes provisioned before tokens were persisted have no recoverable
        # plaintext; the only way forward is a fresh one.
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
    if not actor.get("user"):
        raise HTTPException(401, "Authentication required.")
    _owned_live_node(actor, ctx, sandbox_id)
    try:
        updated, token = ctx.registry.reissue_node_token(sandbox_id)
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except ValueError as error:
        raise HTTPException(403, str(error)) from error
    return _token_response(request, updated, token)


@router.delete("/daemon-nodes/{sandbox_id}", status_code=204)
def disconnect_daemon_node(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> Response:
    """Self-service removal of a computer, scoped by the same ownership seam.

    The counterpart to enrollment: an employee who can connect a machine must
    be able to take it off the roster, or a mistyped workspace leaves a row
    only an admin can clear.
    """
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("user"):
        raise HTTPException(401, "Authentication required.")
    try:
        with ctx.registry.dispatch_lock:
            node = ctx.registry.get(sandbox_id)
            if not node:
                raise KeyError(sandbox_id)
            if not actor_can_access_sandbox(actor, node):
                raise HTTPException(403, "Daemon node access denied.")
            # Supervisor-provisioned hardware is torn down through the managed
            # node lifecycle, not by the employee sitting in front of it.
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


@router.post("/daemon-node-registrations")
def register_daemon_node(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    body = _request_body
    if "token" not in body and bearer_token(request):
        body["token"] = bearer_token(request)
    try:
        registration = DaemonNodeRegistration.model_validate(body).relay_dump()
        prior = ctx.registry.get(registration["sandboxId"])
        actor = request_actor_or_none(request, ctx.auth_store)
        admin_authorized_ownership = bool(
            not prior
            and actor
            and actor.get("isAdmin")
            and registration.get("employeeId")
        )
        if not prior and not admin_authorized_ownership:
            registration.pop("employeeId", None)
        sandbox = ctx.registry.register(
            registration,
            bearer_token(request),
            authorized_node_location=(
                "employee-device" if admin_authorized_ownership else None
            ),
        )
        ownership_was_control_plane_authorized = bool(
            admin_authorized_ownership
            or (
                prior
                and prior.get("employeeId") == sandbox.get("employeeId")
                and (
                    prior.get("managedNodeId")
                    or prior.get("provisioningAttemptId")
                    or prior.get("nodeLocation")
                    or prior.get("status") == "provisioning"
                )
            )
        )
        if ownership_was_control_plane_authorized:
            sync_node_agents(ctx, sandbox)
        if sandbox.get("managedNodeId") and sandbox.get("status") in (
            "ready",
            "running",
        ):
            ctx.managed_node_store.mark_ready(sandbox["id"])
        logger.info(
            "Daemon node registered",
            sandbox_id=sandbox["id"],
            employee_id=sandbox.get("employeeId"),
            status=sandbox.get("status"),
        )
        return {**sandbox, "heartbeat": ctx.registry.heartbeat_settings()}
    except DeletedDaemonNodeError as error:
        logger.info(
            "Daemon node registration rejected: node was deleted",
            sandbox_id=body.get("sandboxId"),
        )
        # 410 is terminal on purpose -- the daemon stops instead of retrying.
        raise HTTPException(410, str(error))
    except PermissionError as error:
        logger.warning(
            "Daemon node registration denied",
            sandbox_id=body.get("sandboxId"),
            error=str(error),
        )
        raise HTTPException(401, str(error))
    except Exception as error:  # noqa: BLE001 - API boundary logs and normalizes registry failures.
        logger.warning(
            "Daemon node registration failed",
            sandbox_id=body.get("sandboxId"),
            error=str(error),
        )
        raise HTTPException(400, str(error))


@router.post("/daemon-nodes/{sandbox_id}/heartbeat")
async def daemon_heartbeat(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Renew a daemon lease independently of command and event traffic."""
    body = await json_body(request)
    try:
        return {
            "heartbeat": await run_in_threadpool(
                ctx.registry.heartbeat,
                sandbox_id,
                bearer_token(request),
                heartbeat_command_leases(body),
            )
        }
    except DeletedDaemonNodeError as error:
        raise HTTPException(410, str(error))
    except PermissionError as error:
        logger.warning(
            "Daemon node heartbeat unauthorized",
            sandbox_id=sandbox_id,
            error=str(error),
        )
        raise HTTPException(401, str(error))
    except KeyError as error:
        raise HTTPException(404, str(error))


@router.get("/daemon-nodes/{sandbox_id}/commands")
async def daemon_commands(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    poll_started_at = time.monotonic()
    wait_seconds = bounded_float(
        request.query_params.get("waitSeconds"),
        default=0.0,
        minimum=0.0,
        maximum=MAX_COMMAND_POLL_WAIT_SECONDS,
        field="waitSeconds",
    )
    limit = bounded_int(
        request.query_params.get("limit"),
        default=10,
        minimum=1,
        maximum=MAX_COMMAND_POLL_LIMIT,
        field="limit",
    )
    lease_seconds = bounded_float(
        request.query_params.get("leaseSeconds"),
        default=60.0,
        minimum=1.0,
        maximum=MAX_COMMAND_LEASE_SECONDS,
        field="leaseSeconds",
    )
    lease_mode = request.query_params.get("leaseMode") or "legacy"
    if lease_mode not in ("explicit", "legacy"):
        raise HTTPException(400, 'leaseMode must be "explicit" or "legacy".')
    try:
        token = bearer_token(request)
        active_leases = active_command_leases(request, lease_mode)
        deadline = time.monotonic() + wait_seconds
        await run_in_threadpool(
            ctx.registry.renew_active_command_leases,
            sandbox_id,
            token,
            active_leases,
            lease_seconds=lease_seconds,
        )
        notification_key = daemon_command_key(sandbox_id)
        while True:
            with ctx.control_plane_notifier.observe(
                notification_key
            ) as observed_version:
                commands = await run_in_threadpool(
                    ctx.registry.take_commands,
                    sandbox_id,
                    token,
                    limit=limit,
                    lease_seconds=lease_seconds,
                    renew_known_active=lease_mode == "legacy",
                )
                remaining = deadline - time.monotonic()
                if commands or remaining <= 0:
                    break
                await ctx.control_plane_notifier.wait(
                    notification_key,
                    observed_version,
                    timeout=min(COMMAND_NOTIFICATION_RECOVERY_SECONDS, remaining),
                )
            await run_in_threadpool(
                ctx.registry.renew_active_command_leases,
                sandbox_id,
                token,
                active_leases,
                lease_seconds=lease_seconds,
            )
        logger.debug(
            "Daemon node commands polled",
            sandbox_id=sandbox_id,
            command_count=len(commands),
        )
        # Return explicit lease evidence from this poll as well as heartbeats.
        # A successful empty poll alone is not proof of command ownership.
        acknowledged = await run_in_threadpool(
            ctx.registry.command_lease_observations, sandbox_id,
            list(dict(active_leases + [
                (command["id"], command.get("leaseId"))
                for command in commands if command.get("type") == "run.start"
            ]).items()),
        )
        return {
            "commands": commands,
            "heartbeat": {**ctx.registry.heartbeat_settings(), **acknowledged},
            "processingMs": (time.monotonic() - poll_started_at) * 1000,
        }
    except DeletedDaemonNodeError as error:
        raise HTTPException(410, str(error))
    except PermissionError as error:
        logger.warning(
            "Daemon node commands unauthorized", sandbox_id=sandbox_id, error=str(error)
        )
        raise HTTPException(401, str(error))
    except KeyError as error:
        raise HTTPException(404, str(error))


@router.get("/daemon-nodes/{sandbox_id}/skill-blobs/{sha256}")
def daemon_skill_blob(
    sandbox_id: str, sha256: str, request: Request, ctx: AppContextDep
) -> Response:
    """Serve only content named by this node's active issuing run command."""
    try:
        ctx.registry.assert_node_event_authorized(sandbox_id, bearer_token(request))
    except (PermissionError, KeyError) as error:
        raise HTTPException(401, "Unauthorized daemon node.") from error
    command_id = request.query_params.get("commandId") or ""
    record = ctx.daemon_store.get_command(command_id) if command_id else None
    command = (record or {}).get("command") or {}
    authorized = bool(
        record
        and record.get("nodeId") == sandbox_id
        and record.get("status") == "dispatched"
        and command.get("type") == "run.start"
        and any(
            file.get("sha256") == sha256
            for skill in (command.get("skills") or {}).get("skills", [])
            if isinstance(skill, dict)
            for file in skill.get("files", [])
            if isinstance(file, dict)
        )
    )
    if not authorized:
        raise HTTPException(404, "Skill blob not found.")
    content = ctx.skill_store.blob(sha256)
    if content is None:
        raise HTTPException(404, "Skill blob not found.")
    return Response(content=content, media_type="application/octet-stream")


@router.post("/daemon-nodes/{sandbox_id}/events")
async def daemon_events(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, bool]:
    try:
        event = daemon_node_event(await json_body(request))
        if event.get("type") in WORKSPACE_EVENT_TYPES:
            ctx.registry.assert_node_event_authorized(sandbox_id, bearer_token(request))
            await run_in_threadpool(
                ctx.daemon_store.record_workspace_response, sandbox_id, event
            )
            ctx.workspace_query_broker.resolve(event["commandId"], sandbox_id, event)
            return {"ok": True}
        await run_in_threadpool(
            ctx.registry.handle_event, sandbox_id, event, bearer_token(request)
        )
        logger.debug(
            "Daemon node event handled",
            sandbox_id=sandbox_id,
            event_type=event["type"],
            run_id=event["runId"],
        )
        return {"ok": True}
    except DeletedDaemonNodeError as error:
        raise HTTPException(410, str(error))
    except PermissionError as error:
        logger.warning(
            "Daemon node event unauthorized", sandbox_id=sandbox_id, error=str(error)
        )
        raise HTTPException(401, str(error))
    except KeyError as error:
        raise HTTPException(404, str(error))
    except Exception as error:  # noqa: BLE001 - API boundary logs and normalizes event-store failures.
        logger.warning(
            "Daemon node event rejected", sandbox_id=sandbox_id, error=str(error)
        )
        raise HTTPException(400, str(error))
