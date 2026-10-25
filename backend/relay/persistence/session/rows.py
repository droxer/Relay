"""Session, event, artifact, and token-usage rows, and the snapshot compaction
the session stores share.
"""

from __future__ import annotations

from datetime import datetime, UTC
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import UUID
from sqlalchemy import (
    Text,
    literal_column,
)
from ..db_time import parse_db_time
from ...core.ids import new_database_id
from ...core.token_usage import split_cache_tokens
from ...core.validation import safe_name
from ...core.workspace_artifacts import workspace_file_key


_AFFINITY_LOCKS: dict[str, RLock] = {}


_AFFINITY_LOCKS_GUARD = RLock()


def _shared_affinity_lock(key: str) -> RLock:
    with _AFFINITY_LOCKS_GUARD:
        return _AFFINITY_LOCKS.setdefault(key, RLock())


def _canonical_database_session_id(session_id: str) -> str:
    try:
        return str(UUID(session_id))
    except (AttributeError, TypeError, ValueError):
        raise KeyError(session_id) from None


def _artifact_field_sql(pg: bool, key: str) -> str:
    """SQL text reading one string field of the artifact row `a` in either dialect."""
    return f"a.value->>'{key}'" if pg else f"json_extract(a.value, '$.{key}')"


def session_to_row(
    session: dict[str, Any], *, version: int, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or session["id"],
        "workspace_path": session["workspacePath"],
        "project_id": session.get("projectId"),
        "owner_user_id": session.get("ownerUserId"),
        "title": session.get("title"),
        "task_goal": session["taskGoal"],
        "participants": session.get("participants") or [],
        "status": session["status"],
        "phase": session["phase"],
        "pending_decision": session.get("pendingDecision"),
        "current_agent": session.get("currentAgent"),
        "final_outcome": session.get("finalOutcome"),
        "snapshot": compact_database_session_snapshot(session, event_count=version),
        "version": version,
        "created_at": parse_db_time(session["createdAt"]),
        "updated_at": parse_db_time(session["updatedAt"]),
        "deletion_requested_at": _parse_optional_iso(
            session.get("deletionRequestedAt")
        ),
    }


def _parse_optional_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return parse_db_time(value)
    except ValueError:
        return None


WORKSPACE_FILE_UNDATED = datetime(1970, 1, 1, tzinfo=UTC)


def workspace_file_row(
    session_pk: str, session: dict[str, Any], artifact: dict[str, Any]
) -> dict[str, Any] | None:
    if artifact.get("kind") != "workspace_file":
        return None
    file_key = workspace_file_key(artifact)
    if file_key is None:
        return None
    return {
        "session_id": session_pk,
        "file_key": file_key,
        "artifact_id": artifact.get("id"),
        "owner_user_id": session.get("ownerUserId"),
        "workspace_path": session.get("workspacePath") or "",
        "created_at": _parse_optional_iso(artifact.get("createdAt"))
        or WORKSPACE_FILE_UNDATED,
        "artifact": artifact,
    }


def compact_session_snapshot(
    session: dict[str, Any], *, event_count: int | None = None
) -> dict[str, Any]:
    snapshot = dict(session)
    if event_count is None and "events" in snapshot:
        event_count = len(snapshot["events"])
    snapshot.pop("events", None)
    if event_count is not None:
        snapshot["eventCount"] = event_count
    return snapshot


def session_event_to_row(
    session_pk: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "session_id": session_pk,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": parse_db_time(event["timestamp"]),
        "payload": event,
    }


def database_artifact_uri(session_id: str, artifact_id: str, extension: str) -> str:
    return f"db://relay/sessions/{safe_name(session_id)}/artifacts/{safe_name(artifact_id)}.{safe_name(extension)}"


def artifact_snapshot_extension(title: Any) -> str:
    """Derive a safe file extension for a workspace-artifact snapshot copy."""
    suffix = Path(str(title or "")).suffix.lstrip(".").lower()
    cleaned = "".join(ch for ch in suffix if ch.isalnum())
    return cleaned or "bin"


def session_artifact_to_row(
    session_pk: str,
    artifact: dict[str, Any],
    metadata: dict[str, Any] | None = None,
    *,
    content: str | None = None,
) -> dict[str, Any]:
    return {
        "id": artifact["id"],
        "session_id": session_pk,
        "agent_run_id": artifact.get("agentRunId"),
        "kind": artifact["kind"],
        "title": artifact["title"],
        "path": artifact.get("path"),
        "content": content,
        "content_type": artifact.get("contentType"),
        "byte_size": artifact.get("bytes", 0),
        "metadata": metadata or {},
        "created_at": parse_db_time(artifact["createdAt"]),
    }


def session_run_token_usage_to_row(
    session_pk: str, session: dict[str, Any], run_id: str
) -> dict[str, Any] | None:
    run = next(
        (item for item in session.get("agentRuns", []) if item.get("id") == run_id),
        None,
    )
    record = run_token_usage_record(session, run) if isinstance(run, dict) else None
    if record is None:
        return None
    return {
        "id": new_database_id(),
        "session_id": session_pk,
        "run_id": run_id,
        "owner_user_id": record["ownerUserId"],
        "task_goal": record["taskGoal"],
        "input_tokens": record["input"],
        "output_tokens": record["output"],
        "cache_tokens": record["cache"],
        "cache_read_tokens": record["cacheRead"],
        "cache_write_tokens": record["cacheWrite"],
        "total_tokens": record["total"],
        "agent": record["agent"],
        "reported": record["reported"],
        "completed_at": parse_db_time(record["completedAt"]),
    }


def run_token_usage_record(
    session: dict[str, Any], run: dict[str, Any]
) -> dict[str, Any] | None:
    """The usage ledger entry for one finished run, or None if it has none.

    A run with counts is recorded whatever its outcome — a stopped run still
    spent what it spent. A run that completed successfully without counts is
    recorded as unreported, so coverage gaps are measured rather than assumed.
    """
    completed_at = run.get("completedAt")
    if not completed_at:
        return None
    raw_usage = run.get("tokenUsage")
    usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
    reported = int(usage.get("total") or 0) > 0
    if not reported and run.get("status") != "completed":
        return None
    if not reported:
        usage = {}
    cache_read, cache_write = split_cache_tokens(usage)
    input_tokens = int(usage.get("input") or 0)
    output_tokens = int(usage.get("output") or 0)
    return {
        "sessionId": session["id"],
        "runId": run["id"],
        "ownerUserId": session.get("ownerUserId"),
        "taskGoal": session.get("taskGoal"),
        "agent": run.get("agent"),
        "reported": reported,
        "input": input_tokens,
        "output": output_tokens,
        "cache": cache_read + cache_write,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "total": input_tokens + output_tokens + cache_read + cache_write,
        "completedAt": completed_at,
    }


def compact_database_session_snapshot(session: dict[str, Any], *, event_count: int | None = None) -> dict[str, Any]:
    snapshot = compact_session_snapshot(session, event_count=event_count)
    snapshot["agentRuns"] = [
        {key: value for key, value in run.items() if key != "agentLog"}
        for run in snapshot.get("agentRuns", [])
    ]
    return snapshot


def hydrate_session_logs(snapshot: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    logs = {event["runId"]: event["agentLog"] for event in events
            if event.get("type") == "agent.completed" and "agentLog" in event}
    # Neutral events (streamed output) bump the row's version but not the
    # snapshot, so the snapshot's own eventCount can lag the log it sits on.
    return {**snapshot, "events": events, "eventCount": len(events), "agentRuns": [
        {**run, **({"agentLog": logs[run["id"]]} if run["id"] in logs else {})}
        for run in snapshot.get("agentRuns", [])
    ]}


def session_event_cursor_expression(table: Any) -> Any:
    # Literal JSON key keeps PostgreSQL and SQLite index/query expressions equal.
    return table.c.payload.op("->>", return_type=Text)(literal_column("'id'"))
