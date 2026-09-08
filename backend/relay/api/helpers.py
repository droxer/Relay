from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import secrets
import shlex
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from fastapi import HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from loguru import logger
from starlette.requests import ClientDisconnect

from ..core.models import AGENT_NAMES
from ..daemon_registry import (
    DaemonNodeRegistry,
    sandbox_ui_token_matches,
    workspace_paths_match,
)
from ..persistence.stores import valid_agent
from ..security.auth import require_user_session
from .contract import WEB_UI_ROUTE_ROOTS

CHAT_SERVICE_EMPLOYEE_HEADER = "x-relay-employee-id"
DEFAULT_MAX_JSON_BODY_BYTES = 4 * 1024 * 1024


def max_json_body_bytes() -> int:
    raw = os.environ.get(
        "RELAY_MAX_JSON_BODY_BYTES", str(DEFAULT_MAX_JSON_BODY_BYTES)
    ).strip()
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(
            "RELAY_MAX_JSON_BODY_BYTES must be a positive integer."
        ) from error
    if value <= 0:
        raise RuntimeError("RELAY_MAX_JSON_BODY_BYTES must be a positive integer.")
    return value


def append_json_body_chunk(body: bytearray, chunk: bytes, limit: int) -> None:
    if len(chunk) > limit - len(body):
        raise HTTPException(413, f"JSON request body exceeds the {limit} byte limit.")
    body.extend(chunk)


async def json_body(request: Request) -> dict[str, Any]:
    content_type = (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    )
    if content_type and content_type != "application/json":
        raise HTTPException(415, "Content-Type must be application/json.")
    limit = max_json_body_bytes()
    content_length = request.headers.get("content-length", "").strip()
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError:
            declared_size = 0
        if declared_size > limit:
            raise HTTPException(
                413, f"JSON request body exceeds the {limit} byte limit."
            )
    try:
        body = bytearray()
        async for chunk in request.stream():
            append_json_body_chunk(body, chunk, limit)
    except ClientDisconnect as error:
        raise HTTPException(
            400, "Client disconnected while reading request body."
        ) from error
    if not body:
        return {}
    if not content_type:
        raise HTTPException(415, "Content-Type must be application/json.")
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    parts = header.split(" ", 1)
    return parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else None


def string_field(value: dict[str, Any], key: str) -> str:
    field = value.get(key)
    return field.strip() if isinstance(field, str) else ""


def raw_string_field(value: dict[str, Any], key: str) -> str:
    field = value.get(key)
    return field if isinstance(field, str) else ""


def token_usage_field(
    value: dict[str, Any], key: str = "tokenUsage"
) -> dict[str, Any] | None:
    raw = value.get(key)
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("tokenUsage must be an object.")  # noqa: TRY004 - request validation uses ValueError.
    usage = {
        "input": token_count_field(raw, "input"),
        "output": token_count_field(raw, "output"),
        "cache": token_count_field(raw, "cache"),
    }
    usage["total"] = usage["input"] + usage["output"] + usage["cache"]
    if usage["total"] == 0:
        raise ValueError("tokenUsage must include at least one reported count.")
    if "total" in raw and token_count_field(raw, "total") != usage["total"]:
        raise ValueError("tokenUsage total must equal input + output + cache.")
    if isinstance(raw.get("source"), str) and raw["source"].strip():
        usage["source"] = raw["source"].strip()
    return usage


def token_count_field(value: dict[str, Any], key: str) -> int:
    raw = value.get(key, 0)
    if (
        isinstance(raw, bool)
        or not isinstance(raw, (int, float))
        or not math.isfinite(raw)
        or raw < 0
    ):
        raise ValueError(f"tokenUsage.{key} must be a non-negative finite number.")
    return int(raw)


EMPLOYEE_HANDLE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")


def normalize_employee_handle(value: str) -> str:
    """Canonicalize an admin-entered employee handle, or raise 400.

    The handle is rendered as `@alice` and threaded through node paths and
    credential filenames, so it cannot carry whitespace, slashes, or case that
    would make two spellings look like one identity. Lowercasing here rather
    than rejecting keeps the form forgiving; the web form applies the same
    normalization as you type, so the preview never promises a handle the
    backend will not create."""
    handle = (value or "").strip().lstrip("@").strip().lower()
    if not handle:
        raise HTTPException(400, "employeeId is required.")
    if not EMPLOYEE_HANDLE_PATTERN.match(handle):
        raise HTTPException(
            400,
            "employeeId must be 2-64 characters of lowercase letters, digits, "
            "dot, dash, or underscore, and start with a letter or digit.",
        )
    return handle


def resolve_employee_id(auth_store: Any, employee_id: str) -> str:
    """The id `employee_id` resolves to in this store (a UUID under the
    database store, the handle itself under the file store)."""
    if hasattr(auth_store, "resolve_employee_id"):
        return auth_store.resolve_employee_id(employee_id)
    return (employee_id or "").strip()


def employee_record(auth_store: Any, employee_id: str) -> dict[str, Any] | None:
    if hasattr(auth_store, "list_employees"):
        for employee in auth_store.list_employees():
            if employee.get("id") == employee_id:
                return employee
    for user in auth_store.list_users():
        if user.get("employeeId") == employee_id:
            return {
                # The file store keeps the handle as the id, so the two agree.
                "id": employee_id,
                "handle": employee_id,
                "displayName": user.get("displayName")
                or user.get("username")
                or employee_id,
                "email": user.get("email"),
                "createdAt": user.get("createdAt"),
                "updatedAt": user.get("createdAt"),
            }
    return None


def backend_base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def valid_employee_workspace_path(value: str | None) -> bool:
    return bool(value) and (
        PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute()
    )


# An employee device runs its agents as host processes against the installs
# already on it. BoxLite isolation belongs to hardware an admin provisions, so
# `nodeLocation` and `sandboxMode` are not independent settings.
EMPLOYEE_DEVICE_SANDBOX_MODE = "none"


def assert_employee_device_runtime(
    node_location: str | None, sandbox_mode: str | None
) -> None:
    """Reject an employee-device node asking for the isolated runtime.

    Both the self-service enrollment route and the admin create route land on
    the same `provision_daemon_node`, which stores `sandboxMode` verbatim — so
    the pair has to be checked before it becomes a start command. Enforced here
    rather than per-route: a caller that slips through gets `--sandbox boxlite`
    with no `--use-local-agent-home`, and the daemon tries to boot a VM on a
    laptop that was never set up for one.
    """
    if node_location != "employee-device":
        return
    if sandbox_mode != EMPLOYEE_DEVICE_SANDBOX_MODE:
        raise HTTPException(
            400,
            'sandboxMode must be "none" for an employee-device computer: '
            "a personal computer runs agents directly.",
        )


def daemon_start_env(
    request: Request, node: dict[str, Any], sandbox_mode: str = "boxlite"
) -> dict[str, str]:
    env = {
        "RELAY_BACKEND_URL": backend_base_url(request),
        "RELAY_SANDBOX_ID": node["id"],
        "RELAY_SANDBOX_MODE": sandbox_mode,
    }
    # Reusing the host user's agent auth only makes sense when agents run as
    # direct execution; in boxlite mode guest provisioning handles agent auth.
    if sandbox_mode == "none":
        env["RELAY_ALLOW_HOST_AGENT_EXECUTION"] = "1"
        env["RELAY_USE_LOCAL_AGENT_HOME"] = "1"
    if node.get("employeeId"):
        env["RELAY_EMPLOYEE_ID"] = node["employeeId"]
    if node.get("nodeToken"):
        env["RELAY_DAEMON_NODE_TOKEN"] = node["nodeToken"]
    if node.get("workspacePath"):
        env["RELAY_WORKSPACE"] = node["workspacePath"]
    return env


def daemon_start_command(
    request: Request,
    node: dict[str, Any],
    sandbox_mode: str = "boxlite",
    *,
    prompt_for_token: bool = True,
) -> str:
    """The shell line that starts this node's daemon. Never carries the token.

    `prompt_for_token=False` is for a node that already enrolled: its machine
    holds the token on disk (`ensureDaemonNodeToken`), so prompting for a
    secret the reader was shown once and no longer has would strand them.
    """
    parts = [
        "relay-daemon",
        "--backend-url",
        backend_base_url(request),
        "--sandbox-id",
        node["id"],
        "--sandbox",
        sandbox_mode,
    ]
    if sandbox_mode == "none":
        parts.extend(["--allow-host-agent-execution", "--use-local-agent-home"])
    if node.get("employeeId"):
        parts.extend(["--employee-id", node["employeeId"]])
    if node.get("workspacePath"):
        parts.extend(["--workspace", node["workspacePath"]])
    command = " ".join(shlex.quote(part) for part in parts)
    if not prompt_for_token:
        return command
    return (
        "read -rsp 'Relay node token: ' RELAY_DAEMON_NODE_TOKEN && echo && "
        f"export RELAY_DAEMON_NODE_TOKEN && {command}"
    )


def get_session_or_404(store: Any, session_id: str) -> dict[str, Any]:
    try:
        session = store.get_session(session_id)
        if not session.get("id"):
            raise HTTPException(404, "Session not found.")
        return session
    except KeyError:
        raise HTTPException(404, "Session not found.")


def get_task_or_404(store: Any, task_id: str) -> dict[str, Any]:
    try:
        task = store.get_task(task_id)
        if not task.get("id"):
            raise HTTPException(404, "Task not found.")
        return task
    except KeyError:
        raise HTTPException(404, "Task not found.")


def is_workspace_artifact(artifact: dict[str, Any]) -> bool:
    return artifact.get("kind") == "workspace_file"


def workspace_artifact_key(session: dict[str, Any], artifact: dict[str, Any]) -> str:
    relative = (
        artifact.get("workspaceRelativePath")
        or artifact.get("path")
        or artifact.get("id")
    )
    return f"{session.get('workspacePath') or ''}::{relative}"


def workspace_artifacts(session: dict[str, Any]) -> list[dict[str, Any]]:
    """Generated-file artifacts for a session, newest record per file.

    A file re-generated by a later run gets a fresh artifact per change; the
    index and counts should surface each file once, at its latest state.
    """
    newest: dict[str, dict[str, Any]] = {}
    for artifact in session.get("artifacts", []):
        if not is_workspace_artifact(artifact):
            continue
        key = (
            artifact.get("workspaceRelativePath")
            or artifact.get("path")
            or artifact.get("id")
        )
        current = newest.get(key)
        if current is None or (artifact.get("createdAt") or "") >= (
            current.get("createdAt") or ""
        ):
            newest[key] = artifact
    return list(newest.values())


def artifact_index_item(
    session: dict[str, Any], artifact: dict[str, Any]
) -> dict[str, Any]:
    return {
        **artifact,
        "sessionId": session["id"],
        "sessionTitle": session.get("title"),
        "taskGoal": session.get("taskGoal"),
        "ownerEmployeeId": session.get("ownerEmployeeId"),
        "workspacePath": session.get("workspacePath"),
        "sessionUpdatedAt": session.get("updatedAt"),
    }


def request_actor(request: Request, auth_store: Any) -> dict[str, Any]:
    chat_actor = request_chat_service_actor(request)
    if chat_actor:
        return chat_actor
    user = require_user_session(request, auth_store)
    employee_id = user.get("employeeId") or user.get("username") or user["id"]
    return {
        "user": user,
        "employeeId": employee_id,
        "isAdmin": user.get("role") == "admin",
    }


def request_actor_or_none(request: Request, auth_store: Any) -> dict[str, Any] | None:
    if request.headers.get(CHAT_SERVICE_EMPLOYEE_HEADER):
        return request_chat_service_actor(request)
    try:
        return request_actor(request, auth_store)
    except HTTPException:
        return None


def request_chat_service_actor(request: Request) -> dict[str, Any] | None:
    employee_id = (request.headers.get(CHAT_SERVICE_EMPLOYEE_HEADER) or "").strip()
    if not employee_id:
        return None
    expected = os.environ.get("RELAY_CHAT_TOKEN", "").strip()
    if not expected:
        raise HTTPException(503, "RELAY_CHAT_TOKEN is not configured.")
    token = bearer_token(request)
    if (
        not token
        or len(token) != len(expected)
        or not secrets.compare_digest(token, expected)
    ):
        raise HTTPException(401, "Invalid chat service token.")
    return {
        "user": {
            "id": f"chat:{employee_id}",
            "username": employee_id,
            "employeeId": employee_id,
            "role": "user",
        },
        "employeeId": employee_id,
        "isAdmin": False,
    }


def require_chat_service_request(request: Request) -> None:
    expected = os.environ.get("RELAY_CHAT_TOKEN", "").strip()
    if not expected:
        raise HTTPException(503, "RELAY_CHAT_TOKEN is not configured.")
    token = bearer_token(request)
    if (
        not token
        or len(token) != len(expected)
        or not secrets.compare_digest(token, expected)
    ):
        raise HTTPException(401, "Invalid chat service token.")


def request_actor_or_sandbox(
    request: Request, auth_store: Any, registry: DaemonNodeRegistry
) -> dict[str, Any]:
    actor = request_actor_or_none(request, auth_store)
    if actor:
        return actor
    token = bearer_token(request)
    sandbox = authorized_sandbox_for_token(registry, token)
    employee_id = sandbox.get("employeeId") if sandbox else None
    if isinstance(employee_id, str) and employee_id:
        return {
            "user": {
                "id": f"sandbox:{sandbox['id']}",
                "username": employee_id,
                "employeeId": employee_id,
                "role": "user",
            },
            "employeeId": employee_id,
            "isAdmin": False,
        }
    if token:
        raise HTTPException(401, "Invalid sandbox token.")
    return request_actor(request, auth_store)


def owner_employee_id_for_create(actor: dict[str, Any], body: dict[str, Any]) -> str:
    requested = string_field(body, "ownerEmployeeId") or string_field(
        body, "employeeId"
    )
    if actor["isAdmin"] and requested:
        return requested
    return actor["employeeId"]


def assignee_employee_id_for_task(
    actor: dict[str, Any], body: dict[str, Any], fallback: str | None = None
) -> str:
    requested = string_field(body, "assigneeEmployeeId") or string_field(
        body, "assignee_employee_id"
    )
    if actor["isAdmin"] and requested:
        return requested
    if requested and requested == actor["employeeId"]:
        return requested
    return fallback or actor["employeeId"]


def actor_can_access_record(actor: dict[str, Any], record: dict[str, Any]) -> bool:
    if actor["isAdmin"]:
        return True
    return (
        record.get("ownerEmployeeId") == actor["employeeId"]
        or record.get("assigneeEmployeeId") == actor["employeeId"]
    )


def actor_can_access_sandbox(actor: dict[str, Any], sandbox: dict[str, Any]) -> bool:
    if actor["isAdmin"]:
        return True
    return sandbox.get("employeeId") == actor["employeeId"]


def get_session_for_actor(
    store: Any, session_id: str, actor: dict[str, Any]
) -> dict[str, Any]:
    session = get_session_or_404(store, session_id)
    if not actor_can_access_record(actor, session):
        raise HTTPException(403, "Session access denied.")
    return session


def get_session_header_for_actor(
    store: Any, session_id: str, actor: dict[str, Any]
) -> dict[str, Any]:
    try:
        session = store.get_session_header(session_id)
    except KeyError:
        raise HTTPException(404, "Session not found.")
    if not session.get("id"):
        raise HTTPException(404, "Session not found.")
    if not actor_can_access_record(actor, session):
        raise HTTPException(403, "Session access denied.")
    return session


def get_task_for_actor(
    store: Any, task_id: str, actor: dict[str, Any]
) -> dict[str, Any]:
    task = get_task_or_404(store, task_id)
    if task.get("deletedAt"):
        raise HTTPException(404, "Task not found.")
    if not actor_can_access_record(actor, task):
        raise HTTPException(403, "Task access denied.")
    return task


def assignment_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        if not isinstance(item, dict):
            continue
        agent = valid_agent(item.get("agent"))
        if not agent:
            continue
        result.append(
            {
                "agent": agent,
                **(
                    {"agentId": item["agentId"]}
                    if isinstance(item.get("agentId"), str) and item["agentId"]
                    else {}
                ),
                **({"role": item["role"]} if role_name(item.get("role")) else {}),
                **(
                    {"brief": item["brief"].strip()[:4000]}
                    if isinstance(item.get("brief"), str) and item["brief"].strip()
                    else {}
                ),
            }
        )
    return result


def participants_for_assignments(
    assignments: Any, assigned_agent: str | None
) -> list[str]:
    agents = [assignment["agent"] for assignment in assignment_list(assignments)]
    if assigned_agent:
        agents.append(assigned_agent)
    return list(dict.fromkeys(["human", *agents]))


def role_name(value: Any) -> str | None:
    return (
        value
        if value in ("implementer", "reviewer", "planner", "tester", "fixer")
        else None
    )


def authorized_sandbox_for_token(
    registry: DaemonNodeRegistry, token: str | None
) -> dict[str, Any] | None:
    if not token:
        return None
    return next(
        (
            sandbox
            for sandbox in registry.list_ready()
            if sandbox_ui_token_matches(sandbox, token)
        ),
        None,
    )


def session_belongs_to_sandbox(
    session: dict[str, Any], sandbox: dict[str, Any]
) -> bool:
    return not sandbox.get("workspacePath") or workspace_paths_match(
        session.get("workspacePath"), sandbox.get("workspacePath")
    )


def daemon_node_event(value: dict[str, Any]) -> dict[str, Any]:
    event_type = string_field(value, "type")
    command_id = string_field(value, "commandId")
    if event_type in {"workspace.listing", "workspace.file", "workspace.error"}:
        agent_id = string_field(value, "agentId")
        path = string_field(value, "path")
        if not command_id:
            raise ValueError("workspace event requires commandId.")
        lease_id = string_field(value, "leaseId")
        common = {
            "type": event_type,
            "commandId": command_id,
            **({"leaseId": lease_id} if lease_id else {}),
            **({"agentId": agent_id} if agent_id else {}),
            "path": path,
        }
        if event_type == "workspace.listing":
            entries = value.get("entries")
            if not isinstance(value.get("exists"), bool) or not isinstance(
                entries, list
            ):
                raise ValueError("invalid daemon workspace.listing event.")
            return {**common, "exists": value["exists"], "entries": entries}
        if event_type == "workspace.file":
            if (
                not isinstance(value.get("bytes"), (int, float))
                or not isinstance(value.get("isBinary"), bool)
                or not isinstance(value.get("truncated"), bool)
            ):
                raise ValueError("invalid daemon workspace.file event.")
            return {
                **common,
                "bytes": int(value["bytes"]),
                "isBinary": value["isBinary"],
                "truncated": value["truncated"],
                **(
                    {"contentBase64": value["contentBase64"]}
                    if isinstance(value.get("contentBase64"), str)
                    else {}
                ),
            }
        code = string_field(value, "code")
        if code not in {"invalid-path", "not-found", "is-directory", "io-error"}:
            raise ValueError("invalid daemon workspace.error event.")
        return {**common, "code": code, "message": string_field(value, "message")}
    session_id = string_field(value, "sessionId")
    run_id = string_field(value, "runId")
    agent = valid_agent(value.get("agent"))
    if not command_id or not session_id or not run_id or not agent:
        raise ValueError(
            "daemon node event requires commandId, sessionId, runId, and agent."
        )
    lease_id = string_field(value, "leaseId")
    lease_field = {"leaseId": lease_id} if lease_id else {}
    if event_type == "run.output":
        if (
            value.get("stream") not in ("stdout", "stderr")
            or not isinstance(value.get("sequence"), (int, float))
            or not isinstance(value.get("text"), str)
        ):
            raise ValueError("invalid daemon node run.output event.")
        return {
            "type": event_type,
            "commandId": command_id,
            **lease_field,
            "sessionId": session_id,
            "runId": run_id,
            "agent": agent,
            "stream": value["stream"],
            "text": value["text"],
            "sequence": int(value["sequence"]),
        }
    if event_type == "run.output.batch":
        raw_entries = value.get("entries")
        if (
            not isinstance(raw_entries, list)
            or not raw_entries
            or len(raw_entries) > 1024
        ):
            raise ValueError("invalid daemon node run.output.batch event.")
        entries: list[dict[str, Any]] = []
        total_text = 0
        for raw_entry in raw_entries:
            if (
                not isinstance(raw_entry, dict)
                or raw_entry.get("stream") not in ("stdout", "stderr")
                or not isinstance(raw_entry.get("sequence"), (int, float))
                or not isinstance(raw_entry.get("text"), str)
            ):
                raise ValueError("invalid daemon node run.output.batch entry.")
            total_text += len(raw_entry["text"])
            if total_text > 512 * 1024:
                raise ValueError("daemon node run.output.batch text is too large.")
            entries.append(
                {
                    "stream": raw_entry["stream"],
                    "text": raw_entry["text"],
                    "sequence": int(raw_entry["sequence"]),
                }
            )
        return {
            "type": event_type,
            "commandId": command_id,
            **lease_field,
            "sessionId": session_id,
            "runId": run_id,
            "agent": agent,
            "entries": entries,
        }
    if event_type == "run.collaboration":
        collaboration = value.get("collaboration")
        if not isinstance(collaboration, dict) or not isinstance(
            value.get("sequence"), (int, float)
        ):
            raise ValueError("invalid daemon node run.collaboration event.")
        tool = collaboration.get("tool")
        status = collaboration.get("status")
        receiver_ids = collaboration.get("receiverThreadIds")
        agent_states = collaboration.get("agentsStates")
        if (
            tool not in {"spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"}
            or status not in {"inProgress", "completed", "failed"}
            or not string_field(collaboration, "id")
            or not string_field(collaboration, "senderThreadId")
            or not isinstance(receiver_ids, list)
            or len(receiver_ids) > 64
            or any(not isinstance(item, str) or not item for item in receiver_ids)
            or not isinstance(agent_states, dict)
            or len(agent_states) > 64
        ):
            raise ValueError("invalid daemon node collaboration payload.")
        normalized_states: dict[str, dict[str, str | None]] = {}
        for thread_id, state in agent_states.items():
            if (
                not isinstance(thread_id, str)
                or not thread_id
                or not isinstance(state, dict)
            ):
                raise ValueError("invalid daemon node collaboration agent state.")
            agent_status = state.get("status")
            if agent_status not in {
                "pendingInit",
                "running",
                "interrupted",
                "completed",
                "errored",
                "shutdown",
                "notFound",
            }:
                raise ValueError("invalid daemon node collaboration agent status.")
            message = state.get("message")
            if message is not None and not isinstance(message, str):
                raise ValueError("invalid daemon node collaboration agent message.")
            normalized_states[thread_id] = {"status": agent_status, "message": message}
        return {
            "type": event_type,
            "commandId": command_id,
            **lease_field,
            "sessionId": session_id,
            "runId": run_id,
            "agent": agent,
            "sequence": int(value["sequence"]),
            "collaboration": {
                "id": string_field(collaboration, "id"),
                "tool": tool,
                "status": status,
                "senderThreadId": string_field(collaboration, "senderThreadId"),
                "receiverThreadIds": receiver_ids,
                "prompt": collaboration.get("prompt")
                if isinstance(collaboration.get("prompt"), str)
                else None,
                "model": collaboration.get("model")
                if isinstance(collaboration.get("model"), str)
                else None,
                "reasoningEffort": collaboration.get("reasoningEffort")
                if isinstance(collaboration.get("reasoningEffort"), str)
                else None,
                "agentsStates": normalized_states,
            },
        }
    if event_type == "run.completed":
        if not isinstance(value.get("exitCode"), (int, float)):
            raise ValueError(
                "daemon node run.completed exitCode must be a finite number."
            )
        # Usage counts are telemetry riding along on the one terminal event a
        # daemon sends. Rejecting the event over them strands the run: the
        # daemon drops the report, the session stays "running", and — runs
        # being exclusive per node — the node refuses every later dispatch
        # until the run timeout reaps it. Drop the counts, keep the run.
        try:
            token_usage = token_usage_field(value)
        except ValueError as error:
            logger.warning(
                "Discarded unusable daemon token usage",
                session_id=session_id,
                run_id=run_id,
                error=str(error),
            )
            token_usage = None
        # Passed through raw; the registry sanitizes each entry (path
        # confinement, extension allowlist, content caps) before indexing.
        generated_files = value.get("generatedFiles")
        # Passed through raw; collaboration policy validates the aggregate
        # verdict before it can affect task state.
        round_result = value.get("roundResult")
        return {
            "type": event_type,
            "commandId": command_id,
            **lease_field,
            "sessionId": session_id,
            "runId": run_id,
            "agent": agent,
            "exitCode": int(value["exitCode"]),
            "agentLog": raw_string_field(value, "agentLog"),
            **({"tokenUsage": token_usage} if token_usage else {}),
            **(
                {"generatedFiles": generated_files}
                if isinstance(generated_files, list)
                else {}
            ),
            **(
                {"roundResult": round_result}
                if isinstance(round_result, dict)
                else {}
            ),
        }
    if event_type == "run.failed":
        # An agent process may finish successfully and write deliverables even
        # when delivery of its live output fails. The registry sanitizes these
        # reports before indexing them, exactly as for run.completed.
        generated_files = value.get("generatedFiles")
        return {
            "type": event_type,
            "commandId": command_id,
            **lease_field,
            "sessionId": session_id,
            "runId": run_id,
            "agent": agent,
            "error": string_field(value, "error") or "Daemon node command failed.",
            **(
                {"agentLog": raw_string_field(value, "agentLog")}
                if isinstance(value.get("agentLog"), str)
                else {}
            ),
            **(
                {"exitCode": int(value["exitCode"])}
                if isinstance(value.get("exitCode"), (int, float))
                else {}
            ),
            **(
                {"generatedFiles": generated_files}
                if isinstance(generated_files, list)
                else {}
            ),
        }
    if event_type == "run.cancelled":
        return {
            "type": event_type,
            "commandId": command_id,
            **lease_field,
            "sessionId": session_id,
            "runId": run_id,
            "agent": agent,
            "reason": string_field(value, "reason") or "Cancelled by human.",
        }
    raise ValueError(f"unknown daemon node event type {event_type}.")


def web_ui_asset_response(asset_path: str) -> Response:
    candidates = [
        os.environ.get("RELAY_WEB_UI_DIST_DIR"),
        str(Path.cwd() / "web" / "out"),
        str(Path(__file__).resolve().parents[2] / "web" / "out"),
    ]
    dist = next(
        (Path(path) for path in candidates if path and Path(path).is_dir()), None
    )
    if not dist:
        return HTMLResponse(
            "Relay web UI has not been built. Run `npm run build -w web`.\n",
            status_code=404,
        )
    requested = asset_path or "index.html"
    asset = (dist / requested).resolve()
    confined = asset.is_relative_to(dist.resolve())
    if not confined or not asset.exists() or not asset.is_file():
        root = asset_path.split("/", 1)[0]
        # A pathname with a file suffix is an asset request, never a client
        # route. Do not turn missing scripts/styles/images into successful HTML.
        if root not in WEB_UI_ROUTE_ROOTS or Path(asset_path).suffix:
            return JSONResponse({"detail": "Not found."}, status_code=404)
        asset = dist / "index.html"
    if not asset.exists():
        return JSONResponse({"error": "Web UI asset not found."}, status_code=404)
    content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
    return Response(asset.read_bytes(), media_type=content_type)


def agent_names_message(field: str) -> str:
    return f"{field} must be one of: {', '.join(AGENT_NAMES)}."
