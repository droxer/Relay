"""Run requests: creation, claims (dispatch, terminal, recovery), and guarded updates.

A mixin of ``DatabaseDaemonStore``; it shares the store's engine and tables
(declared on ``DaemonStoreState``) and is not used on its own.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from sqlalchemy import (
    insert,
    or_,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from ..store_common import (
    _require_iso,
    daemon_event,
    new_database_id,
    now_iso,
    store_transaction,
)
from ..tables.daemon import ACTIVE_RUN_REQUEST_STATUSES
from .rules import (
    DISPATCH_CLAIM_EXPIRES_STATE_KEY,
    DISPATCH_CLAIM_ID_STATE_KEY,
    TERMINAL_CLAIM_EXPIRES_STATE_KEY,
    TERMINAL_CLAIM_ID_STATE_KEY,
    TERMINAL_DAEMON_STATUSES,
    TERMINAL_EVENT_STATE_KEY,
    _assert_node_run_request_capacity,
)
from .rows import (
    lease_expires_at,
    row_to_command,
    row_to_node,
    row_to_run_request,
    run_request_to_row,
)
from .state import DaemonStoreState


class RunRequestRows(DaemonStoreState):
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
                session_store = getattr(self, "session_store", None)
                if session_store and getattr(session_store, "engine", None) is self.engine:
                    # Same lock as deletion and event append, before node locks.
                    snapshot = conn.execute(select(session_store.sessions.c.snapshot)
                        .where(session_store.sessions.c.id == record["sessionId"])
                        .with_for_update()).scalar_one_or_none()
                    if snapshot is None:
                        raise KeyError(record["sessionId"])
                    if snapshot.get("deletionRequestedAt"):
                        raise ValueError("Thread deletion has been requested.")
                elif session_store and session_store.get_session(record["sessionId"]).get("deletionRequestedAt"):
                    raise ValueError("Thread deletion has been requested.")
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
            if record.get("taskId") and self.active_run_request_for_task(record["taskId"]):
                raise ValueError("task_ownership_conflict: this task already has an active daemon run.") from error
            raise
        return record

    def active_run_request_for_task(self, task_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = conn.execute(
                select(self.run_requests)
                .where(self.run_requests.c.task_id == task_id)
                .where(self.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES))
                .limit(1)
            ).mappings().first()
        return row_to_run_request(row) if row else None

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

    def claim_recovery_requests(self, *, limit: int = 100, lease_seconds: float = 5.0) -> list[dict[str, Any]]:
        now = _require_iso(now_iso())
        with store_transaction(self.engine) as conn:
            statement = select(self.run_requests).where(
                self.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES),
                or_(self.run_requests.c.recovery_after.is_(None), self.run_requests.c.recovery_after <= now),
            ).order_by(self.run_requests.c.recovery_after.asc().nulls_first(), self.run_requests.c.id).limit(max(1, limit)).with_for_update(skip_locked=True)
            rows = conn.execute(statement).mappings().all()
            if rows:
                conn.execute(update(self.run_requests).where(self.run_requests.c.id.in_([row["id"] for row in rows])).values(
                    recovery_after=now + timedelta(seconds=lease_seconds)))
            return [row_to_run_request(row) for row in rows]

    def list_active_run_requests(
        self, node_id: str | None = None, *, session_ids: set[str] | None = None, limit: int | None = None, after_id: str | None = None
    ) -> list[dict[str, Any]]:
        statement = select(self.run_requests).where(
            self.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES)
        )
        if node_id is not None:
            statement = statement.where(self.run_requests.c.node_id == node_id)
        if session_ids is not None:
            statement = statement.where(self.run_requests.c.session_id.in_(session_ids))
        if after_id is not None:
            statement = statement.where(self.run_requests.c.id > after_id)
        if limit is not None:
            statement = statement.order_by(self.run_requests.c.id).limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [row_to_run_request(row) for row in rows]

    def active_run_request_for_session(
        self, node_id: str, session_id: str
    ) -> dict[str, Any] | None:
        return next(
            (
                request
                for request in self.list_active_run_requests(
                    node_id, session_ids={session_id}
                )
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
                for request in self.list_active_run_requests(session_ids={session_id})
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
            row = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.run_request_id == str(request_id))
                    .where(self.commands.c.status == "pending")
                    .order_by(self.commands.c.created_at, self.commands.c.id)
                    .limit(1)
                )
                .mappings()
                .first()
            )
        return row_to_command(row) if row else None

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
                if state.get("_relay_recovery_required"):
                    return None
                expires_at = state.get(TERMINAL_CLAIM_EXPIRES_STATE_KEY)
                if expires_at and _require_iso(expires_at) > _require_iso(now):
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
                if expires_at and _require_iso(expires_at) > _require_iso(now):
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
                    recovery_after=None,
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
        self, request_id: str, expected_status: str, patch: dict[str, Any],
        *, require_undelivered: bool = False,
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
            # Delivery and publication lock this same request row. Keep the
            # delivery check inside that transaction: a registry-local lock
            # cannot fence another backend replica's daemon poll.
            if require_undelivered and current.get("currentCommandId"):
                command = self.get_command(current["currentCommandId"])
                if not command or command.get("status") not in ("pending", "queued"):
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

    def mark_run_request_state(self, request_id: str, key: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(self.run_requests).where(self.run_requests.c.id == request_id).with_for_update()).mappings().first()
            if not row:
                return None
            current = row_to_run_request(row)
            if current.get("status") not in ACTIVE_RUN_REQUEST_STATUSES:
                return None
            state = dict(current.get("state") or {})
            if state.get(key):
                return None
            state[key] = now_iso()
            return self.update_run_request(request_id, {"state": state})

    def request_run_stop(
        self, request_id: str, command_id: str, reason: str,
        *, actor_user_id: str | None = None,
    ) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(self.run_requests).where(self.run_requests.c.id == request_id).with_for_update()).mappings().first()
            if not row:
                return None
            current = row_to_run_request(row)
            if current.get("status") != "running" or current.get("currentCommandId") != command_id:
                return None
            state = dict(current.get("state") or {})
            state.setdefault("_relay_stop_command_id", new_database_id())
            state.setdefault("_relay_stop_requested_at", now_iso())
            if actor_user_id:
                state.setdefault("_relay_stop_actor_user_id", actor_user_id)
            return self.update_run_request(request_id, {"state": state, "error": reason})

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
