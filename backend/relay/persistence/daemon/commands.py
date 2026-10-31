"""The per-node command queue: staging, publishing, leasing, and terminal marks.

A mixin of ``DatabaseDaemonStore``; it shares the store's engine and tables
(declared on ``DaemonStoreState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from sqlalchemy import (
    delete,
    func,
    insert,
    select,
    update,
)
from ...core.ids import new_relay_id
from ..db_time import parse_db_time, require_db_time
from ..events import daemon_event
from ...core.ids import now_iso
from ..engine import publish_database_notification, store_transaction
from .rules import completed_cancel_record, daemon_command_queue_limit
from ...core.daemon_records import DISPATCH_CLAIM_ID_STATE_KEY, TERMINAL_DAEMON_STATUSES, NODE_POLL_DRAINED_AT
from .rows import (
    command_to_row,
    daemon_event_to_row,
    lease_expires_at,
    row_to_command,
    row_to_run,
    run_to_row,
)
from .state import DaemonStoreState


class CommandQueueRows(DaemonStoreState):
    def terminal_events_for_session(self, session_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            commands = conn.execute(
                select(self.commands.c.command)
                .join(self.runs, self.runs.c.command_id == self.commands.c.id)
                .where(self.runs.c.session_id == session_id)
                .where(self.commands.c.status.in_(TERMINAL_DAEMON_STATUSES))
            ).scalars().all()
        return [command["_terminalEvent"] for command in commands
                if isinstance(command.get("_terminalEvent"), dict)]

    def get_commands(self, command_ids: set[str]) -> dict[str, dict[str, Any]]:
        if not command_ids:
            return {}
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.commands).where(self.commands.c.id.in_(command_ids))
                )
                .mappings()
                .all()
            )
        return {str(row["id"]): row_to_command(row) for row in rows}

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
        published = self.publish_command(command["id"])
        if published is None:
            # Only a request-scoped publish can decline; this one has none.
            raise RuntimeError(f"Command {command['id']} was not published.")
        return published

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
                self._command_changes.database_channel,
                f"node:{record['nodeId']}",
            )
        self._notify_command(record["nodeId"])
        return updated

    def complete_runtime_refresh(self, node_id: str, acknowledgement: dict[str, Any]) -> None:
        """Acknowledge only the refresh lease held by this authenticated node."""
        with store_transaction(self.engine) as conn:
            now = require_db_time(now_iso())
            changed = conn.execute(
                update(self.commands)
                .where(self.commands.c.id == acknowledgement["commandId"])
                .where(self.commands.c.node_id == self._node_pk(conn, node_id))
                .where(self.commands.c.type == "runtime.refresh")
                .where(self.commands.c.status == "dispatched")
                .where(self.commands.c.lease_id == acknowledgement["leaseId"])
                .values(status="completed", updated_at=now, completed_at=now)
            )
            if changed.rowcount:
                self._append_daemon_event(conn, daemon_event(
                    "daemon.command.runtime-refreshed",
                    {"nodeId": node_id, "commandId": acknowledgement["commandId"]},
                ))

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
        now_dt = parse_db_time(now)
        with store_transaction(self.engine) as conn:
            # A drain racing the registry's initial observation must fence
            # leasing too. Heartbeats and this node-row lock serialize in SQL.
            node = conn.execute(select(
                self.nodes.c.id,
                (self.nodes.c.last_poll_at == require_db_time(NODE_POLL_DRAINED_AT)).label("drained"),
            ).where(self.nodes.c.id == node_id).with_for_update()).mappings().first()
            if node is None:
                raise KeyError(node_id)
            if node["drained"]:
                return []
            node_pk = node["id"]
            available_condition = (self.commands.c.status == "queued") | (
                (self.commands.c.status == "dispatched")
                & (self.commands.c.type != "run.start")
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
                    if record.get("status") == "dispatched" and request_row and (request_row.get("state") or {}).get("_relay_stop_command_id"):
                        continue
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
        now_dt = parse_db_time(now)
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
                            & (self.commands.c.type != "run.start")
                            & (self.commands.c.lease_expires_at <= now_dt)
                        )
                    )
                )
                or 0
            )

    def queued_command_counts(self) -> dict[str, int]:
        now = now_iso()
        now_dt = parse_db_time(now)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(self.commands.c.node_id, func.count(self.commands.c.id))
                .where(
                    (self.commands.c.status == "queued")
                    | (
                        (self.commands.c.status == "dispatched")
                        & (self.commands.c.type != "run.start")
                        & (self.commands.c.lease_expires_at <= now_dt)
                    )
                )
                .group_by(self.commands.c.node_id)
            ).all()
        return {row[0]: row[1] for row in rows}

    def pending_commands_of_type(
        self, node_id: str, command_type: str
    ) -> list[dict[str, Any]]:
        """Published commands of one type that have not finished, delivered or not."""
        with store_transaction(self.engine) as conn:
            node_pk = conn.scalar(select(self.nodes.c.id).where(self.nodes.c.id == node_id))
            if not node_pk:
                return []
            rows = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.node_id == node_pk)
                    .where(self.commands.c.type == command_type)
                    .where(self.commands.c.status.in_(("queued", "dispatched")))
                    .order_by(self.commands.c.created_at, self.commands.c.id)
                )
                .mappings()
                .all()
            )
        return [row_to_command(row) for row in rows]

    def retire_command(self, command_id: str, reason: str) -> bool:
        """Close an unfinished command whose work was handed to another node."""
        now = require_db_time(now_iso())
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                update(self.commands)
                .where(self.commands.c.id == command_id)
                .where(self.commands.c.status.in_(("queued", "dispatched")))
                .values(status="cancelled", updated_at=now, completed_at=now, error=reason)
            )
        return result.rowcount == 1

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

    def list_active_runs(
        self, node_id: str | None = None, *, session_ids: set[str] | None = None, limit: int | None = None, after_id: str | None = None
    ) -> list[dict[str, Any]]:
        statement = select(self.runs).where(self.runs.c.status == "running")
        if node_id is not None:
            statement = statement.where(self.runs.c.node_id == node_id)
        if session_ids is not None:
            statement = statement.where(self.runs.c.session_id.in_(session_ids))
        if after_id is not None:
            statement = statement.where(self.runs.c.id > after_id)
        if limit is not None:
            statement = statement.order_by(self.runs.c.id).limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [row_to_run(row) for row in rows]

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

    def append_daemon_event(self, event: dict[str, Any]) -> None:
        with store_transaction(self.engine) as conn:
            self._append_daemon_event(conn, event)

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
                    ).with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return False
            command = row_to_command(row)
            if command.get("status") not in ("pending", "queued", "dispatched") or (
                command.get("status") == "pending" and not event.get("_requireUndelivered")
            ) or (
                event.get("_requireUndelivered") and command.get("status") == "dispatched"
            ) or (
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
