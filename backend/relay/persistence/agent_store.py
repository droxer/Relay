from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import RLock
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Table,
    Text,
    UniqueConstraint,
    insert,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError

from ..core.agent_names import generate_agent_name
from ..core.ids import new_database_id, now_iso
from ..core.models import AGENT_NAMES, AGENT_ROLES
from .store_common import (
    DEFAULT_RELAY_DATA_DIR,
    _append_jsonl,
    _format_iso,
    _parse_iso,
    _read_json,
    _read_jsonl,
    _write_json,
    create_all_tables,
    database_id_column,
    entity_uuid_type,
    json_type,
    safe_name,
    shared_engine,
    store_transaction,
)
from .store_common import metadata as shared_metadata

AGENT_PATCH_FIELDS = frozenset(
    {
        "displayName",
        "profileImageUrl",
        "instructions",
        "skillPolicy",
        "toolPolicy",
        "modelPolicy",
        "enabled",
        "compatibilityKey",
    }
)
PLACEMENT_RELEVANT_AGENT_FIELDS = frozenset(
    {"instructions", "skillPolicy", "toolPolicy", "modelPolicy"}
)


class LocalAgentStore:
    """Event-sourced logical agents supervised by employees."""

    def __init__(self, root_dir: str | Path = DEFAULT_RELAY_DATA_DIR):
        self.root = Path(root_dir) / "agents"
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()

    def create_agent(
        self, supervisor_employee_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        agent = _new_agent(
            supervisor_employee_id,
            payload,
            name_taken=_name_taken(self, supervisor_employee_id),
        )
        return self._create_agent(agent)

    def _create_agent(self, agent: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._ensure_unique_name(
                agent["supervisorEmployeeId"], agent["displayName"]
            )
            self._append(agent["id"], "agent.created", {"agent": agent})
            return agent

    def ensure_compatibility_agent(
        self,
        supervisor_employee_id: str,
        executor_kind: str,
        daemon_node_id: str,
        *,
        computer_id: str | None = None,
    ) -> dict[str, Any]:
        if executor_kind not in AGENT_NAMES:
            raise ValueError(f"executorKind must be one of: {', '.join(AGENT_NAMES)}.")
        key = _compatibility_key(
            supervisor_employee_id, computer_id or daemon_node_id, executor_kind
        )
        legacy_key = _compatibility_key(
            supervisor_employee_id, daemon_node_id, executor_kind
        )
        with self._lock:
            owned = self.list_agents(supervisor_employee_id=supervisor_employee_id)
            existing = next(
                (agent for agent in owned if agent.get("compatibilityKey") == key),
                None,
            )
            if existing:
                return _migrate_compatibility_display_name(
                    self, existing, supervisor_employee_id, executor_kind
                )
            legacy = next(
                (
                    agent
                    for agent in owned
                    if key != legacy_key and agent.get("compatibilityKey") == legacy_key
                ),
                None,
            )
            if legacy:
                migrated = self.update_agent(legacy["id"], {"compatibilityKey": key})
                return _migrate_compatibility_display_name(
                    self, migrated, supervisor_employee_id, executor_kind
                )
            agent = _new_agent(
                supervisor_employee_id,
                {
                    "displayName": _compatibility_display_name(owned, executor_kind),
                    "executorKind": executor_kind,
                    "defaultRole": "implementer",
                },
            )
            return self._create_agent({**agent, "compatibilityKey": key})

    def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        snapshot = self._snapshot_path(agent_id)
        return (
            _normalized_agent_snapshot(_read_json(snapshot))
            if snapshot.exists()
            else None
        )

    def list_agents(
        self,
        *,
        supervisor_employee_id: str | None = None,
        employee_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        if employee_id is not None:
            if (
                supervisor_employee_id is not None
                and supervisor_employee_id != employee_id
            ):
                raise ValueError(
                    "employee_id and supervisor_employee_id must match when both are supplied."
                )
            supervisor_employee_id = employee_id
        agents = [
            _normalized_agent_snapshot(_read_json(path))
            for path in self.root.glob("*/snapshot.json")
        ]
        if supervisor_employee_id is not None:
            agents = [
                agent
                for agent in agents
                if agent.get("supervisorEmployeeId") == supervisor_employee_id
            ]
        if not include_deleted:
            agents = [agent for agent in agents if not agent.get("deletedAt")]
        return sorted(
            agents,
            key=lambda agent: (
                agent.get("supervisorEmployeeId") or "",
                agent.get("displayName", "").casefold(),
                agent["id"],
            ),
        )

    def update_agent(self, agent_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self.get_agent(agent_id)
            if not current or current.get("deletedAt"):
                raise KeyError(agent_id)
            updated, normalized, event_type = _updated_agent(
                agent_id, current, patch, self._ensure_unique_name
            )
            self._append(agent_id, event_type, {"patch": normalized, "agent": updated})
            return updated

    def transform_skill_policy(
        self,
        agent_id: str,
        transform: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        """Atomically replace skillPolicy through the agent event log."""
        with self._lock:
            current = self.get_agent(agent_id)
            if not current or current.get("deletedAt"):
                raise KeyError(agent_id)
            return self.update_agent(
                agent_id,
                {"skillPolicy": transform(dict(current.get("skillPolicy") or {}))},
            )

    def delete_agent(self, agent_id: str) -> dict[str, Any]:
        with self._lock:
            current = self.get_agent(agent_id)
            if not current or current.get("deletedAt"):
                raise KeyError(agent_id)
            updated = {
                **current,
                "enabled": False,
                "deletedAt": now_iso(),
                "updatedAt": now_iso(),
            }
            self._append(agent_id, "agent.deleted", {"agent": updated})
            return updated

    def set_birth_certificate(
        self, agent_id: str, *, computer_id: str, default_role: str
    ) -> dict[str, Any]:
        """Migration and identity-promotion use only: write a durable birth
        certificate and clear any compatibility identity.

        These fields are fixed at creation and immutable on the normal path;
        Legacy records predate the concept, and early migrations could persist
        a provisional ``node:`` identity. Only migration and daemon sync may
        repair those records through this event-sourced path.

        Clearing compatibilityKey must go through here too — update_agent
        won't work, because _updated_agent routes that field through
        _required_string (agent_store.py:828), which treats an empty string
        as a missing required value and raises ValueError.
        """
        with self._lock:
            current = self.get_agent(agent_id)
            if not current:
                raise KeyError(agent_id)
            updated = {
                key: value
                for key, value in current.items()
                if key != "compatibilityKey"
            }
            updated |= {
                "computerId": computer_id,
                "defaultRole": default_role,
                "version": int(current.get("version") or 1) + 1,
                "updatedAt": now_iso(),
            }
            self._append(agent_id, "agent.updated", {"agent": updated})
            return updated

    def events(self, agent_id: str) -> list[dict[str, Any]]:
        return _read_jsonl(self._events_path(agent_id))

    def _ensure_unique_name(
        self,
        supervisor_employee_id: str,
        display_name: str,
        *,
        exclude_id: str | None = None,
    ) -> None:
        duplicate = next(
            (
                agent
                for agent in self.list_agents(
                    supervisor_employee_id=supervisor_employee_id
                )
                if (
                    agent["id"] != exclude_id
                    and agent.get("displayName", "").casefold()
                    == display_name.casefold()
                )
            ),
            None,
        )
        if duplicate:
            raise ValueError(
                f"Supervisor {supervisor_employee_id} already has an agent named {display_name}."
            )

    def _append(self, agent_id: str, event_type: str, payload: dict[str, Any]) -> None:
        event = {
            "id": new_database_id(),
            "type": event_type,
            "agentId": agent_id,
            "timestamp": now_iso(),
            **payload,
        }
        _append_jsonl(self._events_path(agent_id), event)
        _write_json(self._snapshot_path(agent_id), payload["agent"])

    def _events_path(self, agent_id: str) -> Path:
        return self.root / safe_name(agent_id) / "events.jsonl"

    def _snapshot_path(self, agent_id: str) -> Path:
        return self.root / safe_name(agent_id) / "snapshot.json"


class DatabaseAgentStore:
    metadata = shared_metadata
    agents = Table(
        "agents",
        metadata,
        database_id_column(),
        Column(
            "supervisor_employee_id",
            entity_uuid_type(),
            ForeignKey(
                "employees.id",
                ondelete="RESTRICT",
                name="fk_agents_supervisor_employee",
            ),
            nullable=False,
            index=True,
        ),
        Column("display_name", Text, nullable=False),
        Column("display_name_key", Text, nullable=True),
        Column("executor_kind", Text, nullable=False),
        Column("compatibility_key", Text, nullable=True),
        Column("enabled", Boolean, nullable=False),
        Column("agent_version", BigInteger, nullable=False),
        Column("snapshot", json_type(), nullable=False),
        Column("event_version", BigInteger, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("deleted_at", DateTime(timezone=True), nullable=True),
        # Uniqueness applies to an employee's *live* agents. Deleting used to
        # mean nulling display_name_key and dropping compatibility_key so the
        # row escaped a whole-table constraint; the predicate says it directly,
        # so both key columns are now written unconditionally.
        Index(
            "uq_agents_live_supervisor_display_name",
            "supervisor_employee_id",
            "display_name_key",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
        Index(
            "uq_agents_live_compatibility_key",
            "compatibility_key",
            unique=True,
            postgresql_where=text(
                "deleted_at IS NULL AND compatibility_key IS NOT NULL"
            ),
            sqlite_where=text("deleted_at IS NULL AND compatibility_key IS NOT NULL"),
        ),
    )
    events_table = Table(
        "agent_events",
        metadata,
        database_id_column(),
        Column(
            "agent_id",
            entity_uuid_type(),
            ForeignKey("agents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("sequence", BigInteger, nullable=False),
        Column("type", Text, nullable=False),
        Column("timestamp", DateTime(timezone=True), nullable=False),
        Column("payload", json_type(), nullable=False),
        UniqueConstraint(
            "agent_id", "sequence", name="uq_employee_agent_events_sequence"
        ),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        # SQLite ignores SELECT FOR UPDATE. This lock supplies equivalent
        # same-process serialization; PostgreSQL additionally takes a row lock.
        self._skill_policy_lock = RLock()
        if create_schema:
            create_all_tables(self.engine)

    def create_agent(
        self, supervisor_employee_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        agent = _new_agent(
            supervisor_employee_id,
            payload,
            name_taken=_name_taken(self, supervisor_employee_id),
        )
        return self._create_agent(agent)

    def _create_agent(self, agent: dict[str, Any]) -> dict[str, Any]:
        self._ensure_unique_name(agent["supervisorEmployeeId"], agent["displayName"])
        event = _agent_event(agent["id"], "agent.created", {"agent": agent})
        try:
            with store_transaction(self.engine) as conn:
                row = _agent_row(agent, event_version=1)
                conn.execute(insert(self.agents).values(**row))
                conn.execute(
                    insert(self.events_table).values(
                        **_agent_event_row(row["id"], 0, event)
                    )
                )
        except IntegrityError as error:
            raise ValueError(
                f"Supervisor {agent['supervisorEmployeeId']} already has an agent named {agent['displayName']}."
            ) from error
        return agent

    def ensure_compatibility_agent(
        self,
        supervisor_employee_id: str,
        executor_kind: str,
        daemon_node_id: str,
        *,
        computer_id: str | None = None,
    ) -> dict[str, Any]:
        if executor_kind not in AGENT_NAMES:
            raise ValueError(f"executorKind must be one of: {', '.join(AGENT_NAMES)}.")
        key = _compatibility_key(
            supervisor_employee_id, computer_id or daemon_node_id, executor_kind
        )
        legacy_key = _compatibility_key(
            supervisor_employee_id, daemon_node_id, executor_kind
        )
        owned = self.list_agents(supervisor_employee_id=supervisor_employee_id)
        existing = next(
            (agent for agent in owned if agent.get("compatibilityKey") == key), None
        )
        if existing:
            return _migrate_compatibility_display_name(
                self, existing, supervisor_employee_id, executor_kind
            )
        legacy = next(
            (
                agent
                for agent in owned
                if key != legacy_key and agent.get("compatibilityKey") == legacy_key
            ),
            None,
        )
        if legacy:
            migrated = self.update_agent(legacy["id"], {"compatibilityKey": key})
            return _migrate_compatibility_display_name(
                self, migrated, supervisor_employee_id, executor_kind
            )
        agent = _new_agent(
            supervisor_employee_id,
            {
                "displayName": _compatibility_display_name(owned, executor_kind),
                "executorKind": executor_kind,
                "defaultRole": "implementer",
            },
        )
        return self._create_agent({**agent, "compatibilityKey": key})

    def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.agents.c.snapshot,
                        self.agents.c.supervisor_employee_id,
                    ).where(self.agents.c.id == agent_id)
                )
                .mappings()
                .first()
            )
        return (
            _normalized_agent_snapshot(row["snapshot"], row["supervisor_employee_id"])
            if row
            else None
        )

    def list_agents(
        self,
        *,
        supervisor_employee_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        statement = select(
            self.agents.c.snapshot,
            self.agents.c.supervisor_employee_id,
        )
        if supervisor_employee_id is not None:
            statement = statement.where(
                self.agents.c.supervisor_employee_id == supervisor_employee_id
            )
        if not include_deleted:
            statement = statement.where(self.agents.c.deleted_at.is_(None))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return sorted(
            (
                _normalized_agent_snapshot(
                    row["snapshot"], row["supervisor_employee_id"]
                )
                for row in rows
            ),
            key=lambda agent: (
                agent.get("supervisorEmployeeId") or "",
                agent.get("displayName", "").casefold(),
                agent["id"],
            ),
        )

    def update_agent(self, agent_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        current = self.get_agent(agent_id)
        if not current or current.get("deletedAt"):
            raise KeyError(agent_id)
        updated, normalized, event_type = _updated_agent(
            agent_id, current, patch, self._ensure_unique_name
        )
        return self._append(
            agent_id, event_type, updated, {"patch": normalized, "agent": updated}
        )

    def transform_skill_policy(
        self,
        agent_id: str,
        transform: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        """Lock, transform, and append one authoritative agent event."""
        with self._skill_policy_lock, store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.agents.c.id,
                        self.agents.c.snapshot,
                        self.agents.c.supervisor_employee_id,
                        self.agents.c.event_version,
                    )
                    .where(self.agents.c.id == agent_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(agent_id)
            current = _normalized_agent_snapshot(
                row["snapshot"], row["supervisor_employee_id"]
            )
            if current.get("deletedAt"):
                raise KeyError(agent_id)
            policy = transform(dict(current.get("skillPolicy") or {}))
            updated, normalized, event_type = _updated_agent(
                agent_id,
                current,
                {"skillPolicy": policy},
                self._ensure_unique_name,
            )
            sequence = int(row["event_version"] or 0)
            event = _agent_event(
                agent_id,
                event_type,
                {"patch": normalized, "agent": updated},
            )
            conn.execute(
                insert(self.events_table).values(
                    **_agent_event_row(row["id"], sequence, event)
                )
            )
            conn.execute(
                update(self.agents)
                .where(self.agents.c.id == row["id"])
                .values(
                    **_agent_row(
                        updated,
                        event_version=sequence + 1,
                        database_id=row["id"],
                    )
                )
            )
        return updated

    def delete_agent(self, agent_id: str) -> dict[str, Any]:
        current = self.get_agent(agent_id)
        if not current or current.get("deletedAt"):
            raise KeyError(agent_id)
        timestamp = now_iso()
        updated = {
            **current,
            "enabled": False,
            "deletedAt": timestamp,
            "updatedAt": timestamp,
        }
        return self._append(agent_id, "agent.deleted", updated, {"agent": updated})

    def set_birth_certificate(
        self, agent_id: str, *, computer_id: str, default_role: str
    ) -> dict[str, Any]:
        """Migration and identity-promotion only: write a durable birth
        certificate and clear any compatibility identity.

        These fields are fixed at creation and unpatchable on the normal
        path. Legacy records predate the concept, and early migrations could
        persist a provisional ``node:`` identity, so migration and daemon sync
        repair them through this event-sourced entry point.

        Clearing compatibilityKey must go through here rather than
        update_agent, because _updated_agent routes that field through
        _required_string (agent_store.py:~828), and an empty string there
        is treated as a missing required field and raises ValueError.
        `_agent_row` writes `compatibility_key` from `agent.get(...)`, so
        omitting the key from `updated` writes the column as NULL, freeing
        it from the `uq_agents_live_compatibility_key` partial unique index.
        """
        current = self.get_agent(agent_id)
        if not current:
            raise KeyError(agent_id)
        updated = {
            key: value for key, value in current.items() if key != "compatibilityKey"
        }
        updated |= {
            "computerId": computer_id,
            "defaultRole": default_role,
            "version": int(current.get("version") or 1) + 1,
            "updatedAt": now_iso(),
        }
        return self._append(agent_id, "agent.updated", updated, {"agent": updated})

    def events(self, agent_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(
                        self.events_table.c.id,
                        self.events_table.c.type,
                        self.events_table.c.timestamp,
                        self.events_table.c.payload,
                    )
                    .join(self.agents, self.events_table.c.agent_id == self.agents.c.id)
                    .where(self.agents.c.id == agent_id)
                    .order_by(self.events_table.c.sequence)
                )
                .mappings()
                .all()
            )
        if not rows and not self.get_agent(agent_id):
            raise KeyError(agent_id)
        return [
            {
                "id": str(row["id"]),
                "type": row["type"],
                "agentId": agent_id,
                "timestamp": _format_iso(row["timestamp"]),
                **row["payload"],
            }
            for row in rows
        ]

    def _append(
        self,
        agent_id: str,
        event_type: str,
        agent: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        event = _agent_event(agent_id, event_type, payload)
        try:
            with store_transaction(self.engine) as conn:
                row = (
                    conn.execute(
                        select(self.agents.c.id, self.agents.c.event_version)
                        .where(self.agents.c.id == agent_id)
                        .with_for_update()
                    )
                    .mappings()
                    .first()
                )
                if not row:
                    raise KeyError(agent_id)
                sequence = int(row["event_version"] or 0)
                conn.execute(
                    insert(self.events_table).values(
                        **_agent_event_row(row["id"], sequence, event)
                    )
                )
                conn.execute(
                    update(self.agents)
                    .where(self.agents.c.id == row["id"])
                    .values(
                        **_agent_row(
                            agent,
                            event_version=sequence + 1,
                            database_id=row["id"],
                        )
                    )
                )
        except IntegrityError as error:
            raise ValueError(
                f"Supervisor {agent['supervisorEmployeeId']} already has an agent named {agent['displayName']}."
            ) from error
        return agent

    def _ensure_unique_name(
        self,
        supervisor_employee_id: str,
        display_name: str,
        *,
        exclude_id: str | None = None,
    ) -> None:
        duplicate = next(
            (
                agent
                for agent in self.list_agents(
                    supervisor_employee_id=supervisor_employee_id
                )
                if agent["id"] != exclude_id
                and agent.get("displayName", "").casefold() == display_name.casefold()
            ),
            None,
        )
        if duplicate:
            raise ValueError(
                f"Supervisor {supervisor_employee_id} already has an agent named {display_name}."
            )


def _name_taken(store: Any, supervisor_employee_id: str) -> Callable[[str], bool]:
    existing = {
        agent.get("displayName", "").casefold()
        for agent in store.list_agents(supervisor_employee_id=supervisor_employee_id)
    }
    return lambda candidate: candidate.casefold() in existing


def _new_agent(
    supervisor_employee_id: str,
    payload: dict[str, Any],
    *,
    name_taken: Callable[[str], bool] | None = None,
) -> dict[str, Any]:
    supervisor_employee_id = supervisor_employee_id.strip()
    raw_display_name = payload.get("displayName")
    if raw_display_name is not None and not isinstance(raw_display_name, str):
        raise ValueError("displayName must be a string.")
    display_name = raw_display_name.strip() if isinstance(raw_display_name, str) else ""
    if not display_name:
        display_name = generate_agent_name(taken=name_taken or (lambda _: False))
    executor_kind = _required_string(payload, "executorKind")
    default_role = _optional_string(payload, "defaultRole")
    if not default_role:
        raise ValueError("defaultRole is required.")
    if not supervisor_employee_id:
        raise ValueError("supervisorEmployeeId is required.")
    if executor_kind not in AGENT_NAMES:
        raise ValueError(f"executorKind must be one of: {', '.join(AGENT_NAMES)}.")
    if default_role not in AGENT_ROLES:
        raise ValueError(f"defaultRole must be one of: {', '.join(AGENT_ROLES)}.")
    timestamp = now_iso()
    return {
        "id": new_database_id(),
        "supervisorEmployeeId": supervisor_employee_id,
        "displayName": display_name,
        "executorKind": executor_kind,
        "defaultRole": default_role,
        **(
            {"computerId": _optional_string(payload, "computerId")}
            if _optional_string(payload, "computerId")
            else {}
        ),
        **(
            {"instructions": payload["instructions"].strip()}
            if isinstance(payload.get("instructions"), str)
            and payload["instructions"].strip()
            else {}
        ),
        "skillPolicy": _policy(payload, "skillPolicy"),
        "toolPolicy": _policy(payload, "toolPolicy"),
        "modelPolicy": _policy(payload, "modelPolicy"),
        "enabled": payload.get("enabled") is not False,
        "version": 1,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


def _updated_agent(
    agent_id: str,
    current: dict[str, Any],
    patch: dict[str, Any],
    ensure_unique_name: Callable[..., None],
) -> tuple[dict[str, Any], dict[str, Any], str]:
    unknown = set(patch) - AGENT_PATCH_FIELDS
    if unknown:
        raise ValueError(f"Unsupported agent field(s): {', '.join(sorted(unknown))}.")

    normalized = _normalize_agent_identity_patch(
        agent_id, current, patch, ensure_unique_name
    )
    normalized.update(_normalize_agent_runtime_patch(patch))

    updated = {
        **current,
        **normalized,
        "version": int(current.get("version") or 1)
        + (1 if PLACEMENT_RELEVANT_AGENT_FIELDS.intersection(normalized) else 0),
        "updatedAt": now_iso(),
    }
    event_type = "agent.updated"
    if normalized.get("enabled") is False:
        event_type = "agent.disabled"
    elif normalized.get("enabled") is True and not current.get("enabled", True):
        event_type = "agent.enabled"
    return updated, normalized, event_type


def _normalize_agent_identity_patch(
    agent_id: str,
    current: dict[str, Any],
    patch: dict[str, Any],
    ensure_unique_name: Callable[..., None],
) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    if "displayName" in patch:
        display_name = _required_string(patch, "displayName")
        ensure_unique_name(
            current["supervisorEmployeeId"], display_name, exclude_id=agent_id
        )
        normalized["displayName"] = display_name
    if "profileImageUrl" in patch:
        image_url = patch["profileImageUrl"]
        if image_url is not None and (
            not isinstance(image_url, str)
            or not image_url.startswith(f"/profile-images/agents/{agent_id}?v=")
        ):
            raise ValueError("profileImageUrl is invalid.")
        normalized["profileImageUrl"] = image_url
    if "compatibilityKey" in patch:
        normalized["compatibilityKey"] = _required_string(patch, "compatibilityKey")
    return normalized


def _normalize_agent_runtime_patch(patch: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    if "instructions" in patch:
        normalized["instructions"] = (
            patch["instructions"].strip()
            if isinstance(patch["instructions"], str)
            else ""
        )
    for field in ("skillPolicy", "toolPolicy", "modelPolicy"):
        if field in patch:
            normalized[field] = _policy(patch, field)
    if "enabled" in patch:
        if not isinstance(patch["enabled"], bool):
            raise ValueError("enabled must be a boolean.")
        normalized["enabled"] = patch["enabled"]
    return normalized


def _normalized_agent_snapshot(
    agent: dict[str, Any], supervisor_employee_id: str | None = None
) -> dict[str, Any]:
    owner = (
        agent.get("supervisorEmployeeId")
        or agent.get("employeeId")
        or supervisor_employee_id
    )
    return {**agent, "supervisorEmployeeId": owner} if owner else agent


def _compatibility_key(
    supervisor_employee_id: str, computer_id: str, executor_kind: str
) -> str:
    # A compatibility agent belongs to one stable Computer. Employee devices
    # use their durable daemon id; managed Computers use managedNodeId so a
    # replaceable daemon incarnation never changes Logical Agent identity.
    return f"{supervisor_employee_id}:{computer_id}:{executor_kind}"


def compatibility_computer_id(agent: dict[str, Any]) -> str | None:
    """The Computer a compatibility agent stands in for, if it is scoped to one.

    Returns None for ordinary agents and for legacy two-segment keys that
    predate Computer scoping, both of which are free to be placed anywhere.
    """
    key = agent.get("compatibilityKey")
    if not isinstance(key, str):
        return None
    segments = key.split(":")
    return segments[1] if len(segments) == 3 else None


def _migrate_compatibility_display_name(
    store: Any, agent: dict[str, Any], supervisor_employee_id: str, executor_kind: str
) -> dict[str, Any]:
    legacy_prefix = f"{executor_kind.capitalize()} · "
    if not agent.get("displayName", "").startswith(legacy_prefix):
        return agent
    others = [
        item
        for item in store.list_agents(supervisor_employee_id=supervisor_employee_id)
        if item["id"] != agent["id"]
    ]
    return store.update_agent(
        agent["id"], {"displayName": _compatibility_display_name(others, executor_kind)}
    )


def _compatibility_display_name(
    agents: list[dict[str, Any]], executor_kind: str
) -> str:
    existing_names = {agent.get("displayName", "").casefold() for agent in agents}
    base = executor_kind.capitalize()
    if base.casefold() not in existing_names:
        return base
    suffix = 2
    while f"{base} {suffix}".casefold() in existing_names:
        suffix += 1
    return f"{base} {suffix}"


def _agent_event(
    agent_id: str, event_type: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "agentId": agent_id,
        "timestamp": now_iso(),
        **payload,
    }


def _agent_row(
    agent: dict[str, Any], *, event_version: int, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or agent["id"],
        "supervisor_employee_id": agent["supervisorEmployeeId"],
        "display_name": agent["displayName"],
        # Written unconditionally: uniqueness is scoped to live agents by the
        # partial index, so a soft delete no longer has to erase its own keys.
        "display_name_key": agent["displayName"].strip().casefold(),
        "executor_kind": agent["executorKind"],
        "compatibility_key": agent.get("compatibilityKey"),
        "enabled": agent.get("enabled", True),
        "agent_version": int(agent.get("version") or 1),
        "snapshot": agent,
        "event_version": event_version,
        "created_at": _parse_iso(agent["createdAt"]),
        "updated_at": _parse_iso(agent["updatedAt"]),
        "deleted_at": _parse_iso(agent.get("deletedAt")),
    }


def _agent_event_row(
    agent_database_id: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": event["id"],
        "agent_id": agent_database_id,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": _parse_iso(event["timestamp"]),
        "payload": {
            key: value
            for key, value in event.items()
            if key not in {"id", "type", "agentId", "timestamp"}
        },
    }


def _required_string(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} is required.")
    return value.strip()


def _optional_string(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _policy(payload: dict[str, Any], field: str) -> dict[str, Any]:
    value = payload.get(field)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object.")
    if value and field != "skillPolicy":
        raise ValueError(
            f"{field} is reserved until runtime enforcement is available; "
            "non-empty policies are not accepted."
        )
    return dict(value) if field == "skillPolicy" else {}
