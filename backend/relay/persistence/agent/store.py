from __future__ import annotations

from collections.abc import Callable
from threading import RLock
from typing import Any

from sqlalchemy import (
    insert,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError

from ...core.agent_names import generate_agent_name
from ...core.computer_identity import is_provisional_computer_id
from ...core.ids import new_database_id, now_iso
from ...core.model_policy import normalize_model_policy, policy_model
from ...core.models import AGENT_NAMES, AGENT_ROLES
from ...core.preset_avatars import validate_profile_image_url
from ..db_time import format_db_time, parse_db_time
from ..engine import create_all_tables, shared_engine, store_transaction
from ..sql import metadata as shared_metadata
from ..tables import agents as agents_tables

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


class DatabaseAgentStore:
    metadata = shared_metadata
    agents = agents_tables.agents
    events_table = agents_tables.events_table

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        # SQLite ignores SELECT FOR UPDATE. This lock supplies equivalent
        # same-process serialization; PostgreSQL additionally takes a row lock.
        self._skill_policy_lock = RLock()
        if create_schema:
            create_all_tables(self.engine)

    def create_agent(
        self, supervisor_user_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        agent = _new_agent(
            supervisor_user_id,
            payload,
            name_taken=_name_taken(self, supervisor_user_id),
        )
        return self._create_agent(agent)

    def _create_agent(self, agent: dict[str, Any]) -> dict[str, Any]:
        self._ensure_unique_name(agent["supervisorUserId"], agent["displayName"])
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
                f"Supervisor {agent['supervisorUserId']} already has an agent named {agent['displayName']}."
            ) from error
        return agent

    def ensure_compatibility_agent(
        self,
        supervisor_user_id: str,
        executor_kind: str,
        daemon_node_id: str,
        *,
        computer_id: str | None = None,
    ) -> dict[str, Any]:
        return _ensure_compatibility_agent(
            self, supervisor_user_id, executor_kind, daemon_node_id, computer_id
        )

    def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.agents.c.snapshot,
                        self.agents.c.supervisor_user_id,
                    ).where(self.agents.c.id == agent_id)
                )
                .mappings()
                .first()
            )
        return (
            _normalized_agent_snapshot(row["snapshot"], row["supervisor_user_id"])
            if row
            else None
        )

    def list_agents(
        self,
        *,
        supervisor_user_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        statement = select(
            self.agents.c.snapshot,
            self.agents.c.supervisor_user_id,
        )
        if supervisor_user_id is not None:
            statement = statement.where(
                self.agents.c.supervisor_user_id == supervisor_user_id
            )
        if not include_deleted:
            statement = statement.where(self.agents.c.deleted_at.is_(None))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return sorted(
            (
                _normalized_agent_snapshot(
                    row["snapshot"], row["supervisor_user_id"]
                )
                for row in rows
            ),
            key=lambda agent: (
                agent.get("supervisorUserId") or "",
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
                        self.agents.c.supervisor_user_id,
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
                row["snapshot"], row["supervisor_user_id"]
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
        _required_string (this module), and an empty string there
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

    def move_to_computer(self, agent_id: str, computer_id: str) -> dict[str, Any]:
        """Record that the agent now lives on another computer.

        An agent lives on exactly one computer, and placing it on a different
        one moves it; this keeps the agent record the single answer to "where
        does it live". The configuration is unchanged, so the version is too.
        """
        current = self.get_agent(agent_id)
        if not current or current.get("deletedAt"):
            raise KeyError(agent_id)
        if current.get("computerId") == computer_id:
            return current
        updated = {**current, "computerId": computer_id, "updatedAt": now_iso()}
        return self._append(agent_id, "agent.moved", updated, {"agent": updated})

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
                "timestamp": format_db_time(row["timestamp"]),
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
                f"Supervisor {agent['supervisorUserId']} already has an agent named {agent['displayName']}."
            ) from error
        return agent

    def _ensure_unique_name(
        self,
        supervisor_user_id: str,
        display_name: str,
        *,
        exclude_id: str | None = None,
    ) -> None:
        duplicate = next(
            (
                agent
                for agent in self.list_agents(
                    supervisor_user_id=supervisor_user_id
                )
                if agent["id"] != exclude_id
                and agent.get("displayName", "").casefold() == display_name.casefold()
            ),
            None,
        )
        if duplicate:
            raise ValueError(
                f"Supervisor {supervisor_user_id} already has an agent named {display_name}."
            )


def _name_taken(store: Any, supervisor_user_id: str) -> Callable[[str], bool]:
    existing = {
        agent.get("displayName", "").casefold()
        for agent in store.list_agents(supervisor_user_id=supervisor_user_id)
    }
    return lambda candidate: candidate.casefold() in existing


def _new_agent(
    supervisor_user_id: str,
    payload: dict[str, Any],
    *,
    name_taken: Callable[[str], bool] | None = None,
) -> dict[str, Any]:
    supervisor_user_id = supervisor_user_id.strip()
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
    if not supervisor_user_id:
        raise ValueError("supervisorUserId is required.")
    if executor_kind not in AGENT_NAMES:
        raise ValueError(f"executorKind must be one of: {', '.join(AGENT_NAMES)}.")
    if default_role not in AGENT_ROLES:
        raise ValueError(f"defaultRole must be one of: {', '.join(AGENT_ROLES)}.")
    agent_id = new_database_id()
    profile_image_url = validate_profile_image_url(
        "agents", agent_id, payload.get("profileImageUrl")
    )
    timestamp = now_iso()
    return {
        "id": agent_id,
        "supervisorUserId": supervisor_user_id,
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
        **({"profileImageUrl": profile_image_url} if profile_image_url else {}),
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
            current["supervisorUserId"], display_name, exclude_id=agent_id
        )
        normalized["displayName"] = display_name
    if "profileImageUrl" in patch:
        normalized["profileImageUrl"] = validate_profile_image_url(
            "agents", agent_id, patch["profileImageUrl"]
        )
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
    agent: dict[str, Any], supervisor_user_id: str | None = None
) -> dict[str, Any]:
    owner = (
        agent.get("supervisorUserId")
        or agent.get("userId")
        or supervisor_user_id
    )
    return {**agent, "supervisorUserId": owner} if owner else agent


def _ensure_compatibility_agent(
    store: Any,
    supervisor_user_id: str,
    executor_kind: str,
    daemon_node_id: str,
    computer_id: str | None,
) -> dict[str, Any]:
    """The agent a legacy ``assignments: [{agent}]`` run executes as.

    On a stable Computer the run gets a declared agent — reused when one of
    this runtime already lives there, else born with its ``computerId`` — so
    nothing is left for the startup migration to convert. Only a provisional
    ``node:`` identity still mints a keyed compatibility agent; daemon sync
    promotes it once the node reports a stable identity.
    """
    if executor_kind not in AGENT_NAMES:
        raise ValueError(f"executorKind must be one of: {', '.join(AGENT_NAMES)}.")
    key = _compatibility_key(
        supervisor_user_id, computer_id or daemon_node_id, executor_kind
    )
    legacy_key = _compatibility_key(supervisor_user_id, daemon_node_id, executor_kind)
    owned = [
        agent
        for agent in store.list_agents(supervisor_user_id=supervisor_user_id)
        if not agent.get("deletedAt")
    ]
    existing = next(
        (agent for agent in owned if agent.get("compatibilityKey") == key), None
    )
    if existing:
        return _migrate_compatibility_display_name(
            store, existing, supervisor_user_id, executor_kind
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
        migrated = store.update_agent(legacy["id"], {"compatibilityKey": key})
        return _migrate_compatibility_display_name(
            store, migrated, supervisor_user_id, executor_kind
        )
    stable = bool(computer_id) and not is_provisional_computer_id(computer_id)
    if stable:
        declared = sorted(
            (
                agent
                for agent in owned
                if not agent.get("compatibilityKey")
                and agent.get("enabled", True)
                and agent.get("executorKind") == executor_kind
                and agent.get("computerId") == computer_id
            ),
            key=lambda agent: (agent.get("createdAt") or "", agent["id"]),
        )
        if declared:
            return declared[0]
    agent = _new_agent(
        supervisor_user_id,
        {
            "displayName": _compatibility_display_name(owned, executor_kind),
            "executorKind": executor_kind,
            "defaultRole": "implementer",
            **({"computerId": computer_id} if stable else {}),
        },
    )
    return store._create_agent(agent if stable else {**agent, "compatibilityKey": key})


def _compatibility_key(
    supervisor_user_id: str, computer_id: str, executor_kind: str
) -> str:
    # A compatibility agent belongs to one stable Computer. User devices
    # use their durable daemon id; managed Computers use managedNodeId so a
    # replaceable daemon incarnation never changes Logical Agent identity.
    return f"{supervisor_user_id}:{computer_id}:{executor_kind}"


def _migrate_compatibility_display_name(
    store: Any, agent: dict[str, Any], supervisor_user_id: str, executor_kind: str
) -> dict[str, Any]:
    legacy_prefix = f"{executor_kind.capitalize()} · "
    if not agent.get("displayName", "").startswith(legacy_prefix):
        return agent
    others = [
        item
        for item in store.list_agents(supervisor_user_id=supervisor_user_id)
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
        "supervisor_user_id": agent["supervisorUserId"],
        "display_name": agent["displayName"],
        # Written unconditionally: uniqueness is scoped to live agents by the
        # partial index, so a soft delete no longer has to erase its own keys.
        "display_name_key": agent["displayName"].strip().casefold(),
        "executor_kind": agent["executorKind"],
        "model": policy_model(agent),
        "compatibility_key": agent.get("compatibilityKey"),
        "enabled": agent.get("enabled", True),
        "agent_version": int(agent.get("version") or 1),
        "snapshot": agent,
        "event_version": event_version,
        "created_at": parse_db_time(agent["createdAt"]),
        "updated_at": parse_db_time(agent["updatedAt"]),
        "deleted_at": parse_db_time(agent.get("deletedAt")),
    }


def _agent_event_row(
    agent_database_id: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": event["id"],
        "agent_id": agent_database_id,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": parse_db_time(event["timestamp"]),
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
    if field == "modelPolicy":
        return normalize_model_policy(value)
    if value and field != "skillPolicy":
        raise ValueError(
            f"{field} is reserved until runtime enforcement is available; "
            "non-empty policies are not accepted."
        )
    return dict(value) if field == "skillPolicy" else {}
