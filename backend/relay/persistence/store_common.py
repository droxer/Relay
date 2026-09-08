from __future__ import annotations

import json
import os
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock, local
from typing import Any

from sqlalchemy import JSON, Column, MetaData, Text, Uuid, create_engine, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import make_url

from ..core.ids import new_database_id, now_iso
from ..core.models import (
    AGENT_NAMES,
    AgentName,
    TaskPriority,
    TaskRoutineCadence,
    TaskRoutineType,
    TaskStatus,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RELAY_DATA_DIR = REPO_ROOT / ".relay"
SESSION_WORKSPACE_LAYOUT_THREAD = "thread"

# Every database-backed store registers its tables here. One MetaData is what
# lets foreign keys cross aggregate boundaries (agents -> employees, placements
# -> daemon_nodes) and lets `tests/unit/test_schema_drift.py` compare the
# migrated schema against the declared one.
#
# Snapshot convention: stores that keep a `snapshot` JSON column treat it as the
# authoritative record. Sibling columns (display_name, executor_kind, status, …)
# are derived projections used only for filtering, ordering, and uniqueness;
# they are rewritten from the snapshot on every write. A migration that edits a
# snapshot must update the derived columns in the same statement.
metadata = MetaData()


def entity_uuid_type() -> Any:
    """Native UUID in PostgreSQL, with TEXT retained for SQLite test stores."""
    return Uuid(as_uuid=False).with_variant(Text(), "sqlite")


_ENGINES: dict[str, Any] = {}
_ENGINE_LOCK = RLock()


def _positive_env_number(name: str, default: str, cast: Any) -> Any:
    raw = os.environ.get(name, default).strip()
    try:
        value = cast(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a positive number.") from error
    if value <= 0:
        raise ValueError(f"{name} must be a positive number.")
    return value


def database_engine_options(database_url: str) -> dict[str, Any]:
    """Build bounded per-replica pool settings for server databases."""
    if make_url(database_url).get_backend_name() == "sqlite":
        return {}
    pre_ping = os.environ.get("RELAY_DB_POOL_PRE_PING", "true").strip().lower()
    if pre_ping not in {"1", "true", "yes", "on", "0", "false", "no", "off"}:
        raise ValueError("RELAY_DB_POOL_PRE_PING must be a boolean.")
    return {
        "pool_size": _positive_env_number("RELAY_DB_POOL_SIZE", "10", int),
        "max_overflow": _positive_env_number("RELAY_DB_MAX_OVERFLOW", "20", int),
        "pool_timeout": _positive_env_number(
            "RELAY_DB_POOL_TIMEOUT_SECONDS", "5", float
        ),
        "pool_recycle": _positive_env_number(
            "RELAY_DB_POOL_RECYCLE_SECONDS", "300", int
        ),
        "pool_pre_ping": pre_ping in {"1", "true", "yes", "on"},
        "pool_use_lifo": True,
    }


def shared_engine(database_url: str) -> Any:
    """One Engine per database URL, shared by every store.

    Stores used to build an Engine each, so eight connection pools pointed at
    the same database and no operation could span two stores in one
    transaction. Sharing the Engine is what lets `transaction()` make a
    multi-store write -- deleting an employee, say -- atomic.
    """
    with _ENGINE_LOCK:
        engine = _ENGINES.get(database_url)
        if engine is None:
            engine = create_engine(
                database_url, future=True, **database_engine_options(database_url)
            )
            _ENGINES[database_url] = engine
        return engine


def publish_database_notification(
    conn: Any, engine: Any, channel: str | None, payload: str
) -> None:
    """Publish a transactional PostgreSQL wakeup when notifications are enabled."""
    if channel and engine.dialect.name == "postgresql":
        conn.execute(
            text("SELECT pg_notify(:channel, :payload)"),
            {"channel": channel, "payload": payload},
        )


def create_all_tables(engine: Any) -> None:
    """Create every Relay table on `engine`.

    Always creates the whole schema, never one store's slice: foreign keys now
    cross store boundaries, so `agents` cannot be created without `employees`
    also being registered on the shared MetaData. The import is deferred to
    here because `relay.persistence.schema` imports the stores that import this
    module.
    """
    from . import schema

    schema.metadata.create_all(engine)


_TRANSACTION_STATE = local()


@contextmanager
def store_transaction(engine: Any) -> Any:
    """Open a transaction on `engine`, or join the enclosing one.

    Every store method opens one of these instead of `engine.begin()`. On its
    own it behaves identically. Wrapped in an outer `store_transaction` on the
    same engine, the inner ones enlist in it rather than committing separately,
    which is what makes a cascade that spans stores -- deleting an employee and
    its agents, placements, teams, and nodes -- atomic.

    The bookkeeping is thread-local, so a transaction on one thread never leaks
    into a store call on another.
    """
    connections = getattr(_TRANSACTION_STATE, "connections", None)
    if connections is None:
        connections = {}
        _TRANSACTION_STATE.connections = connections

    key = id(engine)
    joined = connections.get(key)
    if joined is not None:
        yield joined
        return

    with engine.begin() as connection:
        connections[key] = connection
        try:
            yield connection
        finally:
            connections.pop(key, None)


def json_type() -> Any:
    """JSONB in PostgreSQL, plain JSON for SQLite test stores.

    Migrations have always created `jsonb`; declaring bare `JSON` here made
    `create_all` produce `json` columns instead, which sort and index
    differently.
    """
    return JSON().with_variant(JSONB(), "postgresql")


def database_id_column() -> Column[Any]:
    return Column("id", entity_uuid_type(), primary_key=True, default=new_database_id)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _format_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        # SQLite's DATETIME result has no timezone offset. Relay writes all
        # timestamps as UTC, so never reinterpret a database value in the
        # host's local timezone when formatting it back onto the wire.
        value = value.replace(tzinfo=timezone.utc)
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path: Path, value: Any, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if mode is None:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
    else:
        fd = os.open(tmp, flags, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
    tmp.replace(path)


def _append_jsonl(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, separators=(",", ":")))
        handle.write("\n")


def _write_jsonl(path: Path, values: list[Any]) -> None:
    """Atomically replace a JSONL file. Used by retention passes that rewrite a
    log in place; appends should use `_append_jsonl`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for value in values:
            handle.write(json.dumps(value, separators=(",", ":")))
            handle.write("\n")
    tmp.replace(path)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise KeyError(path)
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def relay_event(
    event_type: str, session_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "sessionId": session_id,
        "timestamp": now_iso(),
        **payload,
    }


def relay_task_event(
    event_type: str, task_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "taskId": task_id,
        "timestamp": now_iso(),
        **payload,
    }


def merge_token_usage(values: list[dict[str, Any] | None]) -> dict[str, int] | None:
    totals = {"input": 0, "output": 0, "cache": 0}
    for value in values:
        if not isinstance(value, dict):
            continue
        totals["input"] += int(value.get("input") or 0)
        totals["output"] += int(value.get("output") or 0)
        totals["cache"] += int(value.get("cache") or 0)
    if totals["input"] == 0 and totals["output"] == 0 and totals["cache"] == 0:
        return None
    return {**totals, "total": totals["input"] + totals["output"] + totals["cache"]}


def materialize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    created = next(
        (event for event in events if event.get("type") == "session.created"), None
    )
    if not created:
        raise ValueError("Relay session event log is missing session.created.")
    session: dict[str, Any] = {
        "id": created["sessionId"],
        "workspacePath": created["workspacePath"],
        "taskGoal": created["taskGoal"],
        "participants": created.get("participants", ["human"]),
        "status": "running",
        "phase": "created",
        "createdAt": created["timestamp"],
        "updatedAt": created["timestamp"],
        "agentRuns": [],
        "artifacts": [],
        "decisions": [],
        "collaborationRounds": [],
        "collaborationRevision": 0,
        "events": [],
        "archived": False,
    }
    if created.get("workspaceLayout"):
        session["workspaceLayout"] = created["workspaceLayout"]
    if created.get("ownerEmployeeId"):
        session["ownerEmployeeId"] = created["ownerEmployeeId"]
    if created.get("ownerAgentId"):
        session["ownerAgentId"] = created["ownerAgentId"]
        # The room starts as whoever the thread started with; `@` mentions grow
        # it from there. A team thread seeds the rest of its roster from the
        # team snapshot at dispatch time, so legacy threads replay correctly.
        session["participantAgentIds"] = [created["ownerAgentId"]]
    else:
        session["participantAgentIds"] = []
    if created.get("teamId"):
        session["teamId"] = created["teamId"]
    if created.get("projectId"):
        session["projectId"] = created["projectId"]
    if created.get("workspaceSubpath"):
        session["workspaceSubpath"] = created["workspaceSubpath"]
    if created.get("daemonNodeId"):
        session["daemonNodeId"] = created["daemonNodeId"]
    if created.get("managedNodeId"):
        session["managedNodeId"] = created["managedNodeId"]
    if created.get("computerId"):
        session["computerId"] = created["computerId"]
    for event in events:
        apply_session_event(session, event)
    return session


def apply_session_event(
    session: dict[str, Any], event: dict[str, Any], *, retain_event: bool = True
) -> dict[str, Any]:
    """Incrementally update a derived session projection with one event."""
    if retain_event:
        session.setdefault("events", []).append(event)
    session["updatedAt"] = event["timestamp"]
    handler = SESSION_EVENT_HANDLERS.get(event.get("type"))
    if handler:
        handler(session, event)
    return session


def _apply_session_status(session: dict[str, Any], event: dict[str, Any]) -> None:
    session["status"] = event["status"]
    session["phase"] = event["phase"]
    if event.get("pendingDecision"):
        session["pendingDecision"] = event["pendingDecision"]
    else:
        session.pop("pendingDecision", None)
    if event["status"] not in ("completed", "failed"):
        session.pop("finalOutcome", None)


def _apply_collaboration_round_started(
    session: dict[str, Any], event: dict[str, Any]
) -> None:
    manifest = event.get("manifest")
    if not isinstance(manifest, dict):
        return
    rounds = session.setdefault("collaborationRounds", [])
    round_id = manifest.get("roundId")
    if not any(item.get("roundId") == round_id for item in rounds):
        rounds.append(manifest)
    session["collaborationRevision"] = len(rounds)
    if isinstance(manifest.get("collaborationId"), str):
        session["activeCollaborationId"] = manifest["collaborationId"]
    if isinstance(round_id, str):
        session["activeRoundId"] = round_id


def _apply_agent_started(session: dict[str, Any], event: dict[str, Any]) -> None:
    if any(run["id"] == event["runId"] for run in session["agentRuns"]):
        return
    if event.get("daemonNodeId"):
        session["daemonNodeId"] = event["daemonNodeId"]
    if event.get("managedNodeId") and not session.get("managedNodeId"):
        session["managedNodeId"] = event["managedNodeId"]
    run = {
        "id": event["runId"],
        "agent": event["agent"],
        "status": "running",
        "startedAt": event["timestamp"],
        "artifactIds": [],
    }
    for key in (
        "role",
        "logicalAgentId",
        "placementId",
        "daemonNodeId",
        "agentVersion",
        "workspaceIdentity",
        "brief",
        "coordinator",
        "synthesizer",
        "teamSnapshot",
        "assignmentId",
        "workItemId",
        "delegationAuthority",
        "dependsOnWorkItemIds",
        "workKind",
        "teamPhase",
    ):
        if event.get(key) is not None:
            run[key] = event[key]
    session["status"] = "running"
    session["phase"] = event["agent"]
    session["currentAgent"] = event["agent"]
    session["agentRuns"].append(run)


def _apply_agent_completed(session: dict[str, Any], event: dict[str, Any]) -> None:
    for run in session["agentRuns"]:
        if run["id"] != event["runId"]:
            continue
        run["status"] = event["status"]
        run["completedAt"] = event["timestamp"]
        run["exitCode"] = event["exitCode"]
        if "agentLog" in event:
            run["agentLog"] = event["agentLog"]
        if event.get("tokenUsage"):
            run["tokenUsage"] = event["tokenUsage"]
    token_usage = merge_token_usage(
        [run.get("tokenUsage") for run in session["agentRuns"]]
    )
    if token_usage:
        session["tokenUsage"] = token_usage
    else:
        session.pop("tokenUsage", None)
    session.pop("currentAgent", None)
    if event["status"] == "completed":
        session["phase"] = "agent_completed"
    elif event["status"] == "cancelled":
        session["phase"] = "cancelled"
    else:
        session["phase"] = "agent_failed"


def _apply_artifact_created(session: dict[str, Any], event: dict[str, Any]) -> None:
    artifact = event["artifact"]
    session["artifacts"].append(artifact)
    if not artifact.get("agentRunId"):
        return
    for run in session["agentRuns"]:
        if run["id"] == artifact["agentRunId"]:
            run.setdefault("artifactIds", []).append(artifact["id"])


def _apply_human_decision(session: dict[str, Any], event: dict[str, Any]) -> None:
    decision = event["decision"]
    session["decisions"].append(decision)
    if decision["kind"] == "handoff" and decision.get("targetAgent"):
        session["currentAgent"] = decision["targetAgent"]
    if decision["kind"] == "cancel":
        session["status"] = "cancelled"
        session["phase"] = "cancelled"
        session.pop("pendingDecision", None)


def _apply_session_terminal(session: dict[str, Any], event: dict[str, Any]) -> None:
    status = "completed" if event["type"] == "session.completed" else "failed"
    session["status"] = status
    session["phase"] = status
    session["finalOutcome"] = event["outcome"]
    session.pop("currentAgent", None)
    session.pop("pendingDecision", None)


def _apply_session_archived(session: dict[str, Any], _event: dict[str, Any]) -> None:
    session["archived"] = True


def _apply_session_runtime_affinity(
    session: dict[str, Any], event: dict[str, Any]
) -> None:
    """A thread pins one Computer once; first write wins, later ones do not
    overwrite it.

    Older events carry only `managedNodeId`, derived here as `managed:<id>`,
    so no Alembic backfill is needed — the snapshot is a product of replay.
    """
    if session.get("computerId"):
        return
    identity = event.get("computerId")
    if not identity and event.get("managedNodeId"):
        identity = f"managed:{event['managedNodeId']}"
    if not identity:
        return
    session["computerId"] = identity
    if identity.startswith("managed:") and not session.get("managedNodeId"):
        session["managedNodeId"] = identity.split(":", 1)[1]


def _apply_session_renamed(session: dict[str, Any], event: dict[str, Any]) -> None:
    session["title"] = event["title"]


def _apply_participants_joined(session: dict[str, Any], event: dict[str, Any]) -> None:
    """Grow the thread's room. Membership only ever grows, never shrinks."""
    roster = session.setdefault("participantAgentIds", [])
    for agent_id in event.get("agentIds") or []:
        if isinstance(agent_id, str) and agent_id and agent_id not in roster:
            roster.append(agent_id)


SessionEventHandler = Callable[[dict[str, Any], dict[str, Any]], None]
SESSION_EVENT_HANDLERS: dict[str, SessionEventHandler] = {
    "session.status": _apply_session_status,
    "collaboration.round.started": _apply_collaboration_round_started,
    "agent.started": _apply_agent_started,
    "agent.completed": _apply_agent_completed,
    "artifact.created": _apply_artifact_created,
    "human.decision": _apply_human_decision,
    "session.completed": _apply_session_terminal,
    "session.failed": _apply_session_terminal,
    "session.archived": _apply_session_archived,
    "session.runtime_affinity": _apply_session_runtime_affinity,
    "session.renamed": _apply_session_renamed,
    "thread.participants_joined": _apply_participants_joined,
}


def materialize_task_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    created = next(
        (event for event in events if event.get("type") == "task.created"), None
    )
    if not created:
        raise ValueError("Relay task event log is missing task.created.")
    task: dict[str, Any] = {
        "id": created["taskId"],
        "title": created["title"],
        "description": created.get("description", ""),
        "priority": created.get("priority", "normal"),
        "status": "backlog",
        "isRoutine": bool(created.get("isRoutine")),
        "routineEnabled": bool(created.get("routineEnabled")),
        "linkedSessionIds": [],
        "occurrenceIds": [],
        "activity": [],
        "createdAt": created["timestamp"],
        "updatedAt": created["timestamp"],
        "events": [],
    }
    if created.get("ownerEmployeeId"):
        task["ownerEmployeeId"] = created["ownerEmployeeId"]
    if created.get("assigneeEmployeeId"):
        task["assigneeEmployeeId"] = created["assigneeEmployeeId"]
    if created.get("projectId"):
        task["projectId"] = created["projectId"]
    if created.get("dueDate"):
        task["dueDate"] = created["dueDate"]
    if created.get("sourceRoutineId"):
        task["sourceRoutineId"] = created["sourceRoutineId"]
    if created.get("scheduledFor"):
        task["scheduledFor"] = created["scheduledFor"]
    _apply_task_routine_fields(task, created)
    for event in events:
        task["events"].append(event)
        task["updatedAt"] = event["timestamp"]
        handler = TASK_EVENT_HANDLERS.get(event.get("type"))
        if handler:
            handler(task, event)
    return task


def _apply_task_workspace_wait(task: dict[str, Any], event: dict[str, Any]) -> None:
    if event.get("waiting"):
        task["workspaceWaiting"] = dict(event["waiting"])
    elif (task.get("workspaceWaiting") or {}).get("runId") == event.get("runId"):
        task.pop("workspaceWaiting", None)


def _apply_task_workspace_bound(task: dict[str, Any], event: dict[str, Any]) -> None:
    binding = event["binding"]
    current = task.get("workspaceBinding")
    if current and current != binding:
        raise ValueError(
            "workspace_unavailable: a task's workspace binding is immutable."
        )
    task["workspaceBinding"] = dict(binding)


def _apply_task_updated(task: dict[str, Any], event: dict[str, Any]) -> None:
    for key in ("title", "description", "priority", "assigneeEmployeeId", "dueDate"):
        if key not in event or event[key] is None:
            continue
        if key in ("assigneeEmployeeId", "dueDate") and event[key] == "":
            task.pop(key, None)
        else:
            task[key] = event[key]
    _apply_task_routine_fields(task, event)


def _apply_task_assigned(task: dict[str, Any], event: dict[str, Any]) -> None:
    if event.get("teamId"):
        task["assignedTeamId"] = event["teamId"]
        task.pop("assignedAgent", None)
        task.pop("assignedAgentId", None)
        return
    task["assignedAgent"] = event["agent"]
    if event.get("agentId"):
        task["assignedAgentId"] = event["agentId"]
    else:
        task.pop("assignedAgentId", None)
    task.pop("assignedTeamId", None)


def _apply_task_unassigned(task: dict[str, Any], _event: dict[str, Any]) -> None:
    task.pop("assignedAgent", None)
    task.pop("assignedAgentId", None)
    task.pop("assignedTeamId", None)


def _apply_task_dispatch_claimed(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["dispatchClaim"] = event["claim"]


def _apply_task_dispatch_released(task: dict[str, Any], event: dict[str, Any]) -> None:
    if task.get("dispatchClaim", {}).get("id") == event.get("claimId"):
        task.pop("dispatchClaim", None)


def _apply_task_dispatch_outcome(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["dispatchOutcome"] = event["outcome"]


def _apply_task_dispatch_retry(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["dispatchRetry"] = event["retry"]


def _apply_task_dispatch_retry_cleared(
    task: dict[str, Any], _event: dict[str, Any]
) -> None:
    task.pop("dispatchRetry", None)


def _apply_task_occurrence_created(task: dict[str, Any], event: dict[str, Any]) -> None:
    occurrence_id = event["occurrenceId"]
    if occurrence_id not in task["occurrenceIds"]:
        task["occurrenceIds"].append(occurrence_id)


def _apply_task_round(task: dict[str, Any], event: dict[str, Any]) -> None:
    """Apply a round's verdict and what a continuation of it would need.

    Kept out of task.updated because these are execution facts, not user edits:
    a person editing the title must never disturb the round bookkeeping, and a
    round completing must never look like someone edited the task.
    """
    if event.get("roundResult") is not None:
        task["lastRoundResult"] = event["roundResult"]
    if event.get("roundCount") is not None:
        task["roundCount"] = event["roundCount"]
    if event.get("continuationSessionId") is not None:
        task["continuationSessionId"] = event["continuationSessionId"]
    if event.get("clearContinuation"):
        task.pop("continuationSessionId", None)


def _apply_task_status(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["status"] = event["status"]
    if event["status"] != "running":
        task.pop("workspaceWaiting", None)


def _apply_task_deleted(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["deletedAt"] = event["timestamp"]
    if event.get("actorEmployeeId"):
        task["deletedByEmployeeId"] = event["actorEmployeeId"]


def _apply_task_session_linked(task: dict[str, Any], event: dict[str, Any]) -> None:
    if event["sessionId"] not in task["linkedSessionIds"]:
        task["linkedSessionIds"].append(event["sessionId"])


def _apply_task_session_unlinked(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["linkedSessionIds"] = [
        session_id
        for session_id in task["linkedSessionIds"]
        if session_id != event["sessionId"]
    ]


def _apply_task_activity(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["activity"].append(event["activity"])


TaskEventHandler = Callable[[dict[str, Any], dict[str, Any]], None]
TASK_EVENT_HANDLERS: dict[str, TaskEventHandler] = {
    "task.workspace_bound": _apply_task_workspace_bound,
    "task.workspace_wait": _apply_task_workspace_wait,
    "task.updated": _apply_task_updated,
    "task.assigned": _apply_task_assigned,
    "task.unassigned": _apply_task_unassigned,
    "task.dispatch_claimed": _apply_task_dispatch_claimed,
    "task.dispatch_released": _apply_task_dispatch_released,
    "task.dispatch_outcome": _apply_task_dispatch_outcome,
    "task.dispatch_retry": _apply_task_dispatch_retry,
    "task.dispatch_retry_cleared": _apply_task_dispatch_retry_cleared,
    "task.occurrence_created": _apply_task_occurrence_created,
    "task.round": _apply_task_round,
    "task.status": _apply_task_status,
    "task.deleted": _apply_task_deleted,
    "task.session_linked": _apply_task_session_linked,
    "task.session_unlinked": _apply_task_session_unlinked,
    "task.activity": _apply_task_activity,
}


def _apply_task_routine_fields(task: dict[str, Any], event: dict[str, Any]) -> None:
    if "isRoutine" in event and event["isRoutine"] is not None:
        task["isRoutine"] = bool(event["isRoutine"])
        if not task["isRoutine"]:
            task["routineEnabled"] = False
            task.pop("routineType", None)
            task.pop("routineCadence", None)
            task.pop("routineNextRunDate", None)
            return
    if not task.get("isRoutine"):
        return
    if "routineEnabled" in event and event["routineEnabled"] is not None:
        task["routineEnabled"] = bool(event["routineEnabled"])
    if "routineType" in event and event["routineType"] is not None:
        task["routineType"] = event["routineType"]
    if "routineCadence" in event and event["routineCadence"] is not None:
        task["routineCadence"] = event["routineCadence"]
    if "routineNextRunDate" in event and event["routineNextRunDate"] is not None:
        if event["routineNextRunDate"]:
            task["routineNextRunDate"] = event["routineNextRunDate"]
        else:
            task.pop("routineNextRunDate", None)


def daemon_event(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "timestamp": now_iso(),
        **payload,
    }


def safe_name(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in value)
    return safe or "relay"


def valid_agent(value: Any) -> AgentName | None:
    return value if value in AGENT_NAMES else None


def task_priority(value: Any) -> TaskPriority | None:
    return value if value in ("low", "normal", "high") else None


def task_status(value: Any) -> TaskStatus | None:
    return (
        value
        if value
        in (
            "backlog",
            "assigned",
            "running",
            "waiting_for_human",
            "review",
            "done",
            "blocked",
        )
        else None
    )


def task_routine_type(value: Any) -> TaskRoutineType | None:
    return value if value in ("task", "job") else None


def task_routine_cadence(value: Any) -> TaskRoutineCadence | None:
    return value if value in ("daily", "weekly", "monthly", "custom") else None
