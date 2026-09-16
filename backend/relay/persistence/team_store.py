from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import RLock
from typing import Any

from sqlalchemy import (
    JSON,
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

from ..core.ids import new_database_id, now_iso
from ..core.preset_avatars import validate_profile_image_url
from .store_common import (
    DEFAULT_RELAY_DATA_DIR,
    _append_jsonl,
    _format_iso,
    _parse_iso,
    _read_json,
    _read_jsonl,
    _write_json,
    database_id_column,
    entity_uuid_type,
    create_all_tables,
    json_type,
    shared_engine,
    store_transaction,
    metadata as shared_metadata,
    safe_name,
)


class TeamValidationError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


class _TeamWriteConflict(RuntimeError):
    pass


def validate_team_payload(
    owner_employee_id: str,
    payload: dict[str, Any],
    agent_store: Any,
    *,
    current: dict[str, Any] | None = None,
) -> tuple[str, list[str]]:
    members = payload.get(
        "memberAgentIds", (current or {}).get("memberAgentIds", [])
    )
    lead = payload.get("leadAgentId", (current or {}).get("leadAgentId"))
    if not isinstance(members, list) or not members or any(
        not isinstance(item, str) or not item.strip() for item in members
    ):
        raise TeamValidationError("team_members_required")
    normalized = [item.strip() for item in members]
    if len(set(normalized)) != len(normalized):
        raise TeamValidationError("team_members_duplicate")
    if not isinstance(lead, str) or not lead.strip() or lead.strip() not in normalized:
        raise TeamValidationError("team_lead_not_member")
    lead = lead.strip()
    for agent_id in normalized:
        agent = agent_store.get_agent(agent_id)
        if not agent or agent.get("deletedAt"):
            raise TeamValidationError("team_member_not_found")
        if agent.get("supervisorEmployeeId") != owner_employee_id:
            raise TeamValidationError("team_member_wrong_supervisor")
    return lead, normalized


class LocalTeamStore:
    def __init__(self, root_dir: str | Path = DEFAULT_RELAY_DATA_DIR):
        self.root = Path(root_dir) / "teams"
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()

    def create_team(
        self, owner_employee_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        team = _new_team(owner_employee_id, payload)
        with self._lock:
            self._ensure_unique_name(team["ownerEmployeeId"], team["name"])
            self._append(team["id"], "team.created", {"team": team})
        return team

    def get_team(self, team_id: str) -> dict[str, Any] | None:
        path = self._snapshot_path(team_id)
        return _normalized_team_snapshot(_read_json(path)) if path.exists() else None

    def list_teams(
        self,
        owner_employee_id: str | None = None,
        *,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        teams = [
            _normalized_team_snapshot(_read_json(path))
            for path in self.root.glob("*/snapshot.json")
        ]
        if owner_employee_id is not None:
            teams = [
                team
                for team in teams
                if team.get("ownerEmployeeId") == owner_employee_id
            ]
        if not include_deleted:
            teams = [team for team in teams if not team.get("deletedAt")]
        return sorted(
            teams,
            key=lambda team: (
                team.get("ownerEmployeeId") or "",
                team.get("name", "").casefold(),
                team["id"],
            ),
        )

    def update_team(self, team_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._active_team(team_id)
            normalized = _normalize_team_patch(patch, current=current)
            if "name" in normalized:
                self._ensure_unique_name(
                    current["ownerEmployeeId"],
                    normalized["name"],
                    exclude_id=team_id,
                )
            updated = {**current, **normalized, "updatedAt": now_iso()}
            self._append(
                team_id,
                "team.updated",
                {"patch": normalized, "team": updated},
            )
            return updated

    def delete_team(self, team_id: str) -> dict[str, Any]:
        with self._lock:
            current = self._active_team(team_id)
            timestamp = now_iso()
            deleted = {
                **current,
                "enabled": False,
                "deletedAt": timestamp,
                "updatedAt": timestamp,
            }
            self._append(team_id, "team.deleted", {"team": deleted})
            return deleted

    def remove_member(self, team_id: str, agent_id: str) -> dict[str, Any]:
        with self._lock:
            current = self._active_team(team_id)
            members = [
                member for member in current.get("memberAgentIds", []) if member != agent_id
            ]
            if members == current.get("memberAgentIds", []):
                return current
            lead = current.get("leadAgentId")
            if lead == agent_id:
                lead = members[0] if members else None
            updated = {
                **current,
                "memberAgentIds": members,
                "leadAgentId": lead,
                "updatedAt": now_iso(),
            }
            self._append(
                team_id,
                "team.updated",
                {
                    "patch": {
                        "memberAgentIds": members,
                        "leadAgentId": lead,
                    },
                    "team": updated,
                },
            )
            return updated

    def events(self, team_id: str) -> list[dict[str, Any]]:
        return _read_jsonl(self._events_path(team_id))

    def _active_team(self, team_id: str) -> dict[str, Any]:
        team = self.get_team(team_id)
        if not team or team.get("deletedAt"):
            raise KeyError(team_id)
        return team

    def _ensure_unique_name(
        self,
        owner_employee_id: str,
        name: str,
        *,
        exclude_id: str | None = None,
    ) -> None:
        if any(
            team["id"] != exclude_id
            and team.get("name", "").casefold() == name.casefold()
            for team in self.list_teams(owner_employee_id)
        ):
            raise TeamValidationError("team_name_taken")

    def _append(self, team_id: str, event_type: str, payload: dict[str, Any]) -> None:
        event = _team_event(team_id, event_type, payload)
        _append_jsonl(self._events_path(team_id), event)
        _write_json(self._snapshot_path(team_id), payload["team"])

    def _events_path(self, team_id: str) -> Path:
        return self.root / safe_name(team_id) / "events.jsonl"

    def _snapshot_path(self, team_id: str) -> Path:
        return self.root / safe_name(team_id) / "snapshot.json"


class DatabaseTeamStore:
    metadata = shared_metadata
    teams = Table(
        "teams",
        metadata,
        database_id_column(),
        Column(
            "owner_employee_id",
            entity_uuid_type(),
            ForeignKey(
                "employees.id",
                ondelete="RESTRICT",
                name="fk_teams_owner_employee",
            ),
            nullable=False,
            index=True,
        ),
        Column("name", Text, nullable=False),
        Column("name_key", Text, nullable=True),
        Column("lead_agent_id", entity_uuid_type(), nullable=True),
        Column("member_agent_ids", json_type(), nullable=False),
        Column("enabled", Boolean, nullable=False),
        Column("snapshot", json_type(), nullable=False),
        Column("event_version", BigInteger, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("deleted_at", DateTime(timezone=True), nullable=True),
        # Uniqueness applies to an owner's *live* teams; see agent_store for
        # why the casefolded key column is kept rather than an expression index.
        Index(
            "uq_teams_live_owner_name",
            "owner_employee_id",
            "name_key",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )
    events_table = Table(
        "team_events",
        metadata,
        database_id_column(),
        Column(
            "team_id",
            entity_uuid_type(),
            ForeignKey("teams.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("sequence", BigInteger, nullable=False),
        Column("type", Text, nullable=False),
        Column("timestamp", DateTime(timezone=True), nullable=False),
        Column("payload", json_type(), nullable=False),
        UniqueConstraint("team_id", "sequence", name="uq_team_events_sequence"),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def create_team(
        self, owner_employee_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        team = _new_team(owner_employee_id, payload)
        self._ensure_unique_name(team["ownerEmployeeId"], team["name"])
        event = _team_event(team["id"], "team.created", {"team": team})
        row = _team_row(team, event_version=1)
        try:
            with store_transaction(self.engine) as conn:
                conn.execute(insert(self.teams).values(**row))
                conn.execute(
                    insert(self.events_table).values(
                        **_team_event_row(row["id"], 0, event)
                    )
                )
        except IntegrityError as error:
            if _is_name_conflict(error):
                raise TeamValidationError("team_name_taken") from error
            raise
        return team

    def get_team(self, team_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.teams.c.snapshot,
                        self.teams.c.owner_employee_id,
                    ).where(self.teams.c.id == team_id)
                )
                .mappings()
                .first()
            )
        return (
            _normalized_team_snapshot(
                row["snapshot"], row["owner_employee_id"]
            )
            if row
            else None
        )

    def list_teams(
        self,
        owner_employee_id: str | None = None,
        *,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        statement = select(
            self.teams.c.snapshot,
            self.teams.c.owner_employee_id,
        )
        if owner_employee_id is not None:
            statement = statement.where(
                self.teams.c.owner_employee_id
                == owner_employee_id
            )
        if not include_deleted:
            statement = statement.where(self.teams.c.deleted_at.is_(None))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        teams = [
            _normalized_team_snapshot(
                row["snapshot"], row["owner_employee_id"]
            )
            for row in rows
        ]
        return sorted(
            teams,
            key=lambda team: (
                team.get("ownerEmployeeId") or "",
                team.get("name", "").casefold(),
                team["id"],
            ),
        )

    def update_team(self, team_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        def update_snapshot(
            current: dict[str, Any],
        ) -> tuple[dict[str, Any], dict[str, Any]]:
            normalized = _normalize_team_patch(patch, current=current)
            updated = {**current, **normalized, "updatedAt": now_iso()}
            return updated, {"patch": normalized, "team": updated}

        return self._mutate(team_id, "team.updated", update_snapshot)

    def delete_team(self, team_id: str) -> dict[str, Any]:
        def delete_snapshot(
            current: dict[str, Any],
        ) -> tuple[dict[str, Any], dict[str, Any]]:
            timestamp = now_iso()
            deleted = {
                **current,
                "enabled": False,
                "deletedAt": timestamp,
                "updatedAt": timestamp,
            }
            return deleted, {"team": deleted}

        return self._mutate(team_id, "team.deleted", delete_snapshot)

    def remove_member(self, team_id: str, agent_id: str) -> dict[str, Any]:
        def remove_from_snapshot(
            current: dict[str, Any],
        ) -> tuple[dict[str, Any], dict[str, Any]] | None:
            members = [
                member
                for member in current.get("memberAgentIds", [])
                if member != agent_id
            ]
            if members == current.get("memberAgentIds", []):
                return None
            lead = current.get("leadAgentId")
            if lead == agent_id:
                lead = members[0] if members else None
            updated = {
                **current,
                "memberAgentIds": members,
                "leadAgentId": lead,
                "updatedAt": now_iso(),
            }
            return updated, {
                "patch": {"memberAgentIds": members, "leadAgentId": lead},
                "team": updated,
            }

        return self._mutate(team_id, "team.updated", remove_from_snapshot)

    def events(self, team_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(
                        self.events_table.c.id,
                        self.events_table.c.type,
                        self.events_table.c.timestamp,
                        self.events_table.c.payload,
                    )
                    .join(self.teams, self.events_table.c.team_id == self.teams.c.id)
                    .where(self.teams.c.id == team_id)
                    .order_by(self.events_table.c.sequence)
                )
                .mappings()
                .all()
            )
        if not rows and not self.get_team(team_id):
            raise KeyError(team_id)
        return [
            {
                "id": str(row["id"]),
                "type": row["type"],
                "teamId": team_id,
                "timestamp": _format_iso(row["timestamp"]),
                **row["payload"],
            }
            for row in rows
        ]

    def _active_team(self, team_id: str) -> dict[str, Any]:
        team = self.get_team(team_id)
        if not team or team.get("deletedAt"):
            raise KeyError(team_id)
        return team

    def _mutate(
        self,
        team_id: str,
        event_type: str,
        mutate: Callable[
            [dict[str, Any]],
            tuple[dict[str, Any], dict[str, Any]] | None,
        ],
    ) -> dict[str, Any]:
        for attempt in range(3):
            try:
                with store_transaction(self.engine) as conn:
                    row = (
                        conn.execute(
                            select(
                                self.teams.c.id,
                                self.teams.c.snapshot,
                                self.teams.c.owner_employee_id,
                                self.teams.c.event_version,
                            )
                            .where(self.teams.c.id == team_id)
                            .with_for_update()
                        )
                        .mappings()
                        .first()
                    )
                    if not row:
                        raise KeyError(team_id)
                    current = _normalized_team_snapshot(
                        row["snapshot"] or {}, row["owner_employee_id"]
                    )
                    if current.get("deletedAt"):
                        raise KeyError(team_id)
                    mutation = mutate(current)
                    if mutation is None:
                        return current
                    team, payload = mutation
                    sequence = int(row["event_version"] or 0)
                    claimed = conn.execute(
                        update(self.teams)
                        .where(
                            self.teams.c.id == row["id"],
                            self.teams.c.event_version == sequence,
                        )
                        .values(
                            **_team_row(
                                team,
                                event_version=sequence + 1,
                                database_id=row["id"],
                            )
                        )
                    )
                    if claimed.rowcount != 1:
                        raise _TeamWriteConflict(team_id)
                    event = _team_event(team_id, event_type, payload)
                    conn.execute(
                        insert(self.events_table).values(
                            **_team_event_row(row["id"], sequence, event)
                        )
                    )
                return team
            except _TeamWriteConflict:
                if attempt == 2:
                    raise
            except IntegrityError as error:
                if _is_name_conflict(error):
                    raise TeamValidationError("team_name_taken") from error
                raise
        raise _TeamWriteConflict(team_id)

    def _ensure_unique_name(
        self,
        owner_employee_id: str,
        name: str,
        *,
        exclude_id: str | None = None,
    ) -> None:
        if any(
            team["id"] != exclude_id
            and team.get("name", "").casefold() == name.casefold()
            for team in self.list_teams(owner_employee_id)
        ):
            raise TeamValidationError("team_name_taken")


def _new_team(
    owner_employee_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    owner_employee_id = owner_employee_id.strip()
    if not owner_employee_id:
        raise ValueError("ownerEmployeeId is required.")
    name = _required_name(payload.get("name"))
    members = payload.get("memberAgentIds")
    lead = payload.get("leadAgentId")
    if not isinstance(members, list) or not members:
        raise TeamValidationError("team_members_required")
    if len(set(members)) != len(members):
        raise TeamValidationError("team_members_duplicate")
    if not isinstance(lead, str) or lead not in members:
        raise TeamValidationError("team_lead_not_member")
    team_id = new_database_id()
    profile_image_url = validate_profile_image_url(
        "teams", team_id, payload.get("profileImageUrl")
    )
    timestamp = now_iso()
    return {
        "id": team_id,
        "ownerEmployeeId": owner_employee_id,
        "name": name,
        **({"profileImageUrl": profile_image_url} if profile_image_url else {}),
        "leadAgentId": lead,
        "memberAgentIds": list(members),
        "enabled": payload.get("enabled") is not False,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


def _normalized_team_snapshot(
    team: dict[str, Any], owner_employee_id: str | None = None
) -> dict[str, Any]:
    """Map pre-owner terminology onto the current team contract on read."""
    owner = (
        team.get("ownerEmployeeId")
        or team.get("supervisorEmployeeId")
        or team.get("employeeId")
        or owner_employee_id
    )
    normalized = {
        key: value
        for key, value in team.items()
        if key not in {"supervisorEmployeeId", "employeeId"}
    }
    return {**normalized, "ownerEmployeeId": owner} if owner else normalized


def _normalize_team_patch(
    patch: dict[str, Any], *, current: dict[str, Any]
) -> dict[str, Any]:
    allowed = {"name", "profileImageUrl", "leadAgentId", "memberAgentIds", "enabled"}
    unknown = set(patch) - allowed
    if unknown:
        raise ValueError(f"Unsupported team field(s): {', '.join(sorted(unknown))}.")
    normalized: dict[str, Any] = {}
    if "name" in patch:
        normalized["name"] = _required_name(patch["name"])
    if "profileImageUrl" in patch:
        normalized["profileImageUrl"] = validate_profile_image_url(
            "teams", current["id"], patch["profileImageUrl"]
        )
    if "memberAgentIds" in patch:
        members = patch["memberAgentIds"]
        if not isinstance(members, list) or not members:
            raise TeamValidationError("team_members_required")
        if any(not isinstance(item, str) or not item.strip() for item in members):
            raise TeamValidationError("team_member_not_found")
        members = [item.strip() for item in members]
        if len(set(members)) != len(members):
            raise TeamValidationError("team_members_duplicate")
        normalized["memberAgentIds"] = members
    if "leadAgentId" in patch:
        lead = patch["leadAgentId"]
        if not isinstance(lead, str) or not lead.strip():
            raise TeamValidationError("team_lead_not_member")
        normalized["leadAgentId"] = lead.strip()
    members = normalized.get("memberAgentIds", current.get("memberAgentIds", []))
    lead = normalized.get("leadAgentId", current.get("leadAgentId"))
    if lead not in members:
        raise TeamValidationError("team_lead_not_member")
    if "enabled" in patch:
        if not isinstance(patch["enabled"], bool):
            raise ValueError("enabled must be a boolean.")
        normalized["enabled"] = patch["enabled"]
    return normalized


def _required_name(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("name is required.")
    return value.strip()


def _is_name_conflict(error: IntegrityError) -> bool:
    message = str(error).lower()
    return "uq_teams_owner_name_key" in message or "name_key" in message


def _team_event(
    team_id: str, event_type: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "teamId": team_id,
        "timestamp": now_iso(),
        **payload,
    }


def _team_row(
    team: dict[str, Any], *, event_version: int, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or team["id"],
        "owner_employee_id": team["ownerEmployeeId"],
        "name": team["name"],
        "name_key": team["name"].casefold(),
        "lead_agent_id": team.get("leadAgentId"),
        "member_agent_ids": team.get("memberAgentIds", []),
        "enabled": team.get("enabled", True),
        "snapshot": team,
        "event_version": event_version,
        "created_at": _parse_iso(team["createdAt"]),
        "updated_at": _parse_iso(team["updatedAt"]),
        "deleted_at": _parse_iso(team.get("deletedAt")),
    }


def _team_event_row(
    team_database_id: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": event["id"],
        "team_id": team_database_id,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": _parse_iso(event["timestamp"]),
        "payload": {
            key: value
            for key, value in event.items()
            if key not in {"id", "type", "teamId", "timestamp"}
        },
    }
