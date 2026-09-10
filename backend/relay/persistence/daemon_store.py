from __future__ import annotations

import fcntl
import json
import os
from collections import defaultdict
from collections.abc import Callable, Iterator
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta
from pathlib import Path
from threading import RLock
from typing import Any

from loguru import logger
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    Table,
    Text,
    delete,
    func,
    insert,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError

from ..core.computer_identity import local_enrollment_key
from ..core.ids import new_relay_id
from .store_common import (
    DEFAULT_RELAY_DATA_DIR,
    _append_jsonl,
    _format_iso,
    _parse_iso,
    _read_json,
    _read_jsonl,
    _write_json,
    _write_jsonl,
    create_all_tables,
    daemon_event,
    database_id_column,
    entity_uuid_type,
    json_type,
    new_database_id,
    now_iso,
    publish_database_notification,
    safe_name,
    shared_engine,
    store_transaction,
)
from .store_common import (
    metadata as shared_metadata,
)

TERMINAL_DAEMON_STATUSES = frozenset({"completed", "failed", "cancelled"})
# Command-lifecycle events describe records that `prune_terminal_records`
# deletes, so they are pruned on the same retention cutoff. Node-lifecycle
# events are otherwise kept indefinitely: `delete_node` hard-deletes the node
# row, which makes the event log the only surviving record of a node incarnation
# (see `historical_managed_runtime_ids`).
PRUNABLE_DAEMON_EVENT_PREFIXES = ("daemon.command.", "daemon.workspace.")
# `daemon.node.seen` is the exception. It was appended per heartbeat by a path
# that has since stopped emitting it, nothing has ever read it, and it carries no
# node payload -- so unlike `daemon.node.registered` it records nothing about an
# incarnation and only accumulates.
PRUNABLE_DAEMON_EVENT_TYPES = frozenset({"daemon.node.seen"})


def daemon_event_is_prunable(event_type: str) -> bool:
    return (
        any(event_type.startswith(prefix) for prefix in PRUNABLE_DAEMON_EVENT_PREFIXES)
        or event_type in PRUNABLE_DAEMON_EVENT_TYPES
    )


ACTIVE_RUN_REQUEST_STATUSES = frozenset(
    {"prepared", "running", "dispatching", "finalizing"}
)
DISPATCH_CLAIM_ID_STATE_KEY = "_relay_dispatch_claim_id"
DISPATCH_CLAIM_EXPIRES_STATE_KEY = "_relay_dispatch_claim_expires_at"
TERMINAL_EVENT_STATE_KEY = "_relay_terminal_event"
TERMINAL_CLAIM_ID_STATE_KEY = "_relay_terminal_claim_id"
TERMINAL_CLAIM_EXPIRES_STATE_KEY = "_relay_terminal_claim_expires_at"


def daemon_command_queue_limit() -> int:
    raw = os.environ.get("RELAY_DAEMON_MAX_QUEUED_COMMANDS_PER_NODE", "1000")
    try:
        limit = int(raw)
    except ValueError as error:
        raise ValueError(
            "RELAY_DAEMON_MAX_QUEUED_COMMANDS_PER_NODE must be a positive integer."
        ) from error
    if limit <= 0:
        raise ValueError(
            "RELAY_DAEMON_MAX_QUEUED_COMMANDS_PER_NODE must be a positive integer."
        )
    return limit


def _assert_node_run_request_capacity(
    node: dict[str, Any],
    active_requests: list[dict[str, Any]],
    request: dict[str, Any],
) -> None:
    max_concurrent = node.get("maxConcurrentRuns")
    if not isinstance(max_concurrent, int) or max_concurrent <= 0:
        max_concurrent = 1
    available = len(active_requests) < max_concurrent
    if not available:
        raise ValueError("Runtime node capacity is exhausted.")


def _node_for_storage(node: dict[str, Any]) -> dict[str, Any]:
    stored = {**node, "token": None}
    stored.pop("nodeToken", None)
    return stored


def _node_for_event(node: dict[str, Any]) -> dict[str, Any]:
    """The stored node minus secrets: daemon events are audit, never pruned."""
    stored = _node_for_storage(node)
    stored.pop("nodeTokenSecret", None)
    return stored


# Advance on every heartbeat by design, so they say nothing about whether a
# registration is materially new.
_NODE_LIVENESS_FIELDS = ("updatedAt", "lastSeenAt")
_NODE_LIVENESS_COLUMNS = frozenset({"updated_at", "last_seen_at"})


def _comparable_node_value(value: Any) -> Any:
    """Normalize a stored node value for comparison.

    SQLite hands back naive datetimes where the incoming row holds UTC-aware
    ones, so compare timestamps in their formatted form.
    """
    return _format_iso(value) if isinstance(value, datetime) else value


def node_registration_changed(
    previous: dict[str, Any] | None, node: dict[str, Any]
) -> bool:
    """Whether a registration differs from what is already stored.

    Daemons re-register on a heartbeat, and `daemon.node.*` events are never
    pruned (they are the only record of a node incarnation once `delete_node`
    removes the row). Appending an event per heartbeat therefore grows
    `daemon_events` without bound while telling
    `_managed_runtime_identity_map` nothing it does not already know, since it
    folds the events into a dict keyed by node id.
    """
    if previous is None:
        return True
    return {
        key: value
        for key, value in previous.items()
        if key not in _NODE_LIVENESS_FIELDS
    } != {key: value for key, value in node.items() if key not in _NODE_LIVENESS_FIELDS}


def preserve_node_retirement(
    previous: dict[str, Any] | None, node: dict[str, Any]
) -> dict[str, Any]:
    """Keep a durable retirement fence monotonic across stale replica writes."""
    if not previous or not previous.get("retiredAt"):
        return node
    return {
        **node,
        "retiredAt": previous["retiredAt"],
        "status": "deleted" if previous.get("status") == "deleted" else "stopped",
    }


def infer_node_location(node: dict[str, Any]) -> str | None:
    """Infer location only from explicit or managed control-plane state."""
    explicit = node.get("nodeLocation")
    if explicit:
        return str(explicit)
    if node.get("managedNodeId"):
        return "managed"
    return None


def assigned_node_location(node: dict[str, Any]) -> str:
    """Classify a node during an authorized control-plane assignment."""
    if node.get("nodeLocation"):
        return str(node["nodeLocation"])
    if node.get("managedNodeId"):
        return "managed"
    return "employee-device"


NodeSettingValue = str | None | list[str] | dict[str, str]


def node_setting_update(
    node_id: str,
    node: dict[str, Any],
    *,
    field: str,
    value: NodeSettingValue,
    event_type: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if isinstance(value, list):
        normalized_value: NodeSettingValue = list(value)
    elif isinstance(value, dict):
        normalized_value = dict(value)
    else:
        normalized_value = value

    updated = {**node, "updatedAt": now_iso()}
    if normalized_value:
        updated[field] = normalized_value
    else:
        updated.pop(field, None)
    return updated, daemon_event(
        event_type,
        {"nodeId": node_id, field: normalized_value},
    )


def _terminal_timestamp(record: dict[str, Any]) -> str:
    return (
        record.get("completedAt")
        or record.get("updatedAt")
        or record.get("createdAt")
        or ""
    )


def _database_terminal_timestamp(row: Any) -> str:
    value = row.get("completed_at") or row.get("updated_at") or row.get("created_at")
    if isinstance(value, str):
        return value
    return _format_iso(value) or ""


def completed_cancel_record(
    record: dict[str, Any], now: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    command = record["command"]
    updated = {
        **record,
        "status": "completed",
        "updatedAt": now,
        "completedAt": now,
    }
    event = daemon_event(
        "daemon.command.completed",
        {
            "nodeId": record["nodeId"],
            "commandId": record["id"],
            "targetCommandId": command["commandId"],
            "runId": command["runId"],
        },
    )
    return updated, event


def terminal_database_ids_to_prune(
    rows: list[Any], cutoff: str, per_node_limit: int
) -> list[str]:
    records_by_node: dict[str, list[Any]] = defaultdict(list)
    for row in rows:
        records_by_node[row["node_id"]].append(row)
    database_ids: list[str] = []
    for records in records_by_node.values():
        records.sort(key=_database_terminal_timestamp, reverse=True)
        for index, row in enumerate(records):
            if index < per_node_limit and _database_terminal_timestamp(row) > cutoff:
                continue
            database_ids.append(row["id"])
    return database_ids


def _managed_runtime_identity_map(
    events: list[dict[str, Any]],
) -> dict[str, str]:
    identities: dict[str, str] = {}
    for event in events:
        node = event.get("node") if isinstance(event, dict) else None
        if (
            event.get("type") == "daemon.node.registered"
            and isinstance(node, dict)
            and isinstance(node.get("id"), str)
            and isinstance(node.get("managedNodeId"), str)
        ):
            identities[node["id"]] = node["managedNodeId"]
    return identities


class LocalDaemonStore:
    """File-backed daemon store for a single backend process.

    The in-process lock and queued-command index are intentionally not
    interprocess coordination primitives. Multi-process deployments must use
    DatabaseDaemonStore.
    """

    def __init__(self, root_dir: str | Path = DEFAULT_RELAY_DATA_DIR):
        root = Path(root_dir)
        self._lock = RLock()
        self._command_listener: Callable[[str], None] | None = None
        self._workspace_listener: Callable[[str], None] | None = None
        self._nonterminal_command_ids_by_node: dict[str, set[str]] = {}
        self.nodes_dir = root / "daemon" / "nodes"
        self.commands_dir = root / "daemon" / "commands"
        self.runs_dir = root / "daemon" / "runs"
        self.run_requests_dir = root / "daemon" / "run-requests"
        self.run_request_claim_lock_path = root / "daemon" / ".run-request-claims.lock"
        self.pending_node_claim_lock_path = (
            root / "daemon" / ".pending-node-claims.lock"
        )
        self.events_dir = root / "daemon" / "events"
        for path in (
            self.nodes_dir,
            self.commands_dir,
            self.runs_dir,
            self.run_requests_dir,
            self.events_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        self._rebuild_command_index()

    def set_command_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None:
        self._command_listener = listener

    def _notify_command(self, node_id: str) -> None:
        if not self._command_listener:
            return
        try:
            self._command_listener(node_id)
        except Exception:  # noqa: BLE001 - notification hints must not fail writes
            logger.exception("Daemon command listener failed", node_id=node_id)

    def set_workspace_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None:
        self._workspace_listener = listener

    def _notify_workspace(self, command_id: str) -> None:
        if not self._workspace_listener:
            return
        try:
            self._workspace_listener(command_id)
        except Exception:  # noqa: BLE001 - notification hints must not fail writes
            logger.exception(
                "Workspace response listener failed", command_id=command_id
            )

    def register_node(self, sandbox: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            node = _node_for_storage(sandbox)
            previous = self.get_node(node["id"])
            node = preserve_node_retirement(previous, node)
            changed = node_registration_changed(previous, node)
            self._write_node(node)
            # The row always advances lastSeenAt; only a material change is worth
            # an event. See node_registration_changed.
            if changed:
                self.append_daemon_event(
                    daemon_event(
                        "daemon.node.registered", {"node": _node_for_event(node)}
                    )
                )
            return node

    def claim_pending_node(
        self, sandbox: dict[str, Any]
    ) -> tuple[dict[str, Any], bool]:
        """Atomically create or adopt one provisional employee device."""
        node = _node_for_storage(sandbox)
        enrollment_key = node.get("enrollmentKey")
        if not enrollment_key:
            raise ValueError("Pending local nodes require an enrollment key.")
        with self._lock, self._pending_node_claim_lock():
            for existing in self.list_nodes():
                if (
                    existing.get("managedNodeId")
                    or existing.get("retiredAt")
                    or existing.get("status") == "deleted"
                ):
                    continue
                existing_key = existing.get("enrollmentKey") or local_enrollment_key(
                    existing.get("employeeId"), existing.get("workspacePath")
                )
                if existing_key != enrollment_key:
                    continue
                if not existing.get("enrollmentKey"):
                    existing = {**existing, "enrollmentKey": enrollment_key}
                    self.register_node(existing)
                return existing, False
            return self.register_node(node), True

    @contextmanager
    def _pending_node_claim_lock(self) -> Iterator[None]:
        with self.pending_node_claim_lock_path.open(
            "a+", encoding="utf-8"
        ) as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def mark_node_seen(
        self, node_id: str, patch: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        with self._lock:
            node = self.get_node(node_id)
            if not node:
                return None
            now = now_iso()
            patch = patch or {}
            updated = {
                **node,
                **{k: v for k, v in patch.items() if v is not None},
                "updatedAt": now,
                "lastSeenAt": now,
            }
            updated = preserve_node_retirement(node, updated)
            if patch.get("lastError") is None and "lastError" in patch:
                updated.pop("lastError", None)
            self._write_node(updated)
            # Deliberately not logged as a daemon event: heartbeats arrive
            # several times per second per node, and `lastSeenAt` on the node
            # record is the only thing anything reads.
            return updated

    def assign_node_employee(self, node_id: str, employee_id: str) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        if node.get("employeeId"):
            raise ValueError("Daemon node is already assigned.")
        updated = {**node, "employeeId": employee_id, "updatedAt": now_iso()}
        updated["nodeLocation"] = assigned_node_location(updated)
        self._write_node(updated)
        self.append_daemon_event(
            daemon_event(
                "daemon.node.assigned", {"nodeId": node_id, "employeeId": employee_id}
            )
        )
        return updated

    def update_node_disabled_agents(
        self, node_id: str, disabled_agents: list[str]
    ) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        updated, event = node_setting_update(
            node_id,
            node,
            field="disabledAgents",
            value=disabled_agents,
            event_type="daemon.node.disabled_agents_updated",
        )
        self._write_node(updated)
        self.append_daemon_event(event)
        return updated

    def update_node_display_name(
        self, node_id: str, display_name: str | None
    ) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        updated, event = node_setting_update(
            node_id,
            node,
            field="displayName",
            value=display_name,
            event_type="daemon.node.display_name_updated",
        )
        self._write_node(updated)
        self.append_daemon_event(event)
        return updated

    def update_node_agent_role_defaults(
        self, node_id: str, role_defaults: dict[str, str]
    ) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        updated, event = node_setting_update(
            node_id,
            node,
            field="agentRoleDefaults",
            value=role_defaults,
            event_type="daemon.node.agent_role_defaults_updated",
        )
        self._write_node(updated)
        self.append_daemon_event(event)
        return updated

    def update_node_agent_role_overrides(
        self, node_id: str, role_overrides: dict[str, str]
    ) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        updated, event = node_setting_update(
            node_id,
            node,
            field="agentRoleOverrides",
            value=role_overrides,
            event_type="daemon.node.agent_role_overrides_updated",
        )
        self._write_node(updated)
        self.append_daemon_event(event)
        return updated

    def unassign_node_employee(self, node_id: str) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        previous = node.get("employeeId")
        updated = {
            k: v
            for k, v in node.items()
            if k not in ("employeeId", "agentRoleOverrides")
        }
        updated["updatedAt"] = now_iso()
        self._write_node(updated)
        self.append_daemon_event(
            daemon_event(
                "daemon.node.unassigned",
                {"nodeId": node_id, "previousEmployeeId": previous},
            )
        )
        return updated

    def delete_node(self, node_id: str) -> None:
        node_path = self.nodes_dir / f"{safe_name(node_id)}.json"
        if not node_path.exists():
            raise KeyError(node_id)
        for record in self._list_commands():
            if record.get("nodeId") == node_id:
                command_path = self.commands_dir / f"{safe_name(record['id'])}.json"
                command_path.unlink(missing_ok=True)
                self._remove_command_from_index(node_id, record["id"])
        for path in self.runs_dir.glob("*.json"):
            run = _read_json(path)
            if run.get("nodeId") == node_id:
                path.unlink(missing_ok=True)
        for path in self.run_requests_dir.glob("*.json"):
            request = _read_json(path)
            if request.get("nodeId") == node_id:
                path.unlink(missing_ok=True)
        node_path.unlink()
        self.append_daemon_event(
            daemon_event("daemon.node.deleted", {"nodeId": node_id})
        )

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        path = self.nodes_dir / f"{safe_name(node_id)}.json"
        return _read_json(path) if path.exists() else None

    def list_nodes(self) -> list[dict[str, Any]]:
        return [_read_json(path) for path in self.nodes_dir.glob("*.json")]

    def get_command(self, command_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._get_command(command_id)

    def enqueue_command(self, node_id: str, command: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if (
                len(self._nonterminal_command_ids_by_node.get(node_id, set()))
                >= daemon_command_queue_limit()
            ):
                raise ValueError(f"Daemon node {node_id} command queue is full.")
            self.stage_command(node_id, command)
            return self.publish_command(command["id"])

    def stage_command(
        self,
        node_id: str,
        command: dict[str, Any],
        *,
        request_id: str | None = None,
        claim_id: str | None = None,
    ) -> dict[str, Any] | None:
        claim_scope = (
            self._run_request_claim_lock() if request_id is not None else nullcontext()
        )
        with self._lock, claim_scope:
            if request_id is not None:
                request = self.get_run_request(request_id)
                if (
                    not request
                    or request.get("status") != "dispatching"
                    or (request.get("state") or {}).get(DISPATCH_CLAIM_ID_STATE_KEY)
                    != claim_id
                ):
                    return None
            now = now_iso()
            record = {
                "id": command["id"],
                "nodeId": node_id,
                "command": command,
                "status": "pending",
                "createdAt": now,
                "updatedAt": now,
            }
            _write_json(self.commands_dir / f"{safe_name(record['id'])}.json", record)
            if command["type"] == "run.start":
                self._write_run(
                    {
                        "nodeId": node_id,
                        "commandId": command["id"],
                        "sessionId": command["sessionId"],
                        "runId": command["runId"],
                        "agent": command["agent"],
                        **(
                            {"logicalAgentId": command["logicalAgentId"]}
                            if command.get("logicalAgentId")
                            else {}
                        ),
                        **(
                            {"placementId": command["placementId"]}
                            if command.get("placementId")
                            else {}
                        ),
                        "taskGoal": command["taskGoal"],
                        **(
                            {"workspacePath": command["workspacePath"]}
                            if command.get("workspacePath")
                            else {}
                        ),
                        "status": "pending",
                        "startedAt": now,
                    }
                )
            self.append_daemon_event(
                daemon_event(
                    "daemon.command.staged",
                    {"nodeId": node_id, "commandId": command["id"]},
                )
            )
            return record

    def publish_command(
        self, command_id: str, *, request_id: str | None = None
    ) -> dict[str, Any] | None:
        claim_scope = (
            self._run_request_claim_lock() if request_id is not None else nullcontext()
        )
        with self._lock, claim_scope:
            if request_id is not None:
                request = self.get_run_request(request_id)
                if not (
                    request
                    and request.get("status") == "running"
                    and request.get("currentCommandId") == command_id
                ):
                    return None
            record = self._get_command(command_id)
            if not record:
                raise KeyError(command_id)
            if record["status"] != "pending":
                return record
            now = now_iso()
            updated = {**record, "status": "queued", "updatedAt": now}
            _write_json(self.commands_dir / f"{safe_name(command_id)}.json", updated)
            run = self._get_run(record["command"].get("runId", ""))
            if run and run.get("status") == "pending":
                self._write_run({**run, "status": "running"})
            self._index_command(updated)
            self.append_daemon_event(
                daemon_event(
                    "daemon.command.queued",
                    {"nodeId": record["nodeId"], "commandId": command_id},
                )
            )
        self._notify_command(record["nodeId"])
        return updated

    def record_workspace_response(self, node_id: str, response: dict[str, Any]) -> None:
        command_id = str(response["commandId"])
        with self._lock:
            record = self._get_command(command_id)
            if not record:
                raise KeyError(command_id)
            if record.get("nodeId") != node_id:
                raise PermissionError(
                    "Workspace command belongs to a different daemon node."
                )
            if not str((record.get("command") or {}).get("type") or "").startswith(
                "workspace."
            ):
                raise ValueError("Command is not a workspace query.")
            if record.get("status") == "completed":
                if self.get_workspace_response(command_id) == response:
                    return
                raise ValueError("Workspace command already has a different response.")
            if record.get("status") != "dispatched":
                raise ValueError("Workspace command is not actively dispatched.")
            completed = {
                **record,
                "status": "completed",
                "updatedAt": now_iso(),
                "completedAt": now_iso(),
            }
            _write_json(self.commands_dir / f"{safe_name(command_id)}.json", completed)
            self._remove_command_from_index(node_id, command_id)
            self.append_daemon_event(
                daemon_event(
                    "daemon.workspace.response",
                    {
                        "nodeId": node_id,
                        "commandId": command_id,
                        "response": response,
                    },
                )
            )
        self._notify_workspace(command_id)

    def get_workspace_response(self, command_id: str) -> dict[str, Any] | None:
        events_path = self.events_dir / "events.jsonl"
        if not events_path.exists():
            return None
        with self._lock:
            for event in reversed(_read_jsonl(events_path)):
                if (
                    event.get("type") == "daemon.workspace.response"
                    and event.get("commandId") == command_id
                ):
                    response = event.get("response")
                    return response if isinstance(response, dict) else None
        return None

    def discard_staged_command(self, command_id: str) -> None:
        with self._lock:
            record = self._get_command(command_id)
            if not record or record.get("status") != "pending":
                return
            (self.commands_dir / f"{safe_name(command_id)}.json").unlink(
                missing_ok=True
            )
            run_id = record.get("command", {}).get("runId")
            if run_id:
                (self.runs_dir / f"{safe_name(run_id)}.json").unlink(missing_ok=True)

    def update_staged_command(
        self, command_id: str, command: dict[str, Any]
    ) -> dict[str, Any] | None:
        with self._lock:
            record = self._get_command(command_id)
            if not record or record.get("status") != "pending":
                return None
            updated = {**record, "command": command, "updatedAt": now_iso()}
            _write_json(self.commands_dir / f"{safe_name(command_id)}.json", updated)
            return updated

    def take_queued_commands(
        self, node_id: str, limit: int = 2**53, lease_seconds: float = 60.0
    ) -> list[dict[str, Any]]:
        with self._lock, self._run_request_claim_lock():
            now = now_iso()
            # Safe only inside the single backend process that owns this store.
            records = [
                record
                for record in self._command_records_for_node(node_id)
                if record["nodeId"] == node_id and command_is_available(record, now)
            ]
            records = sorted(records, key=lambda item: item["createdAt"])[:limit]
            result = []
            for record in records:
                command = record.get("command") or {}
                request_id = command.get("_runRequestId")
                if command.get("type") == "run.start" and request_id:
                    request = self.get_run_request(request_id)
                    if not (
                        request
                        and request.get("status") == "running"
                        and request.get("currentCommandId") == command.get("id")
                    ):
                        self.mark_command_cancelled(
                            node_id,
                            {
                                "type": "run.cancelled",
                                "commandId": command["id"],
                                "sessionId": command["sessionId"],
                                "runId": command["runId"],
                                "agent": command["agent"],
                                "reason": "Run request became terminal before command claim.",
                            },
                        )
                        continue
                attempt = int(record.get("attempt") or 0) + 1
                updated = {
                    **record,
                    "status": "dispatched",
                    "updatedAt": now,
                    "dispatchedAt": now,
                    "leaseId": new_relay_id("lease"),
                    "leaseExpiresAt": lease_expires_at(now, lease_seconds),
                    "attempt": attempt,
                }
                _write_json(
                    self.commands_dir / f"{safe_name(record['id'])}.json", updated
                )
                if updated["status"] in TERMINAL_DAEMON_STATUSES:
                    self._remove_command_from_index(node_id, updated["id"])
                else:
                    self._index_command(updated)
                self.append_daemon_event(
                    daemon_event(
                        "daemon.command.dispatched",
                        {"nodeId": node_id, "commandId": record["id"]},
                    )
                )
                result.append(updated)
            return result

    def queued_command_count(self, node_id: str) -> int:
        now = now_iso()
        return len(
            [
                record
                for record in self._command_records_for_node(node_id)
                if command_is_available(record, now)
            ]
        )

    def queued_command_counts(self) -> dict[str, int]:
        now = now_iso()
        return {
            node_id: len(
                [
                    record
                    for record in self._command_records_for_node(node_id)
                    if command_is_available(record, now)
                ]
            )
            for node_id in list(self._nonterminal_command_ids_by_node.keys())
        }

    def renew_command_leases(
        self,
        node_id: str,
        command_leases: list[tuple[str, str | None]],
        lease_seconds: float = 60.0,
    ) -> None:
        if not command_leases:
            return
        with self._lock:
            now = now_iso()
            requested = dict(command_leases)
            for record in self._command_records_for_node(node_id):
                expected_lease_id = requested.get(record["id"])
                if (
                    record["nodeId"] != node_id
                    or record["id"] not in requested
                    or record.get("status") != "dispatched"
                    or (
                        expected_lease_id is not None
                        and record.get("leaseId") != expected_lease_id
                    )
                ):
                    continue
                updated = {
                    **record,
                    "updatedAt": now,
                    "leaseExpiresAt": lease_expires_at(now, lease_seconds),
                }
                _write_json(
                    self.commands_dir / f"{safe_name(record['id'])}.json", updated
                )
                self.append_daemon_event(
                    daemon_event(
                        "daemon.command.lease_renewed",
                        {
                            "nodeId": node_id,
                            "commandId": record["id"],
                            "leaseId": record.get("leaseId"),
                            "leaseExpiresAt": updated["leaseExpiresAt"],
                        },
                    )
                )

    def list_active_runs(self, node_id: str | None = None) -> list[dict[str, Any]]:
        runs = [_read_json(path) for path in self.runs_dir.glob("*.json")]
        return [
            run
            for run in runs
            if run.get("status") == "running"
            and (node_id is None or run.get("nodeId") == node_id)
        ]

    def create_run_request(self, request: dict[str, Any]) -> dict[str, Any]:
        now = now_iso()
        record = {
            "id": request.get("id") or new_database_id(),
            "status": "running",
            "currentIndex": 0,
            "createdAt": now,
            "updatedAt": now,
            **request,
        }
        with self._lock, self._run_request_claim_lock():
            existing = self.get_run_request(record["id"])
            if existing:
                return existing
            if self.active_run_request_for_session_any_node(record["sessionId"]):
                raise ValueError(
                    f"Session {record['sessionId']} already has an active daemon run."
                )
            node = self.get_node(record["nodeId"])
            if node:
                _assert_node_run_request_capacity(
                    node,
                    self.list_active_run_requests(record["nodeId"]),
                    record,
                )
            _write_json(
                self.run_requests_dir / f"{safe_name(record['id'])}.json", record
            )
            self.append_daemon_event(
                daemon_event(
                    "daemon.run_request.created",
                    {
                        "nodeId": record["nodeId"],
                        "runRequestId": record["id"],
                        "sessionId": record["sessionId"],
                    },
                )
            )
        return record

    @contextmanager
    def _run_request_claim_lock(self) -> Iterator[None]:
        with self.run_request_claim_lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def get_run_request(self, request_id: str) -> dict[str, Any] | None:
        path = self.run_requests_dir / f"{safe_name(request_id)}.json"
        return _read_json(path) if path.exists() else None

    def list_active_run_requests(
        self, node_id: str | None = None
    ) -> list[dict[str, Any]]:
        requests = [_read_json(path) for path in self.run_requests_dir.glob("*.json")]
        return [
            request
            for request in requests
            if request.get("status") in ACTIVE_RUN_REQUEST_STATUSES
            and (node_id is None or request.get("nodeId") == node_id)
        ]

    def active_run_request_for_session(
        self, node_id: str, session_id: str
    ) -> dict[str, Any] | None:
        return next(
            (
                request
                for request in self.list_active_run_requests(node_id)
                if request["sessionId"] == session_id
            ),
            None,
        )

    def active_run_request_for_session_any_node(
        self, session_id: str
    ) -> dict[str, Any] | None:
        return next(
            (
                request
                for request in self.list_active_run_requests()
                if request["sessionId"] == session_id
            ),
            None,
        )

    def run_request_for_command(self, command_id: str) -> dict[str, Any] | None:
        return next(
            (
                request
                for request in self.list_active_run_requests()
                if request.get("currentCommandId") == command_id
            ),
            None,
        )

    def pending_command_for_run_request(self, request_id: str) -> dict[str, Any] | None:
        with self._lock:
            return next(
                (
                    record
                    for record in self._list_commands()
                    if record.get("status") == "pending"
                    and record.get("command", {}).get("_runRequestId") == request_id
                ),
                None,
            )

    def claim_terminal_run_request(
        self,
        command_id: str,
        event: dict[str, Any],
        claim_id: str,
        lease_seconds: float,
    ) -> dict[str, Any] | None:
        with self._lock:
            request = self.run_request_for_command(command_id)
            if not request:
                return None
            state = dict(request.get("state") or {})
            now = now_iso()
            if request.get("status") == "finalizing":
                expires_at = state.get(TERMINAL_CLAIM_EXPIRES_STATE_KEY)
                if expires_at and _parse_iso(expires_at) > _parse_iso(now):
                    return None
            state.update(
                {
                    TERMINAL_EVENT_STATE_KEY: event,
                    TERMINAL_CLAIM_ID_STATE_KEY: claim_id,
                    TERMINAL_CLAIM_EXPIRES_STATE_KEY: lease_expires_at(
                        now, lease_seconds
                    ),
                }
            )
            return self.update_run_request(
                request["id"], {"status": "finalizing", "state": state}
            )

    def claim_run_request_dispatch(
        self, request_id: str, claim_id: str, lease_seconds: float
    ) -> dict[str, Any] | None:
        with self._lock, self._run_request_claim_lock():
            request = self.get_run_request(request_id)
            if (
                not request
                or request.get("status") not in ("running", "dispatching")
                or request.get("currentCommandId")
            ):
                return None
            state = dict(request.get("state") or {})
            now = now_iso()
            if request.get("status") == "dispatching":
                expires_at = state.get(DISPATCH_CLAIM_EXPIRES_STATE_KEY)
                if expires_at and _parse_iso(expires_at) > _parse_iso(now):
                    return None
            state.update(
                {
                    DISPATCH_CLAIM_ID_STATE_KEY: claim_id,
                    DISPATCH_CLAIM_EXPIRES_STATE_KEY: lease_expires_at(
                        now, lease_seconds
                    ),
                }
            )
            return self.update_run_request(
                request_id, {"status": "dispatching", "state": state}
            )

    def update_run_request(
        self, request_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]:
        with self._lock:
            current = self.get_run_request(request_id)
            if not current:
                raise KeyError(request_id)
            now = now_iso()
            updated = {**current, **patch, "updatedAt": now}
            if patch.get("status") in ("completed", "failed", "cancelled"):
                updated["completedAt"] = now
            _write_json(
                self.run_requests_dir / f"{safe_name(request_id)}.json", updated
            )
            self.append_daemon_event(
                daemon_event(
                    "daemon.run_request.updated",
                    {
                        "nodeId": updated["nodeId"],
                        "runRequestId": updated["id"],
                        "status": updated["status"],
                    },
                )
            )
            return updated

    def update_run_request_if_status(
        self, request_id: str, expected_status: str, patch: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Apply a run-request transition only from the expected state."""
        with self._lock, self._run_request_claim_lock():
            current = self.get_run_request(request_id)
            if not current or current.get("status") != expected_status:
                return None
            return self.update_run_request(request_id, patch)

    def update_run_request_if_claimed(
        self,
        request_id: str,
        claim_key: str,
        claim_id: str,
        patch: dict[str, Any],
    ) -> dict[str, Any] | None:
        with self._lock, self._run_request_claim_lock():
            current = self.get_run_request(request_id)
            if (
                not current
                or (current.get("state") or {}).get(claim_key) != claim_id
                or (
                    claim_key == DISPATCH_CLAIM_ID_STATE_KEY
                    and current.get("status") != "dispatching"
                )
            ):
                return None
            return self.update_run_request(request_id, patch)

    def mark_command_completed(self, node_id: str, event: dict[str, Any]) -> bool:
        return self._mark_command_terminal(
            node_id, event, "completed", event.get("exitCode"), None
        )

    def mark_command_failed(self, node_id: str, event: dict[str, Any]) -> bool:
        return self._mark_command_terminal(
            node_id, event, "failed", event.get("exitCode"), event.get("error")
        )

    def mark_command_cancelled(self, node_id: str, event: dict[str, Any]) -> bool:
        return self._mark_command_terminal(
            node_id, event, "cancelled", None, event.get("reason")
        )

    def mark_cancel_commands_completed(
        self, node_id: str, target_command_id: str
    ) -> None:
        with self._lock:
            now = now_iso()
            for record in self._command_records_for_node(node_id):
                command = record["command"]
                if (
                    command["type"] != "run.cancel"
                    or command.get("commandId") != target_command_id
                ):
                    continue
                updated, completion_event = completed_cancel_record(record, now)
                _write_json(
                    self.commands_dir / f"{safe_name(record['id'])}.json", updated
                )
                self._remove_command_from_index(node_id, record["id"])
                self.append_daemon_event(completion_event)

    def prune_terminal_records(
        self, retention_seconds: float, per_node_limit: int
    ) -> dict[str, int]:
        cutoff = _format_iso(
            _parse_iso(now_iso()) - timedelta(seconds=max(0.0, retention_seconds))
        )
        per_node_limit = max(0, per_node_limit)
        with self._lock:
            deleted_commands = self._prune_terminal_files(
                self.commands_dir,
                cutoff=cutoff,
                per_node_limit=per_node_limit,
                on_delete=lambda record: self._remove_command_from_index(
                    record["nodeId"], record["id"]
                ),
            )
            deleted_runs = self._prune_terminal_files(
                self.runs_dir,
                cutoff=cutoff,
                per_node_limit=per_node_limit,
            )
            deleted_events = self._prune_command_events(cutoff)
        return {
            "commands": deleted_commands,
            "runs": deleted_runs,
            "events": deleted_events,
        }

    def _prune_command_events(self, cutoff: str) -> int:
        events_path = self.events_dir / "events.jsonl"
        if not events_path.exists():
            return 0
        events = _read_jsonl(events_path)
        retained = [
            event
            for event in events
            if not (
                daemon_event_is_prunable(str(event.get("type", "")))
                and str(event.get("timestamp", "")) <= cutoff
            )
        ]
        deleted = len(events) - len(retained)
        if deleted:
            _write_jsonl(events_path, retained)
        return deleted

    def append_daemon_event(self, event: dict[str, Any]) -> None:
        _append_jsonl(self.events_dir / "events.jsonl", event)

    def historical_managed_runtime_ids(self, managed_node_id: str) -> set[str]:
        events_path = self.events_dir / "events.jsonl"
        if not events_path.exists():
            return set()
        return {
            runtime_id
            for runtime_id, current_managed_node_id in _managed_runtime_identity_map(
                _read_jsonl(events_path)
            ).items()
            if current_managed_node_id == managed_node_id
        }

    def historical_managed_node_id(self, runtime_id: str) -> str | None:
        return self.historical_managed_node_ids({runtime_id}).get(runtime_id)

    def historical_managed_node_ids(self, runtime_ids: set[str]) -> dict[str, str]:
        events_path = self.events_dir / "events.jsonl"
        if not events_path.exists():
            return {}
        identities = _managed_runtime_identity_map(_read_jsonl(events_path))
        return {
            current_runtime_id: managed_node_id
            for current_runtime_id, managed_node_id in identities.items()
            if current_runtime_id in runtime_ids
        }

    def _mark_command_terminal(
        self,
        node_id: str,
        event: dict[str, Any],
        status: str,
        exit_code: int | None,
        error: str | None,
    ) -> bool:
        with self._lock:
            now = now_iso()
            command = self._get_command(event["commandId"])
            if (
                not command
                or command.get("status") not in ("queued", "dispatched")
                or (
                    event.get("leaseId") is not None
                    and (
                        command.get("status") != "dispatched"
                        or command.get("leaseId") != event["leaseId"]
                    )
                )
            ):
                return False
            _write_json(
                self.commands_dir / f"{safe_name(command['id'])}.json",
                {
                    **command,
                    "command": {
                        **command["command"],
                        "_terminalEvent": event,
                    },
                    "status": status,
                    "updatedAt": now,
                    "completedAt": now,
                    **({"exitCode": exit_code} if exit_code is not None else {}),
                    **({"error": error} if error else {}),
                },
            )
            self._remove_command_from_index(node_id, command["id"])
            run = self._get_run(event["runId"]) or {
                "nodeId": node_id,
                "commandId": event["commandId"],
                "sessionId": event["sessionId"],
                "runId": event["runId"],
                "agent": event["agent"],
                "taskGoal": "",
                "startedAt": now,
            }
            self._write_run(
                {
                    **run,
                    "status": status,
                    "completedAt": now,
                    **({"exitCode": exit_code} if exit_code is not None else {}),
                    **({"error": error} if error else {}),
                }
            )
            event_type = {
                "completed": "daemon.command.completed",
                "failed": "daemon.command.failed",
                "cancelled": "daemon.command.cancelled",
            }[status]
            self.append_daemon_event(
                daemon_event(
                    event_type,
                    {
                        "nodeId": node_id,
                        "commandId": event["commandId"],
                        "runId": event["runId"],
                        **({"exitCode": exit_code} if exit_code is not None else {}),
                        **({"error": error} if error else {}),
                    },
                )
            )
            return True

    def _write_node(self, node: dict[str, Any]) -> None:
        stored = _node_for_storage(node)
        _write_json(self.nodes_dir / f"{safe_name(stored['id'])}.json", stored, 0o600)

    def _list_commands(self) -> list[dict[str, Any]]:
        return [_read_json(path) for path in self.commands_dir.glob("*.json")]

    def _get_command(self, command_id: str) -> dict[str, Any] | None:
        path = self.commands_dir / f"{safe_name(command_id)}.json"
        return _read_json(path) if path.exists() else None

    def _rebuild_command_index(self) -> None:
        self._nonterminal_command_ids_by_node = {}
        for record in self._list_commands():
            self._index_command(record)

    def _index_command(self, record: dict[str, Any]) -> None:
        if record.get("status") in TERMINAL_DAEMON_STATUSES:
            self._remove_command_from_index(record["nodeId"], record["id"])
            return
        self._nonterminal_command_ids_by_node.setdefault(record["nodeId"], set()).add(
            record["id"]
        )

    def _remove_command_from_index(self, node_id: str, command_id: str) -> None:
        command_ids = self._nonterminal_command_ids_by_node.get(node_id)
        if not command_ids:
            return
        command_ids.discard(command_id)
        if not command_ids:
            self._nonterminal_command_ids_by_node.pop(node_id, None)

    def _command_records_for_node(self, node_id: str) -> list[dict[str, Any]]:
        records = []
        for command_id in list(
            self._nonterminal_command_ids_by_node.get(node_id, set())
        ):
            record = self._get_command(command_id)
            if not record:
                self._remove_command_from_index(node_id, command_id)
                continue
            if record.get("status") in TERMINAL_DAEMON_STATUSES:
                self._remove_command_from_index(node_id, command_id)
                continue
            records.append(record)
        return records

    def _prune_terminal_files(
        self,
        directory: Path,
        *,
        cutoff: str,
        per_node_limit: int,
        on_delete: Any | None = None,
    ) -> int:
        records_by_node: dict[str, list[tuple[dict[str, Any], Path]]] = defaultdict(
            list
        )
        for path in directory.glob("*.json"):
            record = _read_json(path)
            if record.get("status") in TERMINAL_DAEMON_STATUSES:
                records_by_node[record["nodeId"]].append((record, path))
        deleted = 0
        for records in records_by_node.values():
            records.sort(key=lambda item: _terminal_timestamp(item[0]), reverse=True)
            for index, (record, path) in enumerate(records):
                if index < per_node_limit and _terminal_timestamp(record) > cutoff:
                    continue
                path.unlink(missing_ok=True)
                if on_delete:
                    on_delete(record)
                deleted += 1
        return deleted

    def _get_run(self, run_id: str) -> dict[str, Any] | None:
        path = self.runs_dir / f"{safe_name(run_id)}.json"
        return _read_json(path) if path.exists() else None

    def _write_run(self, run: dict[str, Any]) -> None:
        _write_json(self.runs_dir / f"{safe_name(run['runId'])}.json", run)


class DatabaseDaemonStore:
    metadata = shared_metadata

    nodes = Table(
        "daemon_nodes",
        metadata,
        database_id_column(),
        Column(
            "employee_id",
            entity_uuid_type(),
            ForeignKey(
                "employees.id",
                ondelete="SET NULL",
                name="fk_daemon_nodes_employee",
            ),
            nullable=True,
        ),
        Column("display_name", Text, nullable=True),
        Column("workspace_path", Text, nullable=True),
        Column("workspace_id", Text, nullable=True),
        Column("enrollment_key", Text, nullable=True),
        Column("sandbox_mode", Text, nullable=True),
        Column("node_location", Text, nullable=True),
        Column("managed_node_id", entity_uuid_type(), nullable=True),
        Column("provisioning_attempt_id", Text, nullable=True),
        Column("credential_version", Integer, nullable=False, default=1),
        Column("retired_at", DateTime(timezone=True), nullable=True),
        Column("status", Text, nullable=False),
        Column("max_concurrent_runs", Integer, nullable=False, default=1),
        Column("ui_token_hash", Text, nullable=True),
        Column("node_token_hash", Text, nullable=True),
        # Plaintext launch token for control-panel computers, so the owner can
        # reveal it again for a reconnect. Managed nodes leave this NULL.
        Column("node_token_secret", Text, nullable=True),
        Column("last_error", Text, nullable=True),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("last_seen_at", DateTime(timezone=True), nullable=True),
        Index("ix_daemon_nodes_employee_id", "employee_id"),
        Index("ix_daemon_nodes_updated_at", "updated_at"),
        Index("ix_daemon_nodes_last_seen_at", "last_seen_at"),
        Index("ix_daemon_nodes_managed_node_id", "managed_node_id"),
        Index("ix_daemon_nodes_workspace_id", "workspace_id"),
        Index("ix_daemon_nodes_retired_at", "retired_at"),
        Index(
            "uq_daemon_nodes_local_enrollment",
            "enrollment_key",
            unique=True,
            postgresql_where=text(
                "enrollment_key IS NOT NULL AND managed_node_id IS NULL "
                "AND retired_at IS NULL"
            ),
            sqlite_where=text(
                "enrollment_key IS NOT NULL AND managed_node_id IS NULL "
                "AND retired_at IS NULL"
            ),
        ),
        # A Computer is (employee_id, workspace_id) for an employee device and
        # managed_node_id for a managed one -- never the daemon's own id, which
        # changes every time the daemon process is replaced.
        Index(
            "uq_daemon_nodes_computer",
            "employee_id",
            "workspace_id",
            unique=True,
            postgresql_where=text("managed_node_id IS NULL AND retired_at IS NULL"),
            sqlite_where=text("managed_node_id IS NULL AND retired_at IS NULL"),
        ),
        Index(
            "uq_daemon_nodes_managed_runtime",
            "managed_node_id",
            unique=True,
            postgresql_where=text("managed_node_id IS NOT NULL AND retired_at IS NULL"),
            sqlite_where=text("managed_node_id IS NOT NULL AND retired_at IS NULL"),
        ),
    )
    # One row per agent a node knows about, replacing five parallel JSON maps
    # (agents, agent_details, disabled_agents, agent_role_defaults,
    # agent_role_overrides) that all keyed off the same agent name and had to be
    # kept aligned by convention.
    node_agents = Table(
        "daemon_node_agents",
        metadata,
        Column(
            "node_id",
            entity_uuid_type(),
            ForeignKey("daemon_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("agent", Text, nullable=False),
        Column("status", Text, nullable=False),
        Column("details", json_type(), nullable=True),
        Column("disabled", Boolean, nullable=False),
        Column("role_default", Text, nullable=True),
        Column("role_override", Text, nullable=True),
        PrimaryKeyConstraint("node_id", "agent", name="pk_daemon_node_agents"),
        # The point of normalizing: "which nodes can run codex" is an index
        # lookup instead of a scan over every node's JSON.
        Index("ix_daemon_node_agents_agent_status", "agent", "status"),
    )
    commands = Table(
        "daemon_commands",
        metadata,
        database_id_column(),
        Column(
            "node_id",
            entity_uuid_type(),
            ForeignKey("daemon_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("type", Text, nullable=False),
        Column("status", Text, nullable=False),
        Column("command", json_type(), nullable=False),
        Column("exit_code", Integer, nullable=True),
        Column("error", Text, nullable=True),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("dispatched_at", DateTime(timezone=True), nullable=True),
        Column("lease_id", Text, nullable=True),
        Column("lease_expires_at", DateTime(timezone=True), nullable=True),
        Column("attempt", Integer, nullable=False, default=0),
        Column("completed_at", DateTime(timezone=True), nullable=True),
        Index("ix_daemon_commands_node_status", "node_id", "status"),
        Index("ix_daemon_commands_created_at", "created_at"),
        Index("ix_daemon_commands_lease_expires_at", "lease_expires_at"),
    )
    runs = Table(
        "daemon_runs",
        metadata,
        database_id_column(),
        Column(
            "node_id",
            entity_uuid_type(),
            ForeignKey("daemon_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column(
            "command_id",
            entity_uuid_type(),
            ForeignKey("daemon_commands.id", ondelete="SET NULL"),
            nullable=True,
        ),
        Column("session_id", entity_uuid_type(), nullable=False),
        Column("agent", Text, nullable=False),
        Column("logical_agent_id", entity_uuid_type(), nullable=True),
        Column("placement_id", entity_uuid_type(), nullable=True),
        Column("task_goal", Text, nullable=False),
        Column("workspace_path", Text, nullable=True),
        Column("status", Text, nullable=False),
        Column("exit_code", Integer, nullable=True),
        Column("error", Text, nullable=True),
        Column("started_at", DateTime(timezone=True), nullable=False),
        Column("completed_at", DateTime(timezone=True), nullable=True),
        Index("ix_daemon_runs_node_status", "node_id", "status"),
        Index("ix_daemon_runs_session_id", "session_id"),
    )
    run_requests = Table(
        "daemon_run_requests",
        metadata,
        database_id_column(),
        Column(
            "node_id",
            entity_uuid_type(),
            ForeignKey("daemon_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("session_id", entity_uuid_type(), nullable=False),
        Column("task_id", entity_uuid_type(), nullable=True),
        Column("task_goal", Text, nullable=False),
        Column("assignments", json_type(), nullable=False),
        Column("current_index", Integer, nullable=False),
        Column("state", json_type(), nullable=False),
        Column("status", Text, nullable=False),
        Column("current_command_id", entity_uuid_type(), nullable=True),
        Column("current_run_id", entity_uuid_type(), nullable=True),
        Column("current_agent", Text, nullable=True),
        Column("current_started_at", DateTime(timezone=True), nullable=True),
        Column("current_progress_at", DateTime(timezone=True), nullable=True),
        Column("error", Text, nullable=True),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("completed_at", DateTime(timezone=True), nullable=True),
        Index("ix_daemon_run_requests_status", "status"),
        Index("ix_daemon_run_requests_node_status", "node_id", "status"),
        Index("ix_daemon_run_requests_session_id", "session_id"),
        Index("ix_daemon_run_requests_task_id", "task_id"),
    )
    Index(
        "uq_daemon_run_requests_active_session",
        run_requests.c.session_id,
        unique=True,
        postgresql_where=run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES),
        sqlite_where=run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES),
    )
    events = Table(
        "daemon_events",
        metadata,
        database_id_column(),
        Column("node_id", entity_uuid_type(), nullable=True),
        Column("command_id", entity_uuid_type(), nullable=True),
        Column("run_id", entity_uuid_type(), nullable=True),
        Column("type", Text, nullable=False),
        Column("timestamp", DateTime(timezone=True), nullable=False),
        Column("payload", json_type(), nullable=False),
        Index("ix_daemon_events_node_id", "node_id"),
        Index("ix_daemon_events_command_id", "command_id"),
        Index("ix_daemon_events_timestamp", "timestamp"),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        self._command_listener: Callable[[str], None] | None = None
        self._command_notification_channel: str | None = None
        self._workspace_listener: Callable[[str], None] | None = None
        self._workspace_notification_channel: str | None = None
        if create_schema:
            create_all_tables(self.engine)

    def set_command_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None:
        self._command_listener = listener
        self._command_notification_channel = database_channel

    def _notify_command(self, node_id: str) -> None:
        if not self._command_listener:
            return
        try:
            self._command_listener(node_id)
        except Exception:  # noqa: BLE001 - notification hints must not fail writes
            logger.exception("Daemon command listener failed", node_id=node_id)

    def set_workspace_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None:
        self._workspace_listener = listener
        self._workspace_notification_channel = database_channel

    def _notify_workspace(self, command_id: str) -> None:
        if not self._workspace_listener:
            return
        try:
            self._workspace_listener(command_id)
        except Exception:  # noqa: BLE001 - notification hints must not fail writes
            logger.exception(
                "Workspace response listener failed", command_id=command_id
            )

    def _write_node_agents(self, conn: Any, node_pk: str, node: dict[str, Any]) -> None:
        """Replace a node's daemon_node_agents rows, but only if they changed.

        Delete-then-insert rather than a merge, because the five maps are always
        written as a complete set: an agent dropped from the payload has to
        disappear. The equality check in front of it matters -- every node write
        funnels through here, including `mark_node_seen`, which fires several
        times per second per node and almost never changes the agent set. Without
        it each heartbeat would delete and reinsert every row, churning the table
        and its indexes for nothing.
        """
        desired = node_agent_rows(node, node_pk)
        current = (
            conn.execute(
                select(self.node_agents)
                .where(self.node_agents.c.node_id == node_pk)
                .order_by(self.node_agents.c.agent)
            )
            .mappings()
            .all()
        )
        if [_node_agent_identity(row) for row in current] == [
            _node_agent_identity(row) for row in desired
        ]:
            return
        conn.execute(
            delete(self.node_agents).where(self.node_agents.c.node_id == node_pk)
        )
        if desired:
            conn.execute(insert(self.node_agents), desired)

    def _save_node(
        self, conn: Any, node: dict[str, Any], *, database_id: str | None = None
    ) -> None:
        """Write a node row and its per-agent rows together."""
        node_pk = database_id or node["id"]
        values = node_to_row(node, database_id=node_pk)
        existing = conn.scalar(
            select(self.nodes.c.id).where(self.nodes.c.id == node_pk)
        )
        if existing:
            conn.execute(
                update(self.nodes).where(self.nodes.c.id == existing).values(**values)
            )
        else:
            conn.execute(insert(self.nodes).values(**values))
        self._write_node_agents(conn, node_pk, node)

    def _node_state_changed(self, conn: Any, node: dict[str, Any]) -> bool:
        """Whether writing `node` would change anything already persisted.

        Compares the persisted representation rather than the caller's dict: a
        node read back carries defaults the incoming payload omits, so comparing
        the two dicts directly reports a change every time.
        """
        node_pk = node["id"]
        row = (
            conn.execute(select(self.nodes).where(self.nodes.c.id == node_pk))
            .mappings()
            .first()
        )
        if row is None:
            return True
        desired = node_to_row(node, database_id=node_pk)
        if {
            key: _comparable_node_value(value)
            for key, value in desired.items()
            if key not in _NODE_LIVENESS_COLUMNS
        } != {
            key: _comparable_node_value(row[key])
            for key in desired
            if key not in _NODE_LIVENESS_COLUMNS
        }:
            return True
        current = (
            conn.execute(
                select(self.node_agents)
                .where(self.node_agents.c.node_id == node_pk)
                .order_by(self.node_agents.c.agent)
            )
            .mappings()
            .all()
        )
        return [_node_agent_identity(item) for item in current] != [
            _node_agent_identity(item) for item in node_agent_rows(node, node_pk)
        ]

    def register_node(self, sandbox: dict[str, Any]) -> dict[str, Any]:
        node = _node_for_storage(sandbox)
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.nodes)
                    .where(self.nodes.c.id == node["id"])
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            previous = row_to_node(row) if row else None
            node = preserve_node_retirement(previous, node)
            changed = self._node_state_changed(conn, node)
            self._save_node(conn, node)
            # The row always advances lastSeenAt; only a material change is worth
            # an event. See node_registration_changed.
            if changed:
                self._append_daemon_event(
                    conn,
                    daemon_event(
                        "daemon.node.registered", {"node": _node_for_event(node)}
                    ),
                )
        return node

    def claim_pending_node(
        self, sandbox: dict[str, Any]
    ) -> tuple[dict[str, Any], bool]:
        """Insert one provisional device or return the concurrent winner."""
        node = _node_for_storage(sandbox)
        enrollment_key = node.get("enrollmentKey")
        if not enrollment_key:
            raise ValueError("Pending local nodes require an enrollment key.")
        try:
            with store_transaction(self.engine) as conn:
                self._save_node(conn, node)
                self._append_daemon_event(
                    conn,
                    daemon_event(
                        "daemon.node.registered", {"node": _node_for_event(node)}
                    ),
                )
            return node, True
        except IntegrityError:
            with store_transaction(self.engine) as conn:
                row = (
                    conn.execute(
                        select(self.nodes).where(
                            self.nodes.c.enrollment_key == enrollment_key,
                            self.nodes.c.managed_node_id.is_(None),
                            self.nodes.c.retired_at.is_(None),
                        )
                    )
                    .mappings()
                    .first()
                )
                if row is None:
                    raise
                agents = self._node_agents_by_node(conn, [str(row["id"])])
            existing = apply_node_agents(
                row_to_node(row), agents.get(str(row["id"]), [])
            )
            return existing, False

    def mark_node_seen(
        self, node_id: str, patch: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.nodes)
                    .where(self.nodes.c.id == node_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            node_pk = str(row["id"])
            agents = self._node_agents_by_node(conn, [node_pk])
            node = apply_node_agents(row_to_node(row), agents.get(node_pk, []))
            now = now_iso()
            patch = patch or {}
            updated = {
                **node,
                **{k: v for k, v in patch.items() if v is not None},
                "updatedAt": now,
                "lastSeenAt": now,
            }
            updated = preserve_node_retirement(node, updated)
            if patch.get("lastError") is None and "lastError" in patch:
                updated.pop("lastError", None)
            self._save_node(conn, updated, database_id=node_pk)
            # Deliberately not logged as a daemon event: heartbeats arrive
            # several times per second per node, and `lastSeenAt` on the node
            # record is the only thing anything reads.
        return updated

    def assign_node_employee(self, node_id: str, employee_id: str) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        if node.get("employeeId"):
            raise ValueError("Daemon node is already assigned.")
        updated = {**node, "employeeId": employee_id, "updatedAt": now_iso()}
        updated["nodeLocation"] = assigned_node_location(updated)
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            self._save_node(conn, updated, database_id=node_pk)
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.node.assigned",
                    {"nodeId": node_id, "employeeId": employee_id},
                ),
            )
        return updated

    def update_node_disabled_agents(
        self, node_id: str, disabled_agents: list[str]
    ) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        updated, event = node_setting_update(
            node_id,
            node,
            field="disabledAgents",
            value=disabled_agents,
            event_type="daemon.node.disabled_agents_updated",
        )
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            self._save_node(conn, updated, database_id=node_pk)
            self._append_daemon_event(conn, event)
        return updated

    def update_node_display_name(
        self, node_id: str, display_name: str | None
    ) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        updated, event = node_setting_update(
            node_id,
            node,
            field="displayName",
            value=display_name,
            event_type="daemon.node.display_name_updated",
        )
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            self._save_node(conn, updated, database_id=node_pk)
            self._append_daemon_event(conn, event)
        return updated

    def update_node_agent_role_defaults(
        self, node_id: str, role_defaults: dict[str, str]
    ) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        updated, event = node_setting_update(
            node_id,
            node,
            field="agentRoleDefaults",
            value=role_defaults,
            event_type="daemon.node.agent_role_defaults_updated",
        )
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            self._save_node(conn, updated, database_id=node_pk)
            self._append_daemon_event(conn, event)
        return updated

    def update_node_agent_role_overrides(
        self, node_id: str, role_overrides: dict[str, str]
    ) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        updated, event = node_setting_update(
            node_id,
            node,
            field="agentRoleOverrides",
            value=role_overrides,
            event_type="daemon.node.agent_role_overrides_updated",
        )
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            self._save_node(conn, updated, database_id=node_pk)
            self._append_daemon_event(conn, event)
        return updated

    def unassign_node_employee(self, node_id: str) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        previous = node.get("employeeId")
        updated = {
            k: v
            for k, v in node.items()
            if k not in ("employeeId", "agentRoleOverrides")
        }
        updated["updatedAt"] = now_iso()
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            # `updated` drops employeeId entirely, so node_to_row would leave the
            # column untouched rather than clearing it.
            self._save_node(conn, {**updated, "employeeId": None}, database_id=node_pk)
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.node.unassigned",
                    {"nodeId": node_id, "previousEmployeeId": previous},
                ),
            )
        return updated

    def delete_node(self, node_id: str) -> None:
        with store_transaction(self.engine) as conn:
            node_pk = conn.scalar(
                select(self.nodes.c.id).where(self.nodes.c.id == node_id)
            )
            if not node_pk:
                raise KeyError(node_id)
            conn.execute(
                delete(self.run_requests).where(self.run_requests.c.node_id == node_pk)
            )
            conn.execute(delete(self.runs).where(self.runs.c.node_id == node_pk))
            conn.execute(
                delete(self.commands).where(self.commands.c.node_id == node_pk)
            )
            # Deleted explicitly like the other children: SQLite does not
            # enforce ON DELETE CASCADE unless foreign_keys=ON.
            conn.execute(
                delete(self.node_agents).where(self.node_agents.c.node_id == node_pk)
            )
            conn.execute(delete(self.nodes).where(self.nodes.c.id == node_pk))
            self._append_daemon_event(
                conn, daemon_event("daemon.node.deleted", {"nodeId": node_id})
            )

    def _node_agents_by_node(
        self, conn: Any, node_pks: list[str]
    ) -> dict[str, list[Any]]:
        if not node_pks:
            return {}
        rows = (
            conn.execute(
                select(self.node_agents)
                .where(self.node_agents.c.node_id.in_(node_pks))
                .order_by(self.node_agents.c.node_id, self.node_agents.c.agent)
            )
            .mappings()
            .all()
        )
        grouped: dict[str, list[Any]] = {}
        for row in rows:
            grouped.setdefault(str(row["node_id"]), []).append(row)
        return grouped

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(select(self.nodes).where(self.nodes.c.id == node_id))
                .mappings()
                .first()
            )
            if not row:
                return None
            agents = self._node_agents_by_node(conn, [str(row["id"])])
        return apply_node_agents(row_to_node(row), agents.get(str(row["id"]), []))

    def list_nodes(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(self.nodes)).mappings().all()
            agents = self._node_agents_by_node(conn, [str(row["id"]) for row in rows])
        return [
            apply_node_agents(row_to_node(row), agents.get(str(row["id"]), []))
            for row in rows
        ]

    def get_command(self, command_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.commands).where(self.commands.c.id == command_id)
                )
                .mappings()
                .first()
            )
        return row_to_command(row) if row else None

    def enqueue_command(self, node_id: str, command: dict[str, Any]) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            node_pk = conn.scalar(
                select(self.nodes.c.id)
                .where(self.nodes.c.id == node_id)
                .with_for_update()
            )
            if not node_pk:
                raise KeyError(node_id)
            queued = conn.scalar(
                select(func.count())
                .select_from(self.commands)
                .where(self.commands.c.node_id == node_pk)
                .where(~self.commands.c.status.in_(TERMINAL_DAEMON_STATUSES))
            )
            if int(queued or 0) >= daemon_command_queue_limit():
                raise ValueError(f"Daemon node {node_id} command queue is full.")
            self.stage_command(node_id, command)
        return self.publish_command(command["id"])

    def stage_command(
        self,
        node_id: str,
        command: dict[str, Any],
        *,
        request_id: str | None = None,
        claim_id: str | None = None,
    ) -> dict[str, Any] | None:
        now = now_iso()
        record = {
            "id": command["id"],
            "nodeId": node_id,
            "command": command,
            "status": "pending",
            "createdAt": now,
            "updatedAt": now,
        }
        with store_transaction(self.engine) as conn:
            if request_id is not None:
                request_row = (
                    conn.execute(
                        select(self.run_requests)
                        .where(self.run_requests.c.id == request_id)
                        .with_for_update()
                    )
                    .mappings()
                    .first()
                )
                if (
                    not request_row
                    or request_row.get("status") != "dispatching"
                    or (request_row.get("state") or {}).get(DISPATCH_CLAIM_ID_STATE_KEY)
                    != claim_id
                ):
                    return None
            node_pk = self._node_pk(conn, node_id)
            command_row = command_to_row(record, node_pk=node_pk)
            conn.execute(insert(self.commands).values(**command_row))
            if command["type"] == "run.start":
                self._write_run(
                    conn,
                    {
                        "nodeId": node_id,
                        "commandId": command["id"],
                        "sessionId": command["sessionId"],
                        "runId": command["runId"],
                        "agent": command["agent"],
                        **(
                            {"logicalAgentId": command["logicalAgentId"]}
                            if command.get("logicalAgentId")
                            else {}
                        ),
                        **(
                            {"placementId": command["placementId"]}
                            if command.get("placementId")
                            else {}
                        ),
                        "taskGoal": command["taskGoal"],
                        **(
                            {"workspacePath": command["workspacePath"]}
                            if command.get("workspacePath")
                            else {}
                        ),
                        "status": "pending",
                        "startedAt": now,
                    },
                )
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.command.staged",
                    {"nodeId": node_id, "commandId": command["id"]},
                ),
            )
        return record

    def publish_command(
        self, command_id: str, *, request_id: str | None = None
    ) -> dict[str, Any] | None:
        now = now_iso()
        with store_transaction(self.engine) as conn:
            if request_id is not None:
                request_row = (
                    conn.execute(
                        select(self.run_requests)
                        .where(self.run_requests.c.id == request_id)
                        .with_for_update()
                    )
                    .mappings()
                    .first()
                )
                if not (
                    request_row
                    and request_row.get("status") == "running"
                    and str(request_row.get("current_command_id")) == command_id
                ):
                    return None
            row = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.id == command_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(command_id)
            record = row_to_command(row)
            if record["status"] != "pending":
                return record
            updated = {**record, "status": "queued", "updatedAt": now}
            conn.execute(
                update(self.commands)
                .where(self.commands.c.id == record["id"])
                .values(
                    **command_to_row(
                        updated,
                        database_id=record["id"],
                        node_pk=row["node_id"],
                    )
                )
            )
            conn.execute(
                update(self.runs)
                .where(self.runs.c.command_id == command_id)
                .where(self.runs.c.status == "pending")
                .values(status="running")
            )
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.command.queued",
                    {"nodeId": record["nodeId"], "commandId": command_id},
                ),
            )
            publish_database_notification(
                conn,
                self.engine,
                self._command_notification_channel,
                f"node:{record['nodeId']}",
            )
        self._notify_command(record["nodeId"])
        return updated

    def record_workspace_response(self, node_id: str, response: dict[str, Any]) -> None:
        command_id = str(response["commandId"])
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.id == command_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(command_id)
            command = row_to_command(row)
            if command.get("nodeId") != node_id:
                raise PermissionError(
                    "Workspace command belongs to a different daemon node."
                )
            if not str(command["command"].get("type") or "").startswith("workspace."):
                raise ValueError("Command is not a workspace query.")
            if command.get("status") == "completed":
                if self.get_workspace_response(command_id) == response:
                    return
                raise ValueError("Workspace command already has a different response.")
            if command.get("status") != "dispatched":
                raise ValueError("Workspace command is not actively dispatched.")
            now = _parse_iso(now_iso())
            conn.execute(
                update(self.commands)
                .where(self.commands.c.id == row["id"])
                .values(status="completed", updated_at=now, completed_at=now)
            )
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.workspace.response",
                    {
                        "nodeId": node_id,
                        "commandId": command_id,
                        "response": response,
                    },
                ),
            )
            publish_database_notification(
                conn,
                self.engine,
                self._workspace_notification_channel,
                f"workspace:{command_id}",
            )
        self._notify_workspace(command_id)

    def get_workspace_response(self, command_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.events.c.payload)
                    .where(self.events.c.command_id == command_id)
                    .where(self.events.c.type == "daemon.workspace.response")
                    .order_by(self.events.c.timestamp.desc())
                    .limit(1)
                )
                .mappings()
                .first()
            )
        response = (row or {}).get("payload", {}).get("response")
        return response if isinstance(response, dict) else None

    def discard_staged_command(self, command_id: str) -> None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.id == command_id)
                    .where(self.commands.c.status == "pending")
                )
                .mappings()
                .first()
            )
            if not row:
                return
            conn.execute(delete(self.runs).where(self.runs.c.command_id == command_id))
            conn.execute(delete(self.commands).where(self.commands.c.id == row["id"]))

    def update_staged_command(
        self, command_id: str, command: dict[str, Any]
    ) -> dict[str, Any] | None:
        now = now_iso()
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.id == command_id)
                    .where(self.commands.c.status == "pending")
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            record = row_to_command(row)
            updated = {**record, "command": command, "updatedAt": now}
            conn.execute(
                update(self.commands)
                .where(self.commands.c.id == row["id"])
                .values(
                    **command_to_row(
                        updated, database_id=row["id"], node_pk=row["node_id"]
                    )
                )
            )
        return updated

    def take_queued_commands(
        self, node_id: str, limit: int = 2**53, lease_seconds: float = 60.0
    ) -> list[dict[str, Any]]:
        now = now_iso()
        now_dt = _parse_iso(now)
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            available_condition = (self.commands.c.status == "queued") | (
                (self.commands.c.status == "dispatched")
                & (self.commands.c.lease_expires_at <= now_dt)
            )
            rows = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.node_id == node_pk)
                    .where(available_condition)
                    .order_by(self.commands.c.created_at)
                    .limit(limit)
                )
                .mappings()
                .all()
            )
            result = []
            for row in rows:
                record = row_to_command(row)
                command = record.get("command") or {}
                request_id = command.get("_runRequestId")
                if command.get("type") == "run.start" and request_id:
                    request_row = (
                        conn.execute(
                            select(self.run_requests)
                            .where(self.run_requests.c.id == request_id)
                            .with_for_update()
                        )
                        .mappings()
                        .first()
                    )
                    request_is_live = bool(
                        request_row
                        and request_row.get("status") == "running"
                        and str(request_row.get("current_command_id")) == record["id"]
                    )
                    if not request_is_live:
                        terminal_event = {
                            "type": "run.cancelled",
                            "commandId": command["id"],
                            "sessionId": command["sessionId"],
                            "runId": command["runId"],
                            "agent": command["agent"],
                            "reason": (
                                "Run request became terminal before command claim."
                            ),
                        }
                        cancelled = {
                            **record,
                            "command": {
                                **command,
                                "_terminalEvent": terminal_event,
                            },
                            "status": "cancelled",
                            "updatedAt": now,
                            "completedAt": now,
                            "error": terminal_event["reason"],
                        }
                        applied = conn.execute(
                            update(self.commands)
                            .where(self.commands.c.id == record["id"])
                            .where(available_condition)
                            .values(
                                **command_to_row(
                                    cancelled,
                                    database_id=record["id"],
                                    node_pk=node_pk,
                                )
                            )
                        )
                        if applied.rowcount == 1:
                            conn.execute(
                                update(self.runs)
                                .where(self.runs.c.command_id == record["id"])
                                .values(
                                    status="cancelled",
                                    completed_at=now_dt,
                                    error=terminal_event["reason"],
                                )
                            )
                            self._append_daemon_event(
                                conn,
                                daemon_event(
                                    "daemon.command.cancelled",
                                    {
                                        "nodeId": node_id,
                                        "commandId": record["id"],
                                        "reason": terminal_event["reason"],
                                    },
                                ),
                            )
                        continue
                attempt = int(record.get("attempt") or 0) + 1
                updated = {
                    **record,
                    "status": "dispatched",
                    "updatedAt": now,
                    "dispatchedAt": now,
                    "leaseId": new_relay_id("lease"),
                    "leaseExpiresAt": lease_expires_at(now, lease_seconds),
                    "attempt": attempt,
                }
                claimed = conn.execute(
                    update(self.commands)
                    .where(self.commands.c.id == record["id"])
                    .where(available_condition)
                    .values(
                        **command_to_row(
                            updated, database_id=record["id"], node_pk=node_pk
                        )
                    )
                )
                if claimed.rowcount != 1:
                    continue
                self._append_daemon_event(
                    conn,
                    daemon_event(
                        "daemon.command.dispatched",
                        {"nodeId": node_id, "commandId": record["id"]},
                    ),
                )
                result.append(updated)
        return result

    def queued_command_count(self, node_id: str) -> int:
        now = now_iso()
        now_dt = _parse_iso(now)
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            return int(
                conn.scalar(
                    select(func.count(self.commands.c.id))
                    .where(self.commands.c.node_id == node_pk)
                    .where(
                        (self.commands.c.status == "queued")
                        | (
                            (self.commands.c.status == "dispatched")
                            & (self.commands.c.lease_expires_at <= now_dt)
                        )
                    )
                )
                or 0
            )

    def queued_command_counts(self) -> dict[str, int]:
        now = now_iso()
        now_dt = _parse_iso(now)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(self.commands.c.node_id, func.count(self.commands.c.id))
                .where(
                    (self.commands.c.status == "queued")
                    | (
                        (self.commands.c.status == "dispatched")
                        & (self.commands.c.lease_expires_at <= now_dt)
                    )
                )
                .group_by(self.commands.c.node_id)
            ).all()
        return {row[0]: row[1] for row in rows}

    def renew_command_leases(
        self,
        node_id: str,
        command_leases: list[tuple[str, str | None]],
        lease_seconds: float = 60.0,
    ) -> None:
        if not command_leases:
            return
        now = now_iso()
        requested = dict(command_leases)
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            rows = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.node_id == node_pk)
                    .where(self.commands.c.id.in_(requested.keys()))
                    .where(self.commands.c.status == "dispatched")
                )
                .mappings()
                .all()
            )
            for row in rows:
                record = row_to_command(row)
                expected_lease_id = requested[record["id"]]
                if (
                    expected_lease_id is not None
                    and record.get("leaseId") != expected_lease_id
                ):
                    continue
                updated = {
                    **record,
                    "updatedAt": now,
                    "leaseExpiresAt": lease_expires_at(now, lease_seconds),
                }
                conn.execute(
                    update(self.commands)
                    .where(self.commands.c.id == record["id"])
                    .values(
                        **command_to_row(
                            updated, database_id=record["id"], node_pk=node_pk
                        )
                    )
                )
                self._append_daemon_event(
                    conn,
                    daemon_event(
                        "daemon.command.lease_renewed",
                        {
                            "nodeId": node_id,
                            "commandId": record["id"],
                            "leaseId": record.get("leaseId"),
                            "leaseExpiresAt": updated["leaseExpiresAt"],
                        },
                    ),
                )

    def list_active_runs(self, node_id: str | None = None) -> list[dict[str, Any]]:
        statement = select(self.runs).where(self.runs.c.status == "running")
        if node_id is not None:
            statement = statement.where(self.runs.c.node_id == node_id)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [row_to_run(row) for row in rows]

    def create_run_request(self, request: dict[str, Any]) -> dict[str, Any]:
        now = now_iso()
        record = {
            "id": request.get("id") or new_database_id(),
            "status": "running",
            "currentIndex": 0,
            "createdAt": now,
            "updatedAt": now,
            **request,
        }
        try:
            with store_transaction(self.engine) as conn:
                # The node row is the cross-replica capacity mutex. PostgreSQL
                # serializes all reservations for one node while unrelated
                # nodes remain independent.
                node_row = (
                    conn.execute(
                        select(self.nodes)
                        .where(self.nodes.c.id == record["nodeId"])
                        .with_for_update()
                    )
                    .mappings()
                    .first()
                )
                if not node_row:
                    raise KeyError(record["nodeId"])
                node_pk = node_row["id"]
                active_rows = (
                    conn.execute(
                        select(self.run_requests)
                        .where(self.run_requests.c.node_id == node_pk)
                        .where(
                            self.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES)
                        )
                    )
                    .mappings()
                    .all()
                )
                active_requests = [row_to_run_request(row) for row in active_rows]
                idempotent = next(
                    (item for item in active_requests if item["id"] == record["id"]),
                    None,
                )
                if idempotent:
                    return idempotent
                if any(
                    item["sessionId"] == record["sessionId"] for item in active_requests
                ):
                    raise ValueError(
                        f"Session {record['sessionId']} already has an active daemon run."
                    )
                _assert_node_run_request_capacity(
                    row_to_node(node_row), active_requests, record
                )
                conn.execute(
                    insert(self.run_requests).values(
                        **run_request_to_row(record, node_pk=node_pk)
                    )
                )
                self._append_daemon_event(
                    conn,
                    daemon_event(
                        "daemon.run_request.created",
                        {
                            "nodeId": record["nodeId"],
                            "runRequestId": record["id"],
                            "sessionId": record["sessionId"],
                        },
                    ),
                )
        except IntegrityError as error:
            existing = self.get_run_request(record["id"])
            if existing:
                return existing
            if self.active_run_request_for_session_any_node(record["sessionId"]):
                raise ValueError(
                    f"Session {record['sessionId']} already has an active daemon run."
                ) from error
            raise
        return record

    def get_run_request(self, request_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.run_requests).where(
                        self.run_requests.c.id == request_id
                    )
                )
                .mappings()
                .first()
            )
        return row_to_run_request(row) if row else None

    def list_active_run_requests(
        self, node_id: str | None = None
    ) -> list[dict[str, Any]]:
        statement = select(self.run_requests).where(
            self.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES)
        )
        if node_id is not None:
            statement = statement.where(self.run_requests.c.node_id == node_id)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [row_to_run_request(row) for row in rows]

    def active_run_request_for_session(
        self, node_id: str, session_id: str
    ) -> dict[str, Any] | None:
        return next(
            (
                request
                for request in self.list_active_run_requests(node_id)
                if request["sessionId"] == session_id
            ),
            None,
        )

    def active_run_request_for_session_any_node(
        self, session_id: str
    ) -> dict[str, Any] | None:
        return next(
            (
                request
                for request in self.list_active_run_requests()
                if request["sessionId"] == session_id
            ),
            None,
        )

    def run_request_for_command(self, command_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.run_requests)
                    .where(self.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES))
                    .where(self.run_requests.c.current_command_id == command_id)
                )
                .mappings()
                .first()
            )
        return row_to_run_request(row) if row else None

    def pending_command_for_run_request(self, request_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.commands).where(self.commands.c.status == "pending")
                )
                .mappings()
                .all()
            )
        return next(
            (
                record
                for row in rows
                if (record := row_to_command(row))["command"].get("_runRequestId")
                == request_id
            ),
            None,
        )

    def claim_terminal_run_request(
        self,
        command_id: str,
        event: dict[str, Any],
        claim_id: str,
        lease_seconds: float,
    ) -> dict[str, Any] | None:
        now = now_iso()
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.run_requests)
                    .where(self.run_requests.c.current_command_id == command_id)
                    .where(self.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES))
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            request = row_to_run_request(row)
            state = dict(request.get("state") or {})
            if request.get("status") == "finalizing":
                expires_at = state.get(TERMINAL_CLAIM_EXPIRES_STATE_KEY)
                if expires_at and _parse_iso(expires_at) > _parse_iso(now):
                    return None
            state.update(
                {
                    TERMINAL_EVENT_STATE_KEY: event,
                    TERMINAL_CLAIM_ID_STATE_KEY: claim_id,
                    TERMINAL_CLAIM_EXPIRES_STATE_KEY: lease_expires_at(
                        now, lease_seconds
                    ),
                }
            )
            updated = {
                **request,
                "status": "finalizing",
                "state": state,
                "updatedAt": now,
            }
            claimed = conn.execute(
                update(self.run_requests)
                .where(self.run_requests.c.id == row["id"])
                .where(self.run_requests.c.updated_at == row["updated_at"])
                .values(
                    **run_request_to_row(
                        updated, database_id=row["id"], node_pk=row["node_id"]
                    )
                )
            )
            if claimed.rowcount != 1:
                return None
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.run_request.finalizing",
                    {
                        "nodeId": updated["nodeId"],
                        "runRequestId": updated["id"],
                        "commandId": command_id,
                    },
                ),
            )
        return updated

    def claim_run_request_dispatch(
        self, request_id: str, claim_id: str, lease_seconds: float
    ) -> dict[str, Any] | None:
        now = now_iso()
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.run_requests)
                    .where(self.run_requests.c.id == request_id)
                    .where(self.run_requests.c.status.in_(("running", "dispatching")))
                    .where(self.run_requests.c.current_command_id.is_(None))
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            request = row_to_run_request(row)
            state = dict(request.get("state") or {})
            if request.get("status") == "dispatching":
                expires_at = state.get(DISPATCH_CLAIM_EXPIRES_STATE_KEY)
                if expires_at and _parse_iso(expires_at) > _parse_iso(now):
                    return None
            state.update(
                {
                    DISPATCH_CLAIM_ID_STATE_KEY: claim_id,
                    DISPATCH_CLAIM_EXPIRES_STATE_KEY: lease_expires_at(
                        now, lease_seconds
                    ),
                }
            )
            updated = {
                **request,
                "status": "dispatching",
                "state": state,
                "updatedAt": now,
            }
            claimed = conn.execute(
                update(self.run_requests)
                .where(self.run_requests.c.id == row["id"])
                .where(self.run_requests.c.updated_at == row["updated_at"])
                .where(self.run_requests.c.current_command_id.is_(None))
                .values(
                    **run_request_to_row(
                        updated, database_id=row["id"], node_pk=row["node_id"]
                    )
                )
            )
            if claimed.rowcount != 1:
                return None
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.run_request.dispatching",
                    {
                        "nodeId": updated["nodeId"],
                        "runRequestId": updated["id"],
                    },
                ),
            )
        return updated

    def update_run_request(
        self, request_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]:
        current = self.get_run_request(request_id)
        if not current:
            raise KeyError(request_id)
        now = now_iso()
        updated = {**current, **patch, "updatedAt": now}
        if patch.get("status") in ("completed", "failed", "cancelled"):
            updated["completedAt"] = now
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, updated["nodeId"])
            conn.execute(
                update(self.run_requests)
                .where(self.run_requests.c.id == request_id)
                .values(
                    **run_request_to_row(
                        updated, database_id=current["id"], node_pk=node_pk
                    )
                )
            )
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.run_request.updated",
                    {
                        "nodeId": updated["nodeId"],
                        "runRequestId": updated["id"],
                        "status": updated["status"],
                    },
                ),
            )
        return updated

    def update_run_request_if_status(
        self, request_id: str, expected_status: str, patch: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Atomically apply a run-request transition from one status."""
        now = now_iso()
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.run_requests)
                    .where(self.run_requests.c.id == request_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            current = row_to_run_request(row)
            if current.get("status") != expected_status:
                return None
            updated = {**current, **patch, "updatedAt": now}
            if patch.get("status") in TERMINAL_DAEMON_STATUSES:
                updated["completedAt"] = now
            node_pk = self._node_pk(conn, updated["nodeId"])
            applied = conn.execute(
                update(self.run_requests)
                .where(self.run_requests.c.id == row["id"])
                .where(self.run_requests.c.status == expected_status)
                .values(
                    **run_request_to_row(
                        updated, database_id=row["id"], node_pk=node_pk
                    )
                )
            )
            if applied.rowcount != 1:
                return None
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.run_request.updated",
                    {
                        "nodeId": updated["nodeId"],
                        "runRequestId": updated["id"],
                        "status": updated["status"],
                    },
                ),
            )
        return updated

    def update_run_request_if_claimed(
        self,
        request_id: str,
        claim_key: str,
        claim_id: str,
        patch: dict[str, Any],
    ) -> dict[str, Any] | None:
        now = now_iso()
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.run_requests)
                    .where(self.run_requests.c.id == request_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            current = row_to_run_request(row)
            if (current.get("state") or {}).get(claim_key) != claim_id or (
                claim_key == DISPATCH_CLAIM_ID_STATE_KEY
                and current.get("status") != "dispatching"
            ):
                return None
            updated = {**current, **patch, "updatedAt": now}
            if patch.get("status") in TERMINAL_DAEMON_STATUSES:
                updated["completedAt"] = now
            applied = conn.execute(
                update(self.run_requests)
                .where(self.run_requests.c.id == row["id"])
                .where(self.run_requests.c.updated_at == row["updated_at"])
                .values(
                    **run_request_to_row(
                        updated, database_id=row["id"], node_pk=row["node_id"]
                    )
                )
            )
            if applied.rowcount != 1:
                return None
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.run_request.updated",
                    {
                        "nodeId": updated["nodeId"],
                        "runRequestId": updated["id"],
                        "status": updated["status"],
                    },
                ),
            )
        return updated

    def mark_command_completed(self, node_id: str, event: dict[str, Any]) -> bool:
        return self._mark_command_terminal(
            node_id, event, "completed", event.get("exitCode"), None
        )

    def mark_command_failed(self, node_id: str, event: dict[str, Any]) -> bool:
        return self._mark_command_terminal(
            node_id, event, "failed", event.get("exitCode"), event.get("error")
        )

    def mark_command_cancelled(self, node_id: str, event: dict[str, Any]) -> bool:
        return self._mark_command_terminal(
            node_id, event, "cancelled", None, event.get("reason")
        )

    def mark_cancel_commands_completed(
        self, node_id: str, target_command_id: str
    ) -> None:
        now = now_iso()
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            rows = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.node_id == node_pk)
                    .where(self.commands.c.type == "run.cancel")
                    .where(~self.commands.c.status.in_(TERMINAL_DAEMON_STATUSES))
                )
                .mappings()
                .all()
            )
            for row in rows:
                record = row_to_command(row)
                command = record["command"]
                if command.get("commandId") != target_command_id:
                    continue
                updated, completion_event = completed_cancel_record(record, now)
                conn.execute(
                    update(self.commands)
                    .where(self.commands.c.id == record["id"])
                    .values(
                        **command_to_row(
                            updated, database_id=record["id"], node_pk=node_pk
                        )
                    )
                )
                self._append_daemon_event(conn, completion_event)

    def prune_terminal_records(
        self, retention_seconds: float, per_node_limit: int
    ) -> dict[str, int]:
        cutoff = _format_iso(
            _parse_iso(now_iso()) - timedelta(seconds=max(0.0, retention_seconds))
        )
        per_node_limit = max(0, per_node_limit)
        deleted_commands = 0
        deleted_runs = 0
        deleted_events = 0
        with store_transaction(self.engine) as conn:
            command_rows = (
                conn.execute(
                    select(self.commands).where(
                        self.commands.c.status.in_(TERMINAL_DAEMON_STATUSES)
                    )
                )
                .mappings()
                .all()
            )
            command_ids = terminal_database_ids_to_prune(
                command_rows, cutoff, per_node_limit
            )
            if command_ids:
                deleted_commands = (
                    conn.execute(
                        delete(self.commands).where(self.commands.c.id.in_(command_ids))
                    ).rowcount
                    or 0
                )

            run_rows = (
                conn.execute(
                    select(self.runs).where(
                        self.runs.c.status.in_(TERMINAL_DAEMON_STATUSES)
                    )
                )
                .mappings()
                .all()
            )
            run_ids = terminal_database_ids_to_prune(run_rows, cutoff, per_node_limit)
            if run_ids:
                deleted_runs = (
                    conn.execute(
                        delete(self.runs).where(self.runs.c.id.in_(run_ids))
                    ).rowcount
                    or 0
                )

            deleted_events = (
                conn.execute(
                    delete(self.events).where(
                        or_(
                            *(
                                self.events.c.type.startswith(prefix)
                                for prefix in PRUNABLE_DAEMON_EVENT_PREFIXES
                            ),
                            self.events.c.type.in_(PRUNABLE_DAEMON_EVENT_TYPES),
                        ),
                        self.events.c.timestamp <= _parse_iso(cutoff),
                    )
                ).rowcount
                or 0
            )
        return {
            "commands": deleted_commands,
            "runs": deleted_runs,
            "events": deleted_events,
        }

    def append_daemon_event(self, event: dict[str, Any]) -> None:
        with store_transaction(self.engine) as conn:
            self._append_daemon_event(conn, event)

    def historical_managed_runtime_ids(self, managed_node_id: str) -> set[str]:
        with store_transaction(self.engine) as conn:
            payloads = conn.scalars(
                select(self.events.c.payload).where(
                    self.events.c.type == "daemon.node.registered"
                )
            ).all()
        return {
            runtime_id
            for runtime_id, current_managed_node_id in _managed_runtime_identity_map(
                payloads
            ).items()
            if current_managed_node_id == managed_node_id
        }

    def historical_managed_node_id(self, runtime_id: str) -> str | None:
        return self.historical_managed_node_ids({runtime_id}).get(runtime_id)

    def historical_managed_node_ids(self, runtime_ids: set[str]) -> dict[str, str]:
        with store_transaction(self.engine) as conn:
            payloads = conn.scalars(
                select(self.events.c.payload).where(
                    self.events.c.type == "daemon.node.registered"
                )
            ).all()
        identities = _managed_runtime_identity_map(payloads)
        return {
            current_runtime_id: managed_node_id
            for current_runtime_id, managed_node_id in identities.items()
            if current_runtime_id in runtime_ids
        }

    def _mark_command_terminal(
        self,
        node_id: str,
        event: dict[str, Any],
        status: str,
        exit_code: int | None,
        error: str | None,
    ) -> bool:
        now = now_iso()
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            row = (
                conn.execute(
                    select(self.commands).where(
                        self.commands.c.id == event["commandId"]
                    )
                )
                .mappings()
                .first()
            )
            if not row:
                return False
            command = row_to_command(row)
            if command.get("status") not in ("queued", "dispatched") or (
                event.get("leaseId") is not None
                and (
                    command.get("status") != "dispatched"
                    or command.get("leaseId") != event["leaseId"]
                )
            ):
                return False
            conn.execute(
                update(self.commands)
                .where(self.commands.c.id == command["id"])
                .values(
                    **command_to_row(
                        {
                            **command,
                            "command": {
                                **command["command"],
                                "_terminalEvent": event,
                            },
                            "status": status,
                            "updatedAt": now,
                            "completedAt": now,
                            **(
                                {"exitCode": exit_code} if exit_code is not None else {}
                            ),
                            **({"error": error} if error else {}),
                        },
                        database_id=command["id"],
                        node_pk=node_pk,
                    )
                )
            )
            run_row = (
                conn.execute(select(self.runs).where(self.runs.c.id == event["runId"]))
                .mappings()
                .first()
            )
            run = (
                row_to_run(run_row)
                if run_row
                else {
                    "nodeId": node_id,
                    "commandId": event["commandId"],
                    "sessionId": event["sessionId"],
                    "runId": event["runId"],
                    "agent": event["agent"],
                    "taskGoal": "",
                    "startedAt": now,
                }
            )
            self._write_run(
                conn,
                {
                    **run,
                    "status": status,
                    "completedAt": now,
                    **({"exitCode": exit_code} if exit_code is not None else {}),
                    **({"error": error} if error else {}),
                },
            )
            event_type = {
                "completed": "daemon.command.completed",
                "failed": "daemon.command.failed",
                "cancelled": "daemon.command.cancelled",
            }[status]
            self._append_daemon_event(
                conn,
                daemon_event(
                    event_type,
                    {
                        "nodeId": node_id,
                        "commandId": event["commandId"],
                        "runId": event["runId"],
                        **({"exitCode": exit_code} if exit_code is not None else {}),
                        **({"error": error} if error else {}),
                    },
                ),
            )
            return True

    def _write_run(self, conn: Any, run: dict[str, Any]) -> None:
        values = run_to_row(run)
        existing = conn.scalar(
            select(self.runs.c.id).where(self.runs.c.id == run["runId"])
        )
        if existing:
            conn.execute(
                update(self.runs)
                .where(self.runs.c.id == existing)
                .values(**run_to_row(run, database_id=existing))
            )
        else:
            conn.execute(insert(self.runs).values(**values))

    def _append_daemon_event(self, conn: Any, event: dict[str, Any]) -> None:
        conn.execute(insert(self.events).values(**daemon_event_to_row(event)))

    def _node_pk(self, conn: Any, node_id: str) -> str:
        node_pk = conn.scalar(select(self.nodes.c.id).where(self.nodes.c.id == node_id))
        if not node_pk:
            raise KeyError(node_id)
        return node_pk


def node_to_row(
    node: dict[str, Any], *, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or node["id"],
        "employee_id": node.get("employeeId"),
        "display_name": node.get("displayName"),
        "workspace_path": node.get("workspacePath"),
        "workspace_id": node.get("workspaceId"),
        "enrollment_key": node.get("enrollmentKey"),
        "sandbox_mode": node.get("sandboxMode"),
        "node_location": node.get("nodeLocation"),
        "managed_node_id": node.get("managedNodeId"),
        "provisioning_attempt_id": node.get("provisioningAttemptId"),
        "credential_version": int(node.get("credentialVersion") or 1),
        "retired_at": _parse_iso(node.get("retiredAt")),
        "status": node["status"],
        # The per-agent maps live in daemon_node_agents; see node_agent_rows.
        "max_concurrent_runs": int(node.get("maxConcurrentRuns") or 1),
        # Hashes authenticate; the secret (control-panel nodes only) lets the
        # owner reveal the token again. Managed nodes persist neither.
        "ui_token_hash": node.get("uiTokenHash"),
        "node_token_hash": node.get("nodeTokenHash"),
        "node_token_secret": node.get("nodeTokenSecret"),
        "last_error": node.get("lastError"),
        "created_at": _parse_iso(node["createdAt"]),
        "updated_at": _parse_iso(node["updatedAt"]),
        "last_seen_at": _parse_iso(node.get("lastSeenAt")),
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
        **({"employeeId": row["employee_id"]} if row.get("employee_id") else {}),
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
            {"retiredAt": _format_iso(row["retired_at"])}
            if row.get("retired_at")
            else {}
        ),
        "status": row["status"],
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
        **(
            {"nodeTokenSecret": row["node_token_secret"]}
            if row.get("node_token_secret")
            else {}
        ),
        **({"lastError": row["last_error"]} if row.get("last_error") else {}),
        "createdAt": _format_iso(row["created_at"]),
        "updatedAt": _format_iso(row["updated_at"]),
        **(
            {"lastSeenAt": _format_iso(row["last_seen_at"])}
            if row.get("last_seen_at")
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
        "created_at": _parse_iso(record["createdAt"]),
        "updated_at": _parse_iso(record["updatedAt"]),
        "dispatched_at": _parse_iso(record.get("dispatchedAt")),
        "lease_id": record.get("leaseId"),
        "lease_expires_at": _parse_iso(record.get("leaseExpiresAt")),
        "attempt": int(record.get("attempt") or 0),
        "completed_at": _parse_iso(record.get("completedAt")),
    }


def row_to_command(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "nodeId": row["node_id"],
        "command": row["command"],
        "status": row["status"],
        "createdAt": _format_iso(row["created_at"]),
        "updatedAt": _format_iso(row["updated_at"]),
        **(
            {"dispatchedAt": _format_iso(row["dispatched_at"])}
            if row.get("dispatched_at")
            else {}
        ),
        **({"leaseId": row["lease_id"]} if row.get("lease_id") else {}),
        **(
            {"leaseExpiresAt": _format_iso(row["lease_expires_at"])}
            if row.get("lease_expires_at")
            else {}
        ),
        "attempt": row.get("attempt") or 0,
        **(
            {"completedAt": _format_iso(row["completed_at"])}
            if row.get("completed_at")
            else {}
        ),
        **({"exitCode": row["exit_code"]} if row.get("exit_code") is not None else {}),
        **({"error": row["error"]} if row.get("error") else {}),
    }


def lease_expires_at(now: str, lease_seconds: float) -> str:
    expires_at = _parse_iso(now) + timedelta(seconds=max(0.001, lease_seconds))
    return _format_iso(expires_at)


def command_is_available(record: dict[str, Any], now: str) -> bool:
    status = record.get("status")
    if status == "queued":
        return True
    if status != "dispatched":
        return False
    lease_expires_at_value = record.get("leaseExpiresAt")
    return bool(
        lease_expires_at_value and _parse_iso(lease_expires_at_value) <= _parse_iso(now)
    )


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
        "started_at": _parse_iso(run["startedAt"]),
        "completed_at": _parse_iso(run.get("completedAt")),
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
        "startedAt": _format_iso(row["started_at"]),
        **(
            {"completedAt": _format_iso(row["completed_at"])}
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
        "current_started_at": _parse_iso(record.get("currentStartedAt")),
        "current_progress_at": _parse_iso(record.get("currentProgressAt")),
        "error": record.get("error"),
        "created_at": _parse_iso(record["createdAt"]),
        "updated_at": _parse_iso(record["updatedAt"]),
        "completed_at": _parse_iso(record.get("completedAt")),
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
            {"currentStartedAt": _format_iso(row["current_started_at"])}
            if row.get("current_started_at")
            else {}
        ),
        **(
            {"currentProgressAt": _format_iso(row["current_progress_at"])}
            if row.get("current_progress_at")
            else {}
        ),
        **({"error": row["error"]} if row.get("error") else {}),
        "createdAt": _format_iso(row["created_at"]),
        "updatedAt": _format_iso(row["updated_at"]),
        **(
            {"completedAt": _format_iso(row["completed_at"])}
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
        "timestamp": _parse_iso(event["timestamp"]),
        "payload": event,
    }
