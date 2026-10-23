from __future__ import annotations

import math
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from loguru import logger
from starlette.concurrency import run_in_threadpool

from ...computer.node_agents import sync_node_agents
from ...core.models import DaemonNodeRegistration
from ...daemon_registry.records import (
    CommandEventMismatchError,
    DeletedDaemonNodeError,
    UnknownDaemonNodeError,
)
from ...daemon_registry import config as registry_config
from ...daemon_registry.dispatch.commands import HEARTBEAT_STATES
from ...realtime.event_notifier import daemon_command_key
from ..actors import (
    bearer_token,
    request_actor_or_none,
)
from ..bodies import JsonBodyDep, json_body
from ..deps import AppContextDep
from ..projects.links import registration_project_links
from .daemon_events import daemon_node_event

router = APIRouter()


WORKSPACE_EVENT_TYPES = frozenset(
    {
        "workspace.listing",
        "workspace.file",
        "workspace.error",
        "workspace.deleted",
        "workspace.linked",
    }
)


MAX_COMMAND_POLL_WAIT_SECONDS = registry_config.COMMAND_POLL_MAX_WAIT_SECONDS
MAX_COMMAND_POLL_LIMIT = 50
MAX_COMMAND_LEASE_SECONDS = 60 * 60.0
MAX_ACTIVE_COMMAND_IDS = 50
# How long a command poll waits before re-reading the queue on its own when no
# wake arrives. A publish can be missed (several SQLite processes, a dropped
# notification), so this is the dispatch latency floor for that case; the
# recovery read is one indexed query per waiting daemon per interval.
COMMAND_NOTIFICATION_RECOVERY_SECONDS = 1.0


def bounded_float(
    value: str | None, *, default: float, minimum: float, maximum: float, field: str
) -> float:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        raise HTTPException(400, f"{field} must be a number.")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{field} must be a number.") from None
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
        raise HTTPException(400, f"{field} must be an integer.") from None
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


@router.post("/daemon-node-registrations")
def register_daemon_node(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    body = _request_body
    if "token" not in body and bearer_token(request):
        body["token"] = bearer_token(request)
    try:
        registration = DaemonNodeRegistration.model_validate(body).relay_dump()
        # A deleted computer's daemon carries no admin session, so it must
        # learn it was deleted (410, terminal) before the enrollment gate
        # could tell it to run setup again (401).
        ctx.registry.assert_not_deleted(registration)
        prior = ctx.registry.get(registration["sandboxId"])
        actor = request_actor_or_none(request, ctx.auth_store)
        admin_authorized_ownership = bool(
            not prior
            and actor
            and actor.get("isAdmin")
            and registration.get("userId")
        )
        if not prior and not (actor and actor.get("isAdmin")):
            raise PermissionError("Computer enrollment is required before daemon registration.")
        sandbox = ctx.registry.register(
            registration,
            bearer_token(request),
            authorized_node_location=(
                "user-device" if admin_authorized_ownership else None
            ),
        )
        ownership_was_control_plane_authorized = bool(
            admin_authorized_ownership
            or (
                prior
                and prior.get("userId") == sandbox.get("userId")
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
            user_id=sandbox.get("userId"),
            status=sandbox.get("status"),
        )
        journaled = registration.get("journaledCommandIds") or []
        acknowledged = (
            ctx.registry.account_journaled_commands(sandbox["id"], journaled)
            if journaled else []
        )
        return {
            **sandbox,
            "heartbeat": ctx.registry.heartbeat_settings(),
            **({"acknowledgedJournalIds": acknowledged} if journaled else {}),
            **registration_project_links(
                ctx, sandbox, list(sandbox.get("capabilities") or [])
            ),
        }
    except DeletedDaemonNodeError as error:
        logger.info(
            "Daemon node registration rejected: node was deleted",
            sandbox_id=body.get("sandboxId"),
        )
        # 410 is terminal on purpose -- the daemon stops instead of retrying.
        raise HTTPException(410, str(error)) from error
    except PermissionError as error:
        logger.warning(
            "Daemon node registration denied",
            sandbox_id=body.get("sandboxId"),
            error=str(error),
        )
        raise HTTPException(401, str(error)) from error
    except ValueError as error:
        # Registration validates its payload with ValueError; anything else is
        # a server fault, answered 500 so the daemon retries with backoff.
        logger.warning(
            "Daemon node registration rejected",
            sandbox_id=body.get("sandboxId"),
            error=str(error),
        )
        raise HTTPException(400, str(error)) from error


@router.post("/daemon-nodes/{sandbox_id}/heartbeat")
async def daemon_heartbeat(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Renew a daemon lease independently of command and event traffic."""
    body = await json_body(request)
    state = body.get("state")
    if state is not None and state not in HEARTBEAT_STATES:
        raise HTTPException(400, "state must be one of ready, draining, stopped.")
    try:
        return {
            "heartbeat": await run_in_threadpool(
                ctx.registry.heartbeat,
                sandbox_id,
                bearer_token(request),
                heartbeat_command_leases(body),
                lease_seconds=bounded_float(
                    body.get("leaseSeconds"), default=60.0, minimum=1.0,
                    maximum=MAX_COMMAND_LEASE_SECONDS, field="leaseSeconds",
                ),
                state=state,
            )
        }
    except DeletedDaemonNodeError as error:
        raise HTTPException(410, str(error)) from error
    except PermissionError as error:
        logger.warning(
            "Daemon node heartbeat unauthorized",
            sandbox_id=sandbox_id,
            error=str(error),
        )
        raise HTTPException(401, str(error)) from error
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error


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
            # A daemon that hung up (it is shutting down, or its request timed
            # out) reads nothing we return. Taking a command now would lease
            # it into the void, and marking the node polled would undo a drain.
            if await request.is_disconnected():
                logger.debug("Daemon node command poll abandoned", sandbox_id=sandbox_id)
                break
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
        raise HTTPException(410, str(error)) from error
    except PermissionError as error:
        logger.warning(
            "Daemon node commands unauthorized", sandbox_id=sandbox_id, error=str(error)
        )
        raise HTTPException(401, str(error)) from error
    except KeyError as error:
        raise HTTPException(404, "Daemon node not found.") from error


@router.get("/daemon-nodes/{sandbox_id}/auth-check")
def daemon_auth_check(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Read-only runtime-token verification for daemon diagnostics and setup."""
    try:
        ctx.registry.assert_node_authenticated(sandbox_id, bearer_token(request))
    except (PermissionError, KeyError, DeletedDaemonNodeError) as error:
        raise HTTPException(401, "Unauthorized daemon node.") from error
    return {"sandboxId": sandbox_id, "authenticated": True}


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


@router.get("/daemon-nodes/{sandbox_id}/permission-requests/{request_id}")
def daemon_permission_request(
    sandbox_id: str, request_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """The answer to a run's permission prompt, polled while the run waits."""
    session_id = request.query_params.get("sessionId") or ""
    if not session_id:
        raise HTTPException(400, "sessionId is required.")
    try:
        status = ctx.registry.permission_request_status(
            sandbox_id, bearer_token(request), session_id, request_id
        )
    except DeletedDaemonNodeError as error:
        raise HTTPException(410, str(error)) from error
    except UnknownDaemonNodeError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except PermissionError as error:
        raise HTTPException(401, "Unauthorized daemon node.") from error
    if status is None:
        raise HTTPException(404, "Permission request not found.")
    return status


@router.post("/daemon-nodes/{sandbox_id}/events")
async def daemon_events(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, bool]:
    try:
        event = daemon_node_event(await json_body(request))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    try:
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
        raise HTTPException(410, str(error)) from error
    except CommandEventMismatchError as error:
        # The credential is good; the event is not. 401 would stop the daemon.
        logger.warning(
            "Daemon node event rejected",
            sandbox_id=sandbox_id,
            event_type=event.get("type"),
            run_id=event.get("runId"),
            error=str(error),
        )
        raise HTTPException(409, str(error)) from error
    except PermissionError as error:
        logger.warning(
            "Daemon node event unauthorized", sandbox_id=sandbox_id, error=str(error)
        )
        raise HTTPException(401, str(error)) from error
    except UnknownDaemonNodeError as error:
        raise HTTPException(404, "Daemon node not found.") from error
    except Exception as error:  # noqa: BLE001 - the daemon retries a 503, so a transient store fault never loses an event
        logger.exception(
            "Daemon node event failed",
            sandbox_id=sandbox_id,
            event_type=event.get("type"),
            run_id=event.get("runId"),
        )
        raise HTTPException(503, "Event processing is temporarily unavailable.") from error
