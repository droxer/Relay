"""Daemon node rows: registration, liveness, user assignment, per-node agent settings, deletion.

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
from sqlalchemy.exc import IntegrityError
from ..db_time import require_db_time
from ..events import daemon_event
from ...core.ids import now_iso
from ..engine import store_transaction
from ..sql import names_no_uuid_row
from .rules import (
    _NODE_LIVENESS_COLUMNS,
    _comparable_node_value,
    _managed_runtime_identity_map,
    _node_for_event,
    _node_for_storage,
    node_setting_update,
    _poll_observation,
    preserve_node_poll,
    preserve_node_retirement,
)
from ...core.daemon_records import assigned_node_location, NODE_POLL_DRAINED_AT
from .rows import (
    _node_agent_identity,
    apply_node_agents,
    node_agent_rows,
    node_to_row,
    row_to_node,
)
from .state import DaemonStoreState


class NodeRows(DaemonStoreState):
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
            node = preserve_node_poll(previous, node)
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
        self,
        node_id: str,
        patch: dict[str, Any] | None = None,
        *,
        polled: bool | None = None,
    ) -> dict[str, Any] | None:
        """Advance liveness; ``polled`` True also records a command poll, False clears it.

        A cleared poll is a daemon saying it will not take work again (it is
        draining); None leaves the poll observation as it was.
        """
        if not patch:
            return self._touch_node_liveness(node_id, polled=polled)
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
                **_poll_observation(node, now, polled),
            }
            updated = preserve_node_retirement(node, updated)
            if patch.get("lastError") is None and "lastError" in patch:
                updated.pop("lastError", None)
            self._save_node(conn, updated, database_id=node_pk)
            # Deliberately not logged as a daemon event: heartbeats arrive
            # several times per second per node, and `lastSeenAt` on the node
            # record is the only thing anything reads.
        return updated

    def _touch_node_liveness(
        self, node_id: str, *, polled: bool | None = None
    ) -> dict[str, Any] | None:
        """The idle heartbeat: advance the liveness columns and nothing else.

        No row lock and no read-modify-write of the other 20 columns or the
        per-agent rows -- a heartbeat with nothing to report cannot change
        them. None of the columns is indexed, so this stays a HOT update.
        """
        now = require_db_time(now_iso())
        poll_values = (
            {"last_poll_at": now}
            if polled
            else {"last_poll_at": require_db_time(NODE_POLL_DRAINED_AT)}
            if polled is False
            else {}
        )
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    update(self.nodes)
                    .where(self.nodes.c.id == node_id)
                    .values(updated_at=now, last_seen_at=now, **poll_values)
                    .returning(*self.nodes.c)
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            node_pk = str(row["id"])
            agents = self._node_agents_by_node(conn, [node_pk])
        return apply_node_agents(row_to_node(row), agents.get(node_pk, []))

    def assign_node_user(self, node_id: str, user_id: str) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        if node.get("userId"):
            raise ValueError("Daemon node is already assigned.")
        updated = {**node, "userId": user_id, "updatedAt": now_iso()}
        updated["nodeLocation"] = assigned_node_location(updated)
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            self._save_node(conn, updated, database_id=node_pk)
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.node.assigned",
                    {"nodeId": node_id, "userId": user_id},
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

    def unassign_node_user(self, node_id: str) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise KeyError(node_id)
        previous = node.get("userId")
        updated = {
            k: v
            for k, v in node.items()
            if k not in ("userId", "agentRoleOverrides")
        }
        updated["updatedAt"] = now_iso()
        with store_transaction(self.engine) as conn:
            node_pk = self._node_pk(conn, node_id)
            # `updated` drops userId entirely, so node_to_row would leave the
            # column untouched rather than clearing it.
            self._save_node(conn, {**updated, "userId": None}, database_id=node_pk)
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.node.unassigned",
                    {"nodeId": node_id, "previousUserId": previous},
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
        if names_no_uuid_row(self.engine, node_id):
            return None
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

    # Registration events only ever accumulate, so the identity map built from
    # them is stale only when a new registration landed. Remember the map with
    # the count it was built from; every poll of a legacy session then pays one
    # count query instead of decoding every registration payload again.
    _historical_identities: tuple[int, dict[str, str]] | None = None

    def historical_managed_node_ids(self, runtime_ids: set[str]) -> dict[str, str]:
        registered = self.events.c.type == "daemon.node.registered"
        with store_transaction(self.engine) as conn:
            count = int(conn.scalar(select(func.count()).select_from(self.events).where(registered)) or 0)
            cached = self._historical_identities
            if cached is not None and cached[0] == count:
                identities = cached[1]
            else:
                payloads = conn.scalars(select(self.events.c.payload).where(registered)).all()
                identities = _managed_runtime_identity_map(payloads)
                self._historical_identities = (count, identities)
        return {
            current_runtime_id: managed_node_id
            for current_runtime_id, managed_node_id in identities.items()
            if current_runtime_id in runtime_ids
        }

    def _node_pk(self, conn: Any, node_id: str) -> str:
        node_pk = conn.scalar(select(self.nodes.c.id).where(self.nodes.c.id == node_id))
        if not node_pk:
            raise KeyError(node_id)
        return node_pk
