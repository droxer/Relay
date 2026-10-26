"""Mapping daemon nodes, commands, runs, run requests, and events to and from
their database rows.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any
from sqlalchemy import (
    func,
)
from ..db_time import format_db_time, parse_db_time, require_db_time
from ...core.ids import new_database_id


def node_to_row(
    node: dict[str, Any], *, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or node["id"],
        "user_id": node.get("userId"),
        "display_name": node.get("displayName"),
        "workspace_path": node.get("workspacePath"),
        "workspace_id": node.get("workspaceId"),
        "enrollment_key": node.get("enrollmentKey"),
        "sandbox_mode": node.get("sandboxMode"),
        "node_location": node.get("nodeLocation"),
        "managed_node_id": node.get("managedNodeId"),
        "provisioning_attempt_id": node.get("provisioningAttemptId"),
        "credential_version": int(node.get("credentialVersion") or 1),
        "retired_at": parse_db_time(node.get("retiredAt")),
        "status": node["status"],
        "capabilities": node.get("capabilities") or [],
        # The per-agent maps live in daemon_node_agents; see node_agent_rows.
        "max_concurrent_runs": int(node.get("maxConcurrentRuns") or 1),
        # Hashes authenticate; the secret (control-panel nodes only) lets the
        # owner reveal the token again. Managed nodes persist neither.
        "ui_token_hash": node.get("uiTokenHash"),
        "node_token_hash": node.get("nodeTokenHash"),
        "node_token_secret": None,
        "last_error": node.get("lastError"),
        "host_os": node.get("hostOs"),
        "created_at": parse_db_time(node["createdAt"]),
        "updated_at": parse_db_time(node["updatedAt"]),
        "last_seen_at": parse_db_time(node.get("lastSeenAt")),
        "last_poll_at": parse_db_time(node.get("lastPollAt")),
    }


def _node_agent_identity(row: Any) -> tuple[Any, ...]:
    """Comparable form of a daemon_node_agents row.

    Normalizes across the two sides being compared: values built in Python and
    values read back from the database, where `details` is a re-parsed mapping
    and `disabled` may arrive as 0/1.
    """
    details = row["details"]
    return (
        row["agent"],
        row["status"],
        json.dumps(details, sort_keys=True) if details is not None else None,
        bool(row["disabled"]),
        row["role_default"] or None,
        row["role_override"] or None,
    )


def node_agent_rows(node: dict[str, Any], node_pk: str) -> list[dict[str, Any]]:
    """Flatten a node's five per-agent maps into daemon_node_agents rows."""
    statuses = node.get("agents") or {}
    details = node.get("agentDetails") or {}
    disabled = set(node.get("disabledAgents") or [])
    role_defaults = node.get("agentRoleDefaults") or {}
    role_overrides = node.get("agentRoleOverrides") or {}
    names = (
        set(statuses)
        | set(details)
        | disabled
        | set(role_defaults)
        | set(role_overrides)
    )
    return [
        {
            "node_id": node_pk,
            "agent": agent,
            "status": statuses.get(agent) or "unknown",
            "details": details.get(agent),
            "disabled": agent in disabled,
            "role_default": role_defaults.get(agent),
            "role_override": role_overrides.get(agent),
        }
        for agent in sorted(names)
    ]


def apply_node_agents(node: dict[str, Any], rows: list[Any]) -> dict[str, Any]:
    """Rebuild the per-agent keys on a node from its daemon_node_agents rows.

    Keys stay absent rather than empty, matching what the JSON columns produced,
    so callers and stored payloads keep the same shape.
    """
    statuses: dict[str, Any] = {}
    details: dict[str, Any] = {}
    disabled: list[str] = []
    role_defaults: dict[str, str] = {}
    role_overrides: dict[str, str] = {}
    for row in rows:
        agent = row["agent"]
        statuses[agent] = row["status"]
        if row.get("details") is not None:
            details[agent] = row["details"]
        if row.get("disabled"):
            disabled.append(agent)
        if row.get("role_default"):
            role_defaults[agent] = row["role_default"]
        if row.get("role_override"):
            role_overrides[agent] = row["role_override"]
    return {
        **node,
        "agents": statuses,
        **({"agentDetails": details} if details else {}),
        **({"disabledAgents": sorted(disabled)} if disabled else {}),
        **({"agentRoleDefaults": role_defaults} if role_defaults else {}),
        **({"agentRoleOverrides": role_overrides} if role_overrides else {}),
    }


def row_to_node(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        **({"userId": row["user_id"]} if row.get("user_id") else {}),
        **({"displayName": row["display_name"]} if row.get("display_name") else {}),
        **(
            {"workspacePath": row["workspace_path"]}
            if row.get("workspace_path")
            else {}
        ),
        **({"workspaceId": row["workspace_id"]} if row.get("workspace_id") else {}),
        **(
            {"enrollmentKey": row["enrollment_key"]}
            if row.get("enrollment_key")
            else {}
        ),
        **({"sandboxMode": row["sandbox_mode"]} if row.get("sandbox_mode") else {}),
        **({"nodeLocation": row["node_location"]} if row.get("node_location") else {}),
        **(
            {"managedNodeId": row["managed_node_id"]}
            if row.get("managed_node_id")
            else {}
        ),
        **(
            {"provisioningAttemptId": row["provisioning_attempt_id"]}
            if row.get("provisioning_attempt_id")
            else {}
        ),
        "credentialVersion": int(row.get("credential_version") or 1),
        **(
            {"retiredAt": format_db_time(row["retired_at"])}
            if row.get("retired_at")
            else {}
        ),
        "status": row["status"],
        "capabilities": list(row.get("capabilities") or []),
        "maxConcurrentRuns": int(row.get("max_concurrent_runs") or 1),
        # `agents` and the other per-agent keys are merged in by
        # `apply_node_agents` from the daemon_node_agents rows.
        "agents": {},
        "token": None,
        **({"uiTokenHash": row["ui_token_hash"]} if row.get("ui_token_hash") else {}),
        **(
            {"nodeTokenHash": row["node_token_hash"]}
            if row.get("node_token_hash")
            else {}
        ),
        **({"lastError": row["last_error"]} if row.get("last_error") else {}),
        **({"hostOs": row["host_os"]} if row.get("host_os") else {}),
        "createdAt": format_db_time(row["created_at"]),
        "updatedAt": format_db_time(row["updated_at"]),
        **(
            {"lastSeenAt": format_db_time(row["last_seen_at"])}
            if row.get("last_seen_at")
            else {}
        ),
        **(
            {"lastPollAt": format_db_time(row["last_poll_at"])}
            if row.get("last_poll_at")
            else {}
        ),
    }


def command_to_row(
    record: dict[str, Any],
    *,
    database_id: str | None = None,
    node_pk: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or record["id"],
        "node_id": node_pk or record.get("nodeDatabaseId"),
        "type": record["command"]["type"],
        "status": record["status"],
        "command": record["command"],
        "exit_code": record.get("exitCode"),
        "error": record.get("error"),
        "created_at": parse_db_time(record["createdAt"]),
        "updated_at": parse_db_time(record["updatedAt"]),
        "dispatched_at": parse_db_time(record.get("dispatchedAt")),
        "lease_id": record.get("leaseId"),
        "lease_expires_at": parse_db_time(record.get("leaseExpiresAt")),
        "attempt": int(record.get("attempt") or 0),
        "completed_at": parse_db_time(record.get("completedAt")),
        "run_request_id": record["command"].get("_runRequestId"),
    }


def row_to_command(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "nodeId": row["node_id"],
        "command": row["command"],
        "status": row["status"],
        "createdAt": format_db_time(row["created_at"]),
        "updatedAt": format_db_time(row["updated_at"]),
        **(
            {"dispatchedAt": format_db_time(row["dispatched_at"])}
            if row.get("dispatched_at")
            else {}
        ),
        **({"leaseId": row["lease_id"]} if row.get("lease_id") else {}),
        **(
            {"leaseExpiresAt": format_db_time(row["lease_expires_at"])}
            if row.get("lease_expires_at")
            else {}
        ),
        "attempt": row.get("attempt") or 0,
        **(
            {"completedAt": format_db_time(row["completed_at"])}
            if row.get("completed_at")
            else {}
        ),
        **({"exitCode": row["exit_code"]} if row.get("exit_code") is not None else {}),
        **({"error": row["error"]} if row.get("error") else {}),
    }


def lease_expires_at(now: str, lease_seconds: float) -> str:
    expires_at = require_db_time(now) + timedelta(seconds=max(0.001, lease_seconds))
    return format_db_time(expires_at)


def run_to_row(
    run: dict[str, Any], *, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or run["runId"],
        "node_id": run["nodeId"],
        "command_id": run.get("commandId"),
        "session_id": run["sessionId"],
        "agent": run["agent"],
        "logical_agent_id": run.get("logicalAgentId"),
        "placement_id": run.get("placementId"),
        "task_goal": run["taskGoal"],
        "workspace_path": run.get("workspacePath"),
        "status": run["status"],
        "exit_code": run.get("exitCode"),
        "error": run.get("error"),
        "started_at": parse_db_time(run["startedAt"]),
        "completed_at": parse_db_time(run.get("completedAt")),
    }


def row_to_run(row: Any) -> dict[str, Any]:
    return {
        "nodeId": row["node_id"],
        **({"commandId": row["command_id"]} if row.get("command_id") else {}),
        "sessionId": row["session_id"],
        "runId": str(row["id"]),
        "agent": row["agent"],
        **(
            {"logicalAgentId": row["logical_agent_id"]}
            if row.get("logical_agent_id")
            else {}
        ),
        **({"placementId": row["placement_id"]} if row.get("placement_id") else {}),
        "taskGoal": row["task_goal"],
        **(
            {"workspacePath": row["workspace_path"]}
            if row.get("workspace_path")
            else {}
        ),
        "status": row["status"],
        **({"exitCode": row["exit_code"]} if row.get("exit_code") is not None else {}),
        **({"error": row["error"]} if row.get("error") else {}),
        "startedAt": format_db_time(row["started_at"]),
        **(
            {"completedAt": format_db_time(row["completed_at"])}
            if row.get("completed_at")
            else {}
        ),
    }


def run_request_to_row(
    record: dict[str, Any],
    *,
    database_id: str | None = None,
    node_pk: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or record["id"],
        "node_id": node_pk or record.get("nodeDatabaseId"),
        "session_id": record["sessionId"],
        "task_id": record.get("taskId"),
        "task_goal": record["taskGoal"],
        "assignments": record["assignments"],
        "current_index": record.get("currentIndex", 0),
        "state": record.get("state") or {},
        "status": record["status"],
        "current_command_id": record.get("currentCommandId"),
        "current_run_id": record.get("currentRunId"),
        "current_agent": record.get("currentAgent"),
        "current_started_at": parse_db_time(record.get("currentStartedAt")),
        "current_progress_at": parse_db_time(record.get("currentProgressAt")),
        "error": record.get("error"),
        "created_at": parse_db_time(record["createdAt"]),
        "updated_at": parse_db_time(record["updatedAt"]),
        "completed_at": parse_db_time(record.get("completedAt")),
    }


def row_to_run_request(row: Any) -> dict[str, Any]:
    return {
        "nodeId": row["node_id"],
        "id": str(row["id"]),
        "sessionId": row["session_id"],
        **({"taskId": row["task_id"]} if row.get("task_id") else {}),
        "taskGoal": row["task_goal"],
        "assignments": row["assignments"] or [],
        "currentIndex": row["current_index"],
        "state": row["state"] or {},
        "status": row["status"],
        **(
            {"currentCommandId": row["current_command_id"]}
            if row.get("current_command_id")
            else {}
        ),
        **(
            {"currentRunId": row["current_run_id"]} if row.get("current_run_id") else {}
        ),
        **({"currentAgent": row["current_agent"]} if row.get("current_agent") else {}),
        **(
            {"currentStartedAt": format_db_time(row["current_started_at"])}
            if row.get("current_started_at")
            else {}
        ),
        **(
            {"currentProgressAt": format_db_time(row["current_progress_at"])}
            if row.get("current_progress_at")
            else {}
        ),
        **({"error": row["error"]} if row.get("error") else {}),
        "createdAt": format_db_time(row["created_at"]),
        "updatedAt": format_db_time(row["updated_at"]),
        **(
            {"completedAt": format_db_time(row["completed_at"])}
            if row.get("completed_at")
            else {}
        ),
    }


def daemon_event_to_row(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "node_id": event.get("nodeId"),
        "command_id": event.get("commandId"),
        "run_id": event.get("runId"),
        "type": event["type"],
        "timestamp": parse_db_time(event["timestamp"]),
        "payload": event,
    }


def terminal_time_expression(table: Any) -> Any:
    if "updated_at" in table.c:
        return func.coalesce(table.c.completed_at, table.c.updated_at, table.c.created_at)
    return func.coalesce(table.c.completed_at, table.c.started_at)
