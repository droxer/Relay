"""Parsing and validation of the events a daemon posts about its runs."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from loguru import logger
from ...core.permission_requests import (
    PERMISSION_WITHDRAW_REASON_MAX_CHARS,
    is_permission_request_id,
    parse_permission_request,
)
from ...persistence.validation import valid_agent
from ..bodies import raw_string_field, string_field, token_usage_field


RUNTIME_SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _runtime_session_field(value: dict[str, Any]) -> dict[str, Any]:
    """A runtime CLI's conversation id, kept only if it is a plain id: it is
    later placed on a command line to resume that conversation."""
    session_id = value.get("runtimeSessionId")
    if isinstance(session_id, str) and RUNTIME_SESSION_ID.match(session_id):
        return {"runtimeSessionId": session_id}
    return {}


WORKSPACE_ERROR_CODES = frozenset(
    {
        "invalid-path",
        "not-found",
        "is-directory",
        "io-error",
        # A `workspace.link` refusal (see `DaemonProjectLinkErrorCode`).
        "not-directory",
        "not-allowed",
        "not-writable",
        "protected",
    }
)


EventFields = dict[str, Any]
WorkspaceParser = Callable[[dict[str, Any]], EventFields]
RunParser = Callable[[dict[str, Any], EventFields], EventFields]

OUTPUT_STREAMS = ("stdout", "stderr")
OUTPUT_BATCH_MAX_ENTRIES = 1024
OUTPUT_BATCH_MAX_TEXT = 512 * 1024
COLLABORATION_TOOLS = frozenset({"spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"})
COLLABORATION_STATUSES = frozenset({"inProgress", "completed", "failed"})
COLLABORATION_AGENT_STATUSES = frozenset(
    {
        "pendingInit",
        "running",
        "interrupted",
        "completed",
        "errored",
        "shutdown",
        "notFound",
    }
)
COLLABORATION_MAX_THREADS = 64
BLOCKING_SESSION_ID_MAX = 200
# (key, max length) for a skipped skill; `slug` is the one optional key.
SKILL_SKIP_LIMITS = (("skillId", 256), ("slug", 512), ("reason", 200))
# Events a daemon may re-send from its outbox, flagged `replayed`.
REPLAYABLE_EVENTS = frozenset({"run.output", "run.output.batch", "run.collaboration"})


def daemon_node_event(value: dict[str, Any]) -> dict[str, Any]:
    event_type = string_field(value, "type")
    command_id = string_field(value, "commandId")
    workspace_parser = WORKSPACE_PARSERS.get(event_type)
    if workspace_parser is not None:
        common = _workspace_envelope(value, event_type, command_id)
        return {**common, **workspace_parser(value)}
    envelope = _run_envelope(value, event_type, command_id)
    run_parser = RUN_PARSERS.get(event_type)
    if run_parser is None:
        raise ValueError(f"unknown daemon node event type {event_type}.")
    return {**envelope, **run_parser(value, envelope)}


# --- Shared envelopes -------------------------------------------------------


def _lease_field(value: dict[str, Any]) -> EventFields:
    lease_id = string_field(value, "leaseId")
    return {"leaseId": lease_id} if lease_id else {}


def _workspace_envelope(value: dict[str, Any], event_type: str, command_id: str) -> EventFields:
    agent_id = string_field(value, "agentId")
    path = string_field(value, "path")
    if not command_id:
        raise ValueError("workspace event requires commandId.")
    return {
        "type": event_type,
        "commandId": command_id,
        **_lease_field(value),
        **({"agentId": agent_id} if agent_id else {}),
        "path": path,
    }


def _run_envelope(value: dict[str, Any], event_type: str, command_id: str) -> EventFields:
    session_id = string_field(value, "sessionId")
    run_id = string_field(value, "runId")
    agent = valid_agent(value.get("agent"))
    if not command_id or not session_id or not run_id or not agent:
        raise ValueError("daemon node event requires commandId, sessionId, runId, and agent.")
    replayed = event_type in REPLAYABLE_EVENTS and value.get("replayed") is True
    return {
        "type": event_type,
        "commandId": command_id,
        **_lease_field(value),
        **({"replayed": True} if replayed else {}),
        "sessionId": session_id,
        "runId": run_id,
        "agent": agent,
    }


# --- Workspace responses ----------------------------------------------------


def _workspace_deleted(value: dict[str, Any]) -> EventFields:
    return {}


def _workspace_linked(value: dict[str, Any]) -> EventFields:
    host_path = string_field(value, "hostPath")
    if not host_path:
        raise ValueError("invalid daemon workspace.linked event.")
    return {"hostPath": host_path}


def _workspace_listing(value: dict[str, Any]) -> EventFields:
    entries = value.get("entries")
    if not isinstance(value.get("exists"), bool) or not isinstance(entries, list):
        raise ValueError("invalid daemon workspace.listing event.")
    return {"exists": value["exists"], "entries": entries}


def _workspace_file(value: dict[str, Any]) -> EventFields:
    if (
        not isinstance(value.get("bytes"), (int, float))
        or not isinstance(value.get("isBinary"), bool)
        or not isinstance(value.get("truncated"), bool)
    ):
        raise ValueError("invalid daemon workspace.file event.")
    content = value.get("contentBase64")
    return {
        "bytes": int(value["bytes"]),
        "isBinary": value["isBinary"],
        "truncated": value["truncated"],
        **({"contentBase64": content} if isinstance(content, str) else {}),
    }


def _workspace_error(value: dict[str, Any]) -> EventFields:
    code = string_field(value, "code")
    if code not in WORKSPACE_ERROR_CODES:
        raise ValueError("invalid daemon workspace.error event.")
    return {"code": code, "message": string_field(value, "message")}


WORKSPACE_PARSERS: dict[str, WorkspaceParser] = {
    "workspace.listing": _workspace_listing,
    "workspace.file": _workspace_file,
    "workspace.error": _workspace_error,
    "workspace.deleted": _workspace_deleted,
    "workspace.linked": _workspace_linked,
}


# --- Run lifecycle ----------------------------------------------------------


def _skill_skip(item: Any) -> dict[str, str]:
    if not isinstance(item, dict):
        raise ValueError(  # noqa: TRY004 - request validation uses ValueError.
            "invalid run.executing skillsSkipped entry."
        )
    normalized = {}
    for key, limit in SKILL_SKIP_LIMITS:
        if key == "slug" and key not in item:
            continue
        field = item.get(key)
        if not isinstance(field, str) or not field.strip() or len(field) > limit:
            raise ValueError("invalid run.executing skillsSkipped entry.")
        normalized[key] = field.strip()
    return normalized


def _run_executing(value: dict[str, Any], envelope: EventFields) -> EventFields:
    raw_skips = value.get("skillsSkipped", [])
    if not isinstance(raw_skips, list):
        raise ValueError("invalid run.executing skillsSkipped.")
    skills_skipped = [_skill_skip(item) for item in raw_skips]
    return {"skillsSkipped": skills_skipped} if skills_skipped else {}


def _run_exit_unconfirmed(value: dict[str, Any], envelope: EventFields) -> EventFields:
    return {}


def _run_workspace(value: dict[str, Any], envelope: EventFields) -> EventFields:
    if not isinstance(value.get("waiting"), bool):
        raise ValueError("invalid daemon workspace wait state.")
    blocker = value.get("blockingSessionId")
    if blocker is not None and (not isinstance(blocker, str) or len(blocker) > BLOCKING_SESSION_ID_MAX):
        raise ValueError("invalid blocking session id.")
    return {
        "waiting": value["waiting"],
        **({"blockingSessionId": blocker} if blocker else {}),
    }


def _run_permission_requested(value: dict[str, Any], envelope: EventFields) -> EventFields:
    return {"request": parse_permission_request(value.get("request"))}


def _run_permission_withdrawn(value: dict[str, Any], envelope: EventFields) -> EventFields:
    request_id = value.get("requestId")
    if not is_permission_request_id(request_id):
        raise ValueError("invalid permission request id.")
    reason = string_field(value, "reason")[:PERMISSION_WITHDRAW_REASON_MAX_CHARS]
    return {"requestId": request_id, "reason": reason or "The run stopped waiting for an answer."}


def _is_output_entry(entry: Any) -> bool:
    return (
        isinstance(entry, dict)
        and entry.get("stream") in OUTPUT_STREAMS
        and isinstance(entry.get("sequence"), (int, float))
        and isinstance(entry.get("text"), str)
    )


def _output_entry(entry: dict[str, Any]) -> EventFields:
    return {
        "stream": entry["stream"],
        "text": entry["text"],
        "sequence": int(entry["sequence"]),
    }


def _run_output(value: dict[str, Any], envelope: EventFields) -> EventFields:
    if not _is_output_entry(value):
        raise ValueError("invalid daemon node run.output event.")
    return _output_entry(value)


def _run_output_batch(value: dict[str, Any], envelope: EventFields) -> EventFields:
    raw_entries = value.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries or len(raw_entries) > OUTPUT_BATCH_MAX_ENTRIES:
        raise ValueError("invalid daemon node run.output.batch event.")
    entries: list[dict[str, Any]] = []
    total_text = 0
    for raw_entry in raw_entries:
        if not _is_output_entry(raw_entry):
            raise ValueError("invalid daemon node run.output.batch entry.")
        total_text += len(raw_entry["text"])
        if total_text > OUTPUT_BATCH_MAX_TEXT:
            raise ValueError("daemon node run.output.batch text is too large.")
        entries.append(_output_entry(raw_entry))
    return {"entries": entries}


def _is_collaboration_payload(collaboration: dict[str, Any]) -> bool:
    receiver_ids = collaboration.get("receiverThreadIds")
    agent_states = collaboration.get("agentsStates")
    return (
        collaboration.get("tool") in COLLABORATION_TOOLS
        and collaboration.get("status") in COLLABORATION_STATUSES
        and bool(string_field(collaboration, "id"))
        and bool(string_field(collaboration, "senderThreadId"))
        and isinstance(receiver_ids, list)
        and len(receiver_ids) <= COLLABORATION_MAX_THREADS
        and all(isinstance(item, str) and item for item in receiver_ids)
        and isinstance(agent_states, dict)
        and len(agent_states) <= COLLABORATION_MAX_THREADS
    )


def _collaboration_agent_states(
    agent_states: dict[Any, Any],
) -> dict[str, dict[str, str | None]]:
    normalized: dict[str, dict[str, str | None]] = {}
    for thread_id, state in agent_states.items():
        if not isinstance(thread_id, str) or not thread_id or not isinstance(state, dict):
            raise ValueError("invalid daemon node collaboration agent state.")
        agent_status = state.get("status")
        if agent_status not in COLLABORATION_AGENT_STATUSES:
            raise ValueError("invalid daemon node collaboration agent status.")
        message = state.get("message")
        if message is not None and not isinstance(message, str):
            raise ValueError("invalid daemon node collaboration agent message.")
        normalized[thread_id] = {"status": agent_status, "message": message}
    return normalized


def _optional_str(value: dict[str, Any], key: str) -> str | None:
    field = value.get(key)
    return field if isinstance(field, str) else None


def _run_collaboration(value: dict[str, Any], envelope: EventFields) -> EventFields:
    collaboration = value.get("collaboration")
    if not isinstance(collaboration, dict) or not isinstance(value.get("sequence"), (int, float)):
        raise ValueError("invalid daemon node run.collaboration event.")
    if not _is_collaboration_payload(collaboration):
        raise ValueError("invalid daemon node collaboration payload.")
    states = _collaboration_agent_states(collaboration["agentsStates"])
    return {
        "sequence": int(value["sequence"]),
        "collaboration": {
            "id": string_field(collaboration, "id"),
            "tool": collaboration["tool"],
            "status": collaboration["status"],
            "senderThreadId": string_field(collaboration, "senderThreadId"),
            "receiverThreadIds": collaboration["receiverThreadIds"],
            "prompt": _optional_str(collaboration, "prompt"),
            "model": _optional_str(collaboration, "model"),
            "reasoningEffort": _optional_str(collaboration, "reasoningEffort"),
            "agentsStates": states,
        },
    }


# --- Terminal events --------------------------------------------------------


def _usage_field(value: dict[str, Any], envelope: EventFields) -> EventFields:
    # Every terminal event may carry the usage the process reported.
    token_usage = _terminal_token_usage(value, envelope["sessionId"], envelope["runId"])
    return {"tokenUsage": token_usage} if token_usage else {}


def _optional_agent_log(value: dict[str, Any]) -> EventFields:
    if isinstance(value.get("agentLog"), str):
        return {"agentLog": raw_string_field(value, "agentLog")}
    return {}


def _if_instance(value: dict[str, Any], key: str, kind: type) -> EventFields:
    field = value.get(key)
    return {key: field} if isinstance(field, kind) else {}


def _run_completed(value: dict[str, Any], envelope: EventFields) -> EventFields:
    usage = _usage_field(value, envelope)
    if not isinstance(value.get("exitCode"), (int, float)):
        raise ValueError("daemon node run.completed exitCode must be a finite number.")
    return {
        "exitCode": int(value["exitCode"]),
        "agentLog": raw_string_field(value, "agentLog"),
        **usage,
        # Passed through raw; the registry sanitizes each entry (path
        # confinement, extension allowlist, content caps) before indexing.
        **_if_instance(value, "generatedFiles", list),
        # Passed through raw; collaboration policy validates the aggregate
        # verdict before it can affect task state.
        **_if_instance(value, "roundResult", dict),
        # Passed through raw; the registry bounds it (core/next_steps.py).
        **_if_instance(value, "nextSteps", list),
        **({"outputTruncated": True} if value.get("outputTruncated") is True else {}),
        **_runtime_session_field(value),
        # Passed through raw; project_setup.normalize_setup_proposal holds it
        # to the shape the project PATCH accepts before it is recorded.
        **_if_instance(value, "projectSetup", dict),
    }


def _run_failed(value: dict[str, Any], envelope: EventFields) -> EventFields:
    usage = _usage_field(value, envelope)
    exit_code = value.get("exitCode")
    return {
        "error": string_field(value, "error") or "Daemon node command failed.",
        **_runtime_session_field(value),
        **_optional_agent_log(value),
        **({"exitCode": int(exit_code)} if isinstance(exit_code, (int, float)) else {}),
        **usage,
        # An agent process may finish successfully and write deliverables
        # even when delivery of its live output fails. The registry sanitizes
        # these reports before indexing them, exactly as for run.completed.
        **_if_instance(value, "generatedFiles", list),
    }


def _run_cancelled(value: dict[str, Any], envelope: EventFields) -> EventFields:
    usage = _usage_field(value, envelope)
    return {
        "reason": string_field(value, "reason") or "Cancelled by human.",
        **_runtime_session_field(value),
        **_optional_agent_log(value),
        **usage,
    }


RUN_PARSERS: dict[str, RunParser] = {
    "run.executing": _run_executing,
    "run.exit_unconfirmed": _run_exit_unconfirmed,
    "run.workspace": _run_workspace,
    "run.permission_requested": _run_permission_requested,
    "run.permission_withdrawn": _run_permission_withdrawn,
    "run.output": _run_output,
    "run.output.batch": _run_output_batch,
    "run.collaboration": _run_collaboration,
    "run.completed": _run_completed,
    "run.failed": _run_failed,
    "run.cancelled": _run_cancelled,
}


def _terminal_token_usage(value: dict[str, Any], session_id: str, run_id: str) -> dict[str, Any] | None:
    # Usage counts are telemetry riding along on the one terminal event a
    # daemon sends. Rejecting the event over them strands the run: the
    # daemon drops the report, the session stays "running", and — runs
    # being exclusive per node — the node refuses every later dispatch
    # until the run timeout reaps it. Drop the counts, keep the run.
    try:
        return token_usage_field(value)
    except ValueError as error:
        logger.warning(
            "Discarded unusable daemon token usage",
            session_id=session_id,
            run_id=run_id,
            error=str(error),
        )
        return None
