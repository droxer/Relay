from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy import (
    insert,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError

from ..collaboration.contracts import member_configs, text_list
from ..collaboration.styles import validate_collaboration_style
from ..core.ids import new_database_id, now_iso
from ..core.preset_avatars import validate_profile_image_url
from .store_common import (
    _format_iso,
    _parse_iso,
    create_all_tables,
    shared_engine,
    store_transaction,
)
from .sql import metadata as shared_metadata
from .tables import teams as teams_tables


class TeamValidationError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


class _TeamWriteConflict(RuntimeError):
    pass


def validate_team_payload(
    owner_user_id: str,
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
        if agent.get("supervisorUserId") != owner_user_id:
            raise TeamValidationError("team_member_wrong_supervisor")
    return lead, normalized


class DatabaseTeamStore:
    metadata = shared_metadata
    teams = teams_tables.teams
    events_table = teams_tables.events_table

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def create_team(
        self, owner_user_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        team = _new_team(owner_user_id, payload)
        self._ensure_unique_name(team["ownerUserId"], team["name"])
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
                        self.teams.c.owner_user_id,
                    ).where(self.teams.c.id == team_id)
                )
                .mappings()
                .first()
            )
        return (
            _normalized_team_snapshot(
                row["snapshot"], row["owner_user_id"]
            )
            if row
            else None
        )

    def list_teams(
        self,
        owner_user_id: str | None = None,
        *,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        statement = select(
            self.teams.c.snapshot,
            self.teams.c.owner_user_id,
        )
        if owner_user_id is not None:
            statement = statement.where(
                self.teams.c.owner_user_id
                == owner_user_id
            )
        if not include_deleted:
            statement = statement.where(self.teams.c.deleted_at.is_(None))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        teams = [
            _normalized_team_snapshot(
                row["snapshot"], row["owner_user_id"]
            )
            for row in rows
        ]
        return sorted(
            teams,
            key=lambda team: (
                team.get("ownerUserId") or "",
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
            if updated.get("collaborationStyle") is None:
                updated = {key: value for key, value in updated.items() if key != "collaborationStyle"}
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
            updated, patch = _without_member(current, members, agent_id)
            return updated, {"patch": patch, "team": updated}

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
                                self.teams.c.owner_user_id,
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
                        row["snapshot"] or {}, row["owner_user_id"]
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
        owner_user_id: str,
        name: str,
        *,
        exclude_id: str | None = None,
    ) -> None:
        if any(
            team["id"] != exclude_id
            and team.get("name", "").casefold() == name.casefold()
            for team in self.list_teams(owner_user_id)
        ):
            raise TeamValidationError("team_name_taken")


def _without_member(
    current: dict[str, Any], members: list[str], agent_id: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The team after `agent_id` leaves, and the patch that records it.

    A departing lead hands the lead to the first remaining member. A team left
    with nobody on it cannot run, so it is disabled rather than left enabled
    with no lead; it stays editable and can be restaffed.
    """
    lead = current.get("leadAgentId")
    if lead == agent_id:
        lead = members[0] if members else None
    patch: dict[str, Any] = {
        "memberAgentIds": members,
        "leadAgentId": lead,
        **({} if members else {"enabled": False}),
    }
    updated = {
        **current,
        **patch,
        "memberConfigs": {
            key: value
            for key, value in current.get("memberConfigs", {}).items()
            if key in members
        },
        "updatedAt": now_iso(),
    }
    return updated, patch


def _new_team(
    owner_user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    owner_user_id = owner_user_id.strip()
    if not owner_user_id:
        raise ValueError("ownerUserId is required.")
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
        "ownerUserId": owner_user_id,
        "name": name,
        **({"profileImageUrl": profile_image_url} if profile_image_url else {}),
        "leadAgentId": lead,
        "memberAgentIds": list(members),
        **(
            {"computerId": payload["computerId"]}
            if isinstance(payload.get("computerId"), str) and payload["computerId"]
            else {}
        ),
        "memberConfigs": member_configs(payload.get("memberConfigs", {}), members),
        "acceptanceCriteria": text_list(payload.get("acceptanceCriteria", []), "acceptanceCriteria"),
        **(
            {"collaborationStyle": validate_collaboration_style(payload["collaborationStyle"])}
            if payload.get("collaborationStyle") is not None
            else {}
        ),
        "enabled": payload.get("enabled") is not False,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


def _normalized_team_snapshot(
    team: dict[str, Any], owner_user_id: str | None = None
) -> dict[str, Any]:
    """Map pre-owner terminology onto the current team contract on read."""
    owner = (
        team.get("ownerUserId")
        or team.get("supervisorUserId")
        or team.get("userId")
        or owner_user_id
    )
    normalized = {
        key: value
        for key, value in team.items()
        if key not in {"supervisorUserId", "userId"}
    }
    return {**normalized, "ownerUserId": owner} if owner else normalized


def _normalize_team_patch(
    patch: dict[str, Any], *, current: dict[str, Any]
) -> dict[str, Any]:
    allowed = {"name", "profileImageUrl", "leadAgentId", "memberAgentIds", "computerId", "enabled", "memberConfigs", "acceptanceCriteria", "collaborationStyle"}
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
    if "computerId" in patch:
        computer = patch["computerId"]
        if not isinstance(computer, str) or not computer.strip():
            raise TeamValidationError("team_computer_required")
        normalized["computerId"] = computer.strip()
    if "leadAgentId" in patch:
        lead = patch["leadAgentId"]
        if not isinstance(lead, str) or not lead.strip():
            raise TeamValidationError("team_lead_not_member")
        normalized["leadAgentId"] = lead.strip()
    members = normalized.get("memberAgentIds", current.get("memberAgentIds", []))
    lead = normalized.get("leadAgentId", current.get("leadAgentId"))
    if "memberConfigs" in patch or "memberAgentIds" in patch:
        configs = patch.get("memberConfigs", {key: value for key, value in current.get("memberConfigs", {}).items() if key in members})
        normalized["memberConfigs"] = member_configs(configs, members)
    if "acceptanceCriteria" in patch:
        normalized["acceptanceCriteria"] = text_list(patch["acceptanceCriteria"], "acceptanceCriteria")
    if "collaborationStyle" in patch:
        value = patch["collaborationStyle"]
        normalized["collaborationStyle"] = (
            None if value is None else validate_collaboration_style(value)
        )
    # An emptied team has no lead; edits that leave the roster alone (a rename,
    # a style change) stay valid until it is restaffed.
    if (members or "leadAgentId" in patch) and lead not in members:
        raise TeamValidationError("team_lead_not_member")
    if "enabled" in patch:
        if not isinstance(patch["enabled"], bool):
            raise ValueError("enabled must be a boolean.")
        if patch["enabled"] and not members:
            raise TeamValidationError("team_members_required")
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
        "owner_user_id": team["ownerUserId"],
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
