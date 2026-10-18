from __future__ import annotations

from threading import RLock
from typing import Any

from sqlalchemy import (
    insert,
    select,
    update,
)

from ..core.computer_identity import computer_id
from ..core.ids import new_database_id, now_iso
from ..core.models import AGENT_NAMES
from .agent_store import DatabaseAgentStore
from .store_common import (
    _format_iso,
    _parse_iso,
    create_all_tables,
    shared_engine,
    store_transaction,
)
from .sql import metadata as shared_metadata
from .tables import agent_placements as agent_placements_tables

PLACEMENT_DESIRED_STATES = frozenset({"active", "draining", "removed"})
PLACEMENT_PATCH_FIELDS = frozenset(
    {"desiredState", "priority", "workspacePolicy", "agentVersion", "conditions"}
)
_PLACEMENT_LOCKS: dict[str, RLock] = {}
_PLACEMENT_LOCKS_GUARD = RLock()


def _shared_placement_lock(key: str) -> RLock:
    with _PLACEMENT_LOCKS_GUARD:
        return _PLACEMENT_LOCKS.setdefault(key, RLock())


class DatabaseAgentPlacementStore:
    # `supervisor_user_id` and `executor_kind` are copied from the agent and
    # have no refresh path, which is safe only because neither is patchable on
    # an agent -- `update_agent` rejects both. `test_agent_placements` pins that,
    # so making either mutable fails there rather than silently drifting every
    # placement. `agent_version` does change and is synced by `sync_agent_version`.
    metadata = shared_metadata
    placements = agent_placements_tables.placements
    events_table = agent_placements_tables.events_table

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        self._lock = _shared_placement_lock(f"database:{self.engine.url}")
        if create_schema:
            create_all_tables(self.engine)

    def create_placement(
        self,
        agent: dict[str, Any],
        daemon_node_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        placement = _new_placement(agent, daemon_node_id, payload or {})
        with self._lock, store_transaction(self.engine) as conn:
            # Lock the durable agent row so concurrent placement moves for the
            # same agent serialize across backend replicas, including when the
            # agent currently has no placement rows to lock.
            conn.execute(
                select(DatabaseAgentStore.agents.c.id)
                .where(DatabaseAgentStore.agents.c.id == agent["id"])
                .with_for_update()
            ).first()
            rows = (
                conn.execute(
                    select(
                        self.placements.c.id,
                        self.placements.c.snapshot,
                        self.placements.c.supervisor_user_id,
                        self.placements.c.event_version,
                    )
                    .where(self.placements.c.agent_id == agent["id"])
                    .where(self.placements.c.desired_state != "removed")
                    .with_for_update()
                )
                .mappings()
                .all()
            )
            active = [
                _normalized_placement_snapshot(
                    row["snapshot"], row["supervisor_user_id"]
                )
                for row in rows
            ]
            if _has_active_placement(active, placement["daemonNodeId"]):
                raise ValueError(
                    "Agent already has an active placement on this daemon node."
                )
            self._create_placement_locked(conn, placement, rows, active)
        return placement

    def attach_first_managed_placement(
        self,
        agent: dict[str, Any],
        node: dict[str, Any],
        *,
        expected_placement_ids: set[str],
    ) -> dict[str, Any] | None:
        """Atomically attach a never-run agent without racing another dispatcher."""
        target_computer_id = computer_id(node)
        with self._lock, store_transaction(self.engine) as conn:
            conn.execute(
                select(DatabaseAgentStore.agents.c.id)
                .where(DatabaseAgentStore.agents.c.id == agent["id"])
                .with_for_update()
            ).first()
            rows = (
                conn.execute(
                    select(
                        self.placements.c.id,
                        self.placements.c.snapshot,
                        self.placements.c.supervisor_user_id,
                        self.placements.c.event_version,
                    )
                    .where(self.placements.c.agent_id == agent["id"])
                    .where(self.placements.c.desired_state != "removed")
                    .with_for_update()
                )
                .mappings()
                .all()
            )
            active = [
                _normalized_placement_snapshot(
                    row["snapshot"], row["supervisor_user_id"]
                )
                for row in rows
            ]
            stable = [placement for placement in active if placement.get("computerId")]
            if stable:
                return next(
                    (
                        placement
                        for placement in stable
                        if placement.get("computerId") == target_computer_id
                    ),
                    None,
                )
            if {placement["id"] for placement in active} != expected_placement_ids:
                return None
            placement = _new_placement(
                agent,
                node["id"],
                {
                    **(
                        {"managedNodeId": node["managedNodeId"]}
                        if node.get("managedNodeId")
                        else {}
                    ),
                    "computerId": target_computer_id,
                },
            )
            self._create_placement_locked(conn, placement, rows, active)
            return placement

    def _create_placement_locked(
        self,
        conn: Any,
        placement: dict[str, Any],
        rows: list[Any],
        active: list[dict[str, Any]],
    ) -> None:
        if _has_active_placement(active, placement["daemonNodeId"]):
            raise ValueError(
                "Agent already has an active placement on this daemon node."
            )
        for row, existing in zip(rows, active, strict=True):
            removed = {
                **existing,
                "desiredState": "removed",
                "updatedAt": now_iso(),
            }
            sequence = int(row["event_version"] or 0)
            removed_event = _placement_event(
                existing["id"], "placement.removed", removed
            )
            conn.execute(
                insert(self.events_table).values(
                    **_placement_event_row(row["id"], sequence, removed_event)
                )
            )
            conn.execute(
                update(self.placements)
                .where(self.placements.c.id == row["id"])
                .values(
                    **_placement_row(
                        removed,
                        event_version=sequence + 1,
                        database_id=row["id"],
                    )
                )
            )
        event = _placement_event(placement["id"], "placement.created", placement)
        row = _placement_row(placement, event_version=1)
        conn.execute(insert(self.placements).values(**row))
        conn.execute(
            insert(self.events_table).values(
                **_placement_event_row(row["id"], 0, event)
            )
        )

    def get_placement(self, placement_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.placements.c.snapshot,
                        self.placements.c.supervisor_user_id,
                    ).where(self.placements.c.id == placement_id)
                )
                .mappings()
                .first()
            )
        return (
            _normalized_placement_snapshot(
                row["snapshot"], row["supervisor_user_id"]
            )
            if row
            else None
        )

    def rebind_placement(
        self,
        placement_id: str,
        daemon_node_id: str,
        *,
        managed_node_id: str | None = None,
        computer_id_value: str | None = None,
    ) -> dict[str, Any]:
        daemon_node_id = _required_daemon_node_id(daemon_node_id)
        managed_node_id = _optional_managed_node_id(managed_node_id)
        target_computer_id = _rebind_computer_id(
            managed_node_id, computer_id_value
        )
        with self._lock, store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.placements.c.id,
                        self.placements.c.snapshot,
                        self.placements.c.supervisor_user_id,
                        self.placements.c.event_version,
                    )
                    .where(self.placements.c.id == placement_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(placement_id)
            current = _normalized_placement_snapshot(
                row["snapshot"], row["supervisor_user_id"]
            )
            if (
                current.get("daemonNodeId") == daemon_node_id
                and current.get("desiredState") == "active"
                and current.get("managedNodeId") == managed_node_id
                and current.get("computerId") == target_computer_id
            ):
                return current
            conflict = conn.execute(
                select(self.placements.c.id)
                .where(self.placements.c.agent_id == current["agentId"])
                .where(self.placements.c.id != placement_id)
                .where(self.placements.c.daemon_node_id == daemon_node_id)
                .where(self.placements.c.desired_state != "removed")
                .with_for_update()
            ).first()
            if conflict:
                raise ValueError(
                    "Agent already has an active placement on this daemon node."
                )
            updated = _rebound_placement(
                current, daemon_node_id, managed_node_id, target_computer_id
            )
            sequence = int(row["event_version"] or 0)
            event = _placement_event(placement_id, "placement.rebound", updated)
            conn.execute(
                insert(self.events_table).values(
                    **_placement_event_row(row["id"], sequence, event)
                )
            )
            conn.execute(
                update(self.placements)
                .where(self.placements.c.id == row["id"])
                .values(
                    **_placement_row(
                        updated,
                        event_version=sequence + 1,
                        database_id=row["id"],
                    )
                )
            )
            return updated

    def list_placements(
        self,
        *,
        agent_id: str | None = None,
        daemon_node_id: str | None = None,
        include_removed: bool = False,
    ) -> list[dict[str, Any]]:
        statement = select(
            self.placements.c.snapshot,
            self.placements.c.supervisor_user_id,
        )
        if agent_id is not None:
            statement = statement.where(self.placements.c.agent_id == agent_id)
        if daemon_node_id is not None:
            statement = statement.where(
                self.placements.c.daemon_node_id == daemon_node_id
            )
        if not include_removed:
            statement = statement.where(self.placements.c.desired_state != "removed")
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return sorted(
            (
                _normalized_placement_snapshot(
                    row["snapshot"], row["supervisor_user_id"]
                )
                for row in rows
            ),
            key=lambda item: (int(item.get("priority") or 100), item["id"]),
        )

    def update_placement(
        self, placement_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]:
        current = self.get_placement(placement_id)
        if not current:
            raise KeyError(placement_id)
        updated, event_type = _updated_placement(current, patch)
        event = _placement_event(placement_id, event_type, updated)
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.placements.c.id, self.placements.c.event_version)
                    .where(self.placements.c.id == placement_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(placement_id)
            sequence = int(row["event_version"] or 0)
            conn.execute(
                insert(self.events_table).values(
                    **_placement_event_row(row["id"], sequence, event)
                )
            )
            conn.execute(
                update(self.placements)
                .where(self.placements.c.id == row["id"])
                .values(
                    **_placement_row(
                        updated, event_version=sequence + 1, database_id=row["id"]
                    )
                )
            )
        return updated

    def events(self, placement_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(
                        self.events_table.c.id,
                        self.events_table.c.type,
                        self.events_table.c.timestamp,
                        self.events_table.c.payload,
                    )
                    .join(
                        self.placements,
                        self.events_table.c.placement_id == self.placements.c.id,
                    )
                    .where(self.placements.c.id == placement_id)
                    .order_by(self.events_table.c.sequence)
                )
                .mappings()
                .all()
            )
        if not rows and not self.get_placement(placement_id):
            raise KeyError(placement_id)
        return [
            {
                "id": str(row["id"]),
                "type": row["type"],
                "placementId": placement_id,
                "timestamp": _format_iso(row["timestamp"]),
                "placement": row["payload"]["placement"],
            }
            for row in rows
        ]

    def realize_agent_version(
        self, placement_id: str, agent_version: int
    ) -> dict[str, Any]:
        """Advance the diagnostic realized version under the placement row lock."""
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.placements.c.id,
                        self.placements.c.snapshot,
                        self.placements.c.supervisor_user_id,
                        self.placements.c.event_version,
                    )
                    .where(self.placements.c.id == placement_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(placement_id)
            current = _normalized_placement_snapshot(
                row["snapshot"], row["supervisor_user_id"]
            )
            if int(current.get("agentVersion") or 0) >= agent_version:
                return current
            updated = {
                **current,
                "agentVersion": agent_version,
                "updatedAt": now_iso(),
            }
            sequence = int(row["event_version"] or 0)
            event = _placement_event(placement_id, "placement.updated", updated)
            conn.execute(
                insert(self.events_table).values(
                    **_placement_event_row(row["id"], sequence, event)
                )
            )
            conn.execute(
                update(self.placements)
                .where(self.placements.c.id == row["id"])
                .values(
                    **_placement_row(
                        updated,
                        event_version=sequence + 1,
                        database_id=row["id"],
                    )
                )
            )
            return updated


def _has_active_placement(
    placements: list[dict[str, Any]], daemon_node_id: str
) -> bool:
    return any(
        placement["daemonNodeId"] == daemon_node_id
        and placement.get("desiredState") != "removed"
        for placement in placements
    )


def _placements_to_supersede(active_placements: list[dict[str, Any]]) -> list[str]:
    """Given active placements sorted by (priority, id), return the ids beyond
    each agent's top-priority one — the extras a one-agent-one-computer
    invariant must move to removed."""
    seen: set[str | None] = set()
    extras: list[str] = []
    for placement in active_placements:
        agent_id = placement.get("agentId")
        if agent_id in seen:
            extras.append(placement["id"])
        else:
            seen.add(agent_id)
    return extras


def reconcile_single_active_placement(store: Any) -> list[str]:
    """Collapse any agent holding multiple active placements down to its
    highest-priority one, moving the rest to removed. Idempotent; returns the
    superseded placement ids. Heals data written before the invariant existed
    (both file and database stores, via their public list/update API).

    Tolerates a not-yet-migrated database (schema created by Alembic after the
    app builds its stores) by skipping when the table is absent."""
    try:
        active = store.list_placements()
    except Exception as error:
        if "no such table" in str(error) or "does not exist" in str(error):
            return []
        raise
    superseded = _placements_to_supersede(active)
    for placement_id in superseded:
        store.update_placement(placement_id, {"desiredState": "removed"})
    return superseded


def _new_placement(
    agent: dict[str, Any], daemon_node_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    daemon_node_id = _required_daemon_node_id(daemon_node_id)
    desired_state = payload.get("desiredState") or "active"
    if desired_state not in PLACEMENT_DESIRED_STATES:
        raise ValueError("desiredState must be active, draining, or removed.")
    priority = payload.get("priority", 100)
    if not isinstance(priority, int):
        raise ValueError("priority must be an integer.")
    workspace_policy = payload.get("workspacePolicy") or {"kind": "node-affine"}
    if not isinstance(workspace_policy, dict):
        raise ValueError("workspacePolicy must be an object.")
    managed_node_id = _optional_managed_node_id(payload.get("managedNodeId"))
    timestamp = now_iso()
    return {
        "id": new_database_id(),
        "agentId": agent["id"],
        "supervisorUserId": agent["supervisorUserId"],
        "daemonNodeId": daemon_node_id,
        "executorKind": agent["executorKind"],
        "desiredState": desired_state,
        "priority": priority,
        "agentVersion": agent["version"],
        "workspacePolicy": workspace_policy,
        **({"managedNodeId": managed_node_id} if managed_node_id else {}),
        **(
            {"computerId": payload["computerId"]}
            if payload.get("computerId")
            else {}
        ),
        "conditions": [],
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


def _updated_placement(
    current: dict[str, Any], patch: dict[str, Any]
) -> tuple[dict[str, Any], str]:
    unknown = set(patch) - PLACEMENT_PATCH_FIELDS
    if unknown:
        raise ValueError(
            f"Unsupported placement field(s): {', '.join(sorted(unknown))}."
        )
    if (
        "desiredState" in patch
        and patch["desiredState"] not in PLACEMENT_DESIRED_STATES
    ):
        raise ValueError("desiredState must be active, draining, or removed.")
    if "priority" in patch and not isinstance(patch["priority"], int):
        raise ValueError("priority must be an integer.")
    if "agentVersion" in patch and not isinstance(patch["agentVersion"], int):
        raise ValueError("agentVersion must be an integer.")
    if "workspacePolicy" in patch and not isinstance(patch["workspacePolicy"], dict):
        raise ValueError("workspacePolicy must be an object.")
    if "conditions" in patch and not isinstance(patch["conditions"], list):
        raise ValueError("conditions must be an array.")

    updated = {**current, **patch, "updatedAt": now_iso()}
    event_type = "placement.updated"
    if patch.get("desiredState") == "draining":
        event_type = "placement.draining"
    elif patch.get("desiredState") == "removed":
        event_type = "placement.removed"
    return updated, event_type


def _required_daemon_node_id(value: str) -> str:
    daemon_node_id = value.strip()
    if not daemon_node_id:
        raise ValueError("daemonNodeId is required.")
    return daemon_node_id


def _optional_managed_node_id(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("managedNodeId must be a non-empty string.")
    return value.strip()


def _rebind_computer_id(
    managed_node_id: str | None, computer_id_value: Any
) -> str | None:
    if computer_id_value is not None and (
        not isinstance(computer_id_value, str) or not computer_id_value.strip()
    ):
        raise ValueError("computerId must be a non-empty string.")
    requested = computer_id_value.strip() if computer_id_value is not None else None
    if managed_node_id is None:
        return requested
    managed_identity = f"managed:{managed_node_id}"
    if requested is not None and requested != managed_identity:
        raise ValueError("computerId must match managedNodeId.")
    return managed_identity


def _rebound_placement(
    current: dict[str, Any],
    daemon_node_id: str,
    managed_node_id: str | None,
    computer_id_value: str | None,
) -> dict[str, Any]:
    """Bind a placement to a node, adopting that node's Computer identity.

    ``managedNodeId`` records managed ownership while ``computerId`` carries
    the stable identity for both managed and user-device Computers. Both
    are always rewritten from the target. Leaving stale values behind lets a
    managed node's sync reclaim a placement that now lives on a user
    device, which rebinds the placement back and forth indefinitely.
    """
    updated = {
        **current,
        "daemonNodeId": daemon_node_id,
        "desiredState": "active",
        "updatedAt": now_iso(),
    }
    if managed_node_id is not None:
        updated["managedNodeId"] = managed_node_id
    else:
        updated.pop("managedNodeId", None)
    if computer_id_value is not None:
        updated["computerId"] = computer_id_value
    else:
        updated.pop("computerId", None)
    return updated


def create_node_placement(
    placement_store: Any,
    agent: dict[str, Any],
    node: dict[str, Any],
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a placement stamped with its stable Computer identity."""
    placement_payload = {
        key: value
        for key, value in (payload or {}).items()
        if key not in ("managedNodeId", "computerId")
    }
    if node.get("managedNodeId"):
        placement_payload["managedNodeId"] = node["managedNodeId"]
    placement_payload["computerId"] = computer_id(node)
    return placement_store.create_placement(agent, node["id"], placement_payload)


def _normalized_placement_snapshot(
    placement: dict[str, Any], supervisor_user_id: str | None = None
) -> dict[str, Any]:
    owner = (
        placement.get("supervisorUserId")
        or placement.get("userId")
        or supervisor_user_id
    )
    return {**placement, "supervisorUserId": owner} if owner else placement


def _placement_event(
    placement_id: str, event_type: str, placement: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "placementId": placement_id,
        "timestamp": now_iso(),
        "placement": placement,
    }


def _placement_row(
    placement: dict[str, Any], *, event_version: int, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or placement["id"],
        "agent_id": placement["agentId"],
        "supervisor_user_id": placement["supervisorUserId"],
        "daemon_node_id": placement["daemonNodeId"],
        "executor_kind": placement["executorKind"],
        "desired_state": placement["desiredState"],
        "priority": int(placement.get("priority") or 100),
        "agent_version": int(placement.get("agentVersion") or 1),
        "snapshot": placement,
        "event_version": event_version,
        "created_at": _parse_iso(placement["createdAt"]),
        "updated_at": _parse_iso(placement["updatedAt"]),
    }


def _placement_event_row(
    placement_database_id: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": event["id"],
        "placement_id": placement_database_id,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": _parse_iso(event["timestamp"]),
        "payload": {"placement": event["placement"]},
    }


def placement_status(
    placement: dict[str, Any],
    agent: dict[str, Any] | None,
    daemon_node: dict[str, Any] | None,
) -> dict[str, Any]:
    conditions: list[dict[str, str]] = []
    status = "pending"
    if placement.get("desiredState") != "active":
        status = "offline"
        conditions.append(
            {
                "reason": "placement_not_active",
                "message": "Placement is not accepting new work.",
            }
        )
    elif not agent or agent.get("deletedAt") or not agent.get("enabled", True):
        status = "incompatible"
        conditions.append(
            {
                "reason": "agent_disabled",
                "message": "Logical agent is disabled or deleted.",
            }
        )
    elif not daemon_node:
        status = "offline"
        conditions.append(
            {"reason": "node_not_found", "message": "Runtime node is not registered."}
        )
    elif not daemon_node.get("online") or daemon_node.get("stale"):
        status = "offline"
        conditions.append(
            {"reason": "node_offline", "message": "Runtime node heartbeat is not live."}
        )
    else:
        executor_kind = placement.get("executorKind")
        executor_status = (daemon_node.get("agents") or {}).get(executor_kind)
        if executor_kind in set(daemon_node.get("disabledAgents") or []):
            status = "incompatible"
            conditions.append({
                "reason": "executor_not_ready",
                "message": f"{executor_kind} is disabled on this runtime node.",
            })
        elif executor_kind not in AGENT_NAMES or executor_status != "ready":
            status = "incompatible"
            conditions.append(
                {
                    "reason": "executor_not_ready",
                    "message": f"{executor_kind} is not ready on this runtime node.",
                }
            )
        elif daemon_node.get("status") == "running":
            status = "busy"
        else:
            status = "ready"
    return {**placement, "status": status, "conditions": conditions}
