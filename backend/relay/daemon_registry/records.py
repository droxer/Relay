"""Daemon-node and run-request record shapes: state keys, errors, and the pure
helpers that build or clean what the registry stores and sends.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from loguru import logger
from ..collaboration.models import (
    COLLABORATION_FINGERPRINT_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
)
from ..collaboration.work import (
    WORK_STATE_KEYS,
)
from ..collaboration.policy import (
    PARTICIPANT_FAILURES_STATE_KEY,
    REPAIR_COUNT_STATE_KEY,
    REPAIR_NOTE_STATE_KEY,
    REPAIR_RESUME_INDEX_STATE_KEY,
    REPORT_REMINDED_STATE_KEY,
    REPORT_REMINDER_TARGET_STATE_KEY,
    ROUND_RESULT_REJECTED_STATE_KEY,
    ROUND_RESULT_STATE_KEY,
)
from ..core.model_policy import is_model_id
from ..core.models import (
    AGENT_NAMES,
)
from ..core.daemon_capabilities import (
    DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE,
    has_capability,
)


ARTIFACT_SNAPSHOT_STATE_KEY = "_relay_artifact_snapshot"


# Person-only round sources: an answer, or a rerun/handoff.
HUMAN_ROUND_SOURCES = frozenset({"message", "recovery"})


def is_human_started_round(manifest: dict[str, Any]) -> bool:
    """Whether a person started this round, including after a lead re-plan."""
    return manifest.get("source") in HUMAN_ROUND_SOURCES or manifest.get("humanStarted") is True


# Failures starting the next assignment (or closing the round) after a turn was
# finalized: `{index, attempts, retryAt, error}`. Past the cap the thread fails.
FOLLOW_UP_FAILURE_STATE_KEY = "_relay_follow_up_failure"


# Run-request bookkeeping that has to survive being re-staged. Command state is
# filtered down to the agent-visible keys, so anything not listed here is lost
# the moment the next command is staged.
CARRIED_RUN_REQUEST_STATE_KEYS = frozenset(
    {
        *WORK_STATE_KEYS,
        "_relay_task_source_revision",
        "_relay_task_source_status",
        "_relay_task_execution_revision",
        REPAIR_COUNT_STATE_KEY,
        REPAIR_RESUME_INDEX_STATE_KEY,
        REPAIR_NOTE_STATE_KEY,
        REPORT_REMINDED_STATE_KEY,
        REPORT_REMINDER_TARGET_STATE_KEY,
        ROUND_RESULT_STATE_KEY,
        ROUND_RESULT_REJECTED_STATE_KEY,
        PARTICIPANT_FAILURES_STATE_KEY,
        FOLLOW_UP_FAILURE_STATE_KEY,
        COLLABORATION_MANIFEST_STATE_KEY,
        COLLABORATION_FINGERPRINT_STATE_KEY,
    }
)


# Mirrors ROUND_RESULT_RELATIVE_PATH in relay-daemon: `.relay/` is excluded
# from the artifact scan, so the control file never becomes a deliverable.
ROUND_RESULT_RELATIVE_PATH = ".relay/round-result.json"


TERMINAL_EVENT_STATE_KEY = "_relay_terminal_event"


TERMINAL_CLAIM_ID_STATE_KEY = "_relay_terminal_claim_id"


TERMINAL_CLAIM_EXPIRES_STATE_KEY = "_relay_terminal_claim_expires_at"


PERSISTED_AGENT_STATE_KEYS = frozenset(
    {"task_goal", "agent_logs", "last_exit_code", "agent_failures", "token_usage"}
)


DAEMON_SANDBOX_MODES = frozenset({"none", "boxlite"})


# Status of a node an admin deleted. The row survives as a tombstone so a
# daemon that is still running cannot resurrect the node by re-registering.
DAEMON_NODE_DELETED_STATUS = "deleted"


WORKSPACE_DELETE_COMMAND = "workspace.delete"


def cleanup_node_rank(node: dict[str, Any]) -> tuple[bool, bool, str]:
    """Order a computer's nodes by how soon each could run project cleanup."""
    return (
        not has_capability(node, DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE),
        not node.get("online"),
        node["id"],
    )


class UnknownDaemonNodeError(KeyError):
    """The requested node does not exist; the event cannot be accepted."""


class DeletedDaemonNodeError(Exception):
    """Raised when a daemon tries to register a node that was deleted."""


def public_sandbox_record(sandbox: dict[str, Any]) -> dict[str, Any]:
    return {
        k: v
        for k, v in sandbox.items()
        if k
        not in (
            "token",
            "tokenHash",
            "uiTokenHash",
            "nodeTokenHash",
            "nodeToken",
            "nodeTokenSecret",
            "enrollmentKey",
        )
        and v is not None
    }


def provisioned_sandbox_record(sandbox: dict[str, Any]) -> dict[str, Any]:
    public = public_sandbox_record(sandbox)
    if sandbox.get("token"):
        public["token"] = sandbox["token"]
    return public


def _confined_workspace_path(root: str, subpath: str) -> str | None:
    """Join ``subpath`` under ``root``, or ``None`` if it would escape.

    Project subpaths are server-generated today, but this value ends up as the
    root that generated-file confinement is measured against, so an absolute or
    ``..``-bearing subpath would silently widen what a daemon can index.
    """
    candidate = Path(root) / subpath
    try:
        resolved = candidate.resolve()
        root_resolved = Path(root).resolve()
    except OSError:
        return None
    if resolved != root_resolved and root_resolved not in resolved.parents:
        logger.warning(
            "rejecting workspace subpath outside the node workspace",
            root=root,
            subpath=subpath,
        )
        return None
    return str(candidate)


def _string_metadata(value: Any, limit: int = 500) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:limit] if text else None


def agent_registration_state(
    payload: dict[str, Any],
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    supported = set(payload.get("supportedAgents") or [])
    raw_health = (
        payload.get("agentHealth")
        if isinstance(payload.get("agentHealth"), dict)
        else {}
    )
    capabilities_value = payload.get("executorCapabilities")
    raw_capabilities = (
        capabilities_value if isinstance(capabilities_value, list) else []
    )
    capability_by_kind = {
        item.get("executorKind"): item
        for item in raw_capabilities
        if isinstance(item, dict) and item.get("executorKind") in AGENT_NAMES
    }
    agents: dict[str, str] = {}
    details: dict[str, dict[str, str]] = {}
    for agent in AGENT_NAMES:
        raw = capability_by_kind.get(agent) or (
            raw_health.get(agent) if isinstance(raw_health, dict) else None
        )
        status = raw.get("status") if isinstance(raw, dict) else None
        agents[agent] = (
            "failed"
            if status == "failed"
            else "ready"
            if status == "ready" or agent in supported
            else "unknown"
        )
        if isinstance(raw, dict):
            detail: dict[str, str] = {}
            for key in ("detail", "version", "adapter"):
                value = _string_metadata(raw.get(key))
                if value:
                    detail[key] = value
            if detail:
                details[agent] = detail
    return agents, details


_MCP_TRANSPORTS = ("stdio", "sse", "http")


def agent_inventory_state(
    payload: dict[str, Any],
) -> dict[str, dict[str, list[dict[str, str]]]]:
    """Sanitize the daemon-reported per-agent skill/MCP inventory.

    Untrusted daemon payload: keep only known agents and well-typed fields, and
    drop agents that report nothing so the record stays compact.
    """
    raw = payload.get("agentInventory")
    if not isinstance(raw, dict):
        return {}
    inventory: dict[str, dict[str, list[dict[str, str]]]] = {}
    for agent in AGENT_NAMES:
        entry = raw.get(agent)
        if not isinstance(entry, dict):
            continue
        skills = _clean_skills(entry.get("skills"))
        mcp_servers = _clean_mcp_servers(entry.get("mcpServers"))
        if skills or mcp_servers:
            inventory[agent] = {"skills": skills, "mcpServers": mcp_servers}
    return inventory


# Pi lists every model its configured providers serve; keep the record bounded.
MAX_REPORTED_MODELS = 200


def agent_models_state(payload: dict[str, Any]) -> dict[str, list[str]]:
    """The model ids each runtime itself reports, known agents only.

    Untrusted daemon payload: keep only ids the model policy would accept, in
    the runtime's order, deduped and capped, and drop runtimes that report none.
    """
    raw = payload.get("agentModels")
    if not isinstance(raw, dict):
        return {}
    models: dict[str, list[str]] = {}
    for agent in AGENT_NAMES:
        entries = raw.get(agent)
        if not isinstance(entries, list):
            continue
        valid = list(dict.fromkeys(entry for entry in entries if is_model_id(entry)))
        if valid:
            models[agent] = valid[:MAX_REPORTED_MODELS]
    return models


def custom_model_endpoints_state(payload: dict[str, Any]) -> list[str]:
    """Runtimes the daemon says call a custom model endpoint, known agents only."""
    raw = payload.get("customModelEndpoints")
    if not isinstance(raw, list):
        return []
    return [agent for agent in AGENT_NAMES if agent in raw]


def daemon_command_payload(record: dict[str, Any]) -> dict[str, Any]:
    return {
        **{
            key: value
            for key, value in record["command"].items()
            if not key.startswith("_")
        },
        **({"leaseId": record["leaseId"]} if record.get("leaseId") else {}),
        **(
            {"leaseExpiresAt": record["leaseExpiresAt"]}
            if record.get("leaseExpiresAt")
            else {}
        ),
        **({"attempt": record["attempt"]} if record.get("attempt") is not None else {}),
    }


def _clean_skills(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    skills: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name = _string_metadata(item.get("name"), limit=200)
        if not name:
            continue
        skill = {"name": name}
        namespace = _string_metadata(item.get("namespace"), limit=200)
        if namespace:
            skill["namespace"] = namespace
        description = _string_metadata(item.get("description"), limit=500)
        if description:
            skill["description"] = description
        skills.append(skill)
    return skills


def _clean_mcp_servers(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    servers: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name = _string_metadata(item.get("name"), limit=200)
        if not name:
            continue
        transport = item.get("transport")
        server = {
            "name": name,
            "transport": transport if transport in _MCP_TRANSPORTS else "stdio",
        }
        command = _string_metadata(item.get("command"), limit=500)
        if command:
            server["command"] = command
        servers.append(server)
    return servers


def resumable_runtime_session(
    session: dict[str, Any], assignment: dict[str, Any]
) -> str | None:
    """The runtime conversation this agent's latest run in the thread used.

    Only the same logical agent (or, for legacy runs, the same executor) may
    resume it; a different agent never inherits another's conversation.
    """
    agent_id = assignment.get("agentId")
    for run in reversed(session.get("agentRuns") or []):
        same_agent = (
            run.get("logicalAgentId") == agent_id
            if agent_id
            else run.get("agent") == assignment.get("executorKind")
        )
        if not same_agent:
            continue
        return run.get("runtimeSessionId")
    return None


def daemon_active_run(run: dict[str, Any]) -> dict[str, Any]:
    return {
        key: run[key]
        for key in (
            "commandId",
            "sessionId",
            "runId",
            "agent",
            "taskGoal",
            "workspacePath",
            "startedAt",
            "logicalAgentId",
            "placementId",
        )
        if key in run
    }
