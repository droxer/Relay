from __future__ import annotations

from contextlib import ExitStack
from collections.abc import Callable
from typing import Any

from sqlalchemy import (
    insert,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError

from ...collaboration.contracts import apply_member_config_patch, member_configs, text_list
from ...collaboration.styles import validate_collaboration_style
from ...core.team_workflows import is_workflow_team, workflow_fields
from ...core.ids import new_database_id, now_iso
from ...core.preset_avatars import validate_profile_image_url
from ..workflow.store import DatabaseWorkflowStore
from ..resource_lock import resource_transaction
from ..db_time import format_db_time, parse_db_time
from ..engine import create_all_tables, shared_engine, store_transaction
from ..sql import metadata as shared_metadata, names_no_uuid_row
from ..tables import teams as teams_tables
from ...core.workflows import team_workflows, workflow_definition, validate_default_workflow
from ...core.workflow_selection import workflow_id_for_style


TEAM_FIELDS = frozenset({
    "name", "profileImageUrl", "leadAgentId", "memberAgentIds", "computerId", "enabled",
    "memberConfigs", "acceptanceCriteria", "collaborationStyle", "humanApproval",
    "projectId", "workflowSteps", "defaultWorkflowId", "projectWorkflowDefaults",
})


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
        self.workflow_store = DatabaseWorkflowStore(database_url)
        self.workflow_store.migrate_legacy()

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
                self.workflow_store.import_team(team)
        except IntegrityError as error:
            if _is_name_conflict(error):
                raise TeamValidationError("team_name_taken") from error
            raise
        return self.get_team(team["id"]) or team

    def get_team(self, team_id: str) -> dict[str, Any] | None:
        if names_no_uuid_row(self.engine, team_id):
            return None
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.teams.c.snapshot,
                        self.teams.c.owner_user_id,
                        self.teams.c.event_version,
                    ).where(self.teams.c.id == team_id)
                )
                .mappings()
                .first()
            )
        return (
            self._workflow_view({
                **_normalized_team_snapshot(row["snapshot"], row["owner_user_id"]),
                "version": int(row["event_version"] or 0),
            })
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
            self.teams.c.event_version,
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
            {
                **_normalized_team_snapshot(row["snapshot"], row["owner_user_id"]),
                "version": int(row["event_version"] or 0),
            }
            for row in rows
        ]
        definitions = self.workflow_store.for_teams([team["id"] for team in teams])
        teams = [{**team, "workflows": definitions.get(team["id"], [])} for team in teams]
        return sorted(
            teams,
            key=lambda team: (
                team.get("ownerUserId") or "",
                team.get("name", "").casefold(),
                team["id"],
            ),
        )

    def update_member_config(
        self, team_id: str, agent_id: str, fields: dict[str, Any], *, default_role: str | None,
    ) -> dict[str, Any]:
        applied: dict[str, Any] = {}

        def update_snapshot(current: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            nonlocal applied
            if agent_id not in current["memberAgentIds"]:
                raise TeamValidationError("team_member_not_found")
            configs = current.get("memberConfigs") or {}
            previous = configs.get(agent_id, {})
            saved = apply_member_config_patch(agent_id, previous, fields, default_role)
            applied = {
                key: saved.get(key) for key in sorted(previous.keys() | saved.keys())
                if previous.get(key) != saved.get(key)
            }
            patch = {"memberConfigs": {**configs, agent_id: saved}}
            updated = {**current, **patch, "updatedAt": now_iso()}
            return updated, {"patch": patch, "team": updated}

        team = self._mutate(team_id, "team.updated", update_snapshot)
        return {
            "teamId": team_id, "agentId": agent_id, "baseVersion": team["version"] - 1,
            "version": team["version"], "updatedAt": team["updatedAt"], "fields": applied,
        }

    def update_team(self, team_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        def update_snapshot(
            current: dict[str, Any],
        ) -> tuple[dict[str, Any], dict[str, Any]]:
            normalized = _normalize_team_patch(patch, current=current)
            updated = {**current, **normalized, "updatedAt": now_iso()}
            if {'projectId', 'workflowSteps'} & patch.keys() and is_workflow_team(updated):
                legacy = self.workflow_store.get_workflow(team_id)
                if legacy:
                    self.workflow_store.save_workflow(current['ownerUserId'], {
                        'projectId': updated['projectId'], 'workflowSteps': updated['workflowSteps'],
                    }, workflow_id=team_id)
                else:
                    self.workflow_store.import_team({key: value for key, value in updated.items()
                                                     if key not in {'workflows', 'workflowStorageVersion'}})
                updated['workflowStorageVersion'] = 1
                updated = self._workflow_view(updated)
            if "defaultWorkflowId" in patch and is_workflow_team(current):
                updated["workflows"] = team_workflows(current)
                updated.pop("projectId", None)
                updated.pop("workflowSteps", None)
            if updated.get("collaborationStyle") is None:
                updated = {key: value for key, value in updated.items() if key != "collaborationStyle"}
            return updated, {"patch": normalized, "team": updated}

        ids = list((patch.get('projectWorkflowDefaults') or {}).values()) if isinstance(patch.get('projectWorkflowDefaults'), dict) else []
        if isinstance(patch.get('defaultWorkflowId'), str) and not patch['defaultWorkflowId'].startswith('preset:'):
            ids.append(patch['defaultWorkflowId'])
        scopes = {definition.get('projectId') or definition.get('ownerTeamId') for workflow_id in ids
                  if (definition := self.workflow_store.get_workflow(workflow_id))}
        if {'projectId', 'workflowSteps'} & patch.keys():
            scope = patch.get('projectId') or (self.get_team(team_id) or {}).get('projectId')
            if scope:
                scopes.add(scope)
        with ExitStack() as locks:
            for scope in sorted(scope for scope in scopes if scope):
                locks.enter_context(resource_transaction(self.engine, f'workflows:{scope}'))
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

    def set_project_workflow_default(self, team_id: str, project_id: str, workflow_id: str | None) -> dict[str, Any]:
        """Change one scope against the current version, preserving other scopes."""
        def update_default(current: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            defaults = dict(current.get('projectWorkflowDefaults', {}))
            if workflow_id is None:
                defaults.pop(project_id, None)
            else:
                defaults[project_id] = workflow_id
            patch: dict[str, Any] = {'projectWorkflowDefaults': defaults}
            legacy_id = current.get('defaultWorkflowId') or (current['id'] if current.get('workflowSteps') else None)
            if workflow_id is None and any(item['id'] == legacy_id and item['projectId'] == project_id
                                           for item in current.get('workflows', [])):
                patch['defaultWorkflowId'] = workflow_id_for_style(current.get('collaborationStyle'))
            # A stale default in another scope must not prevent this scope's
            # repair. Validate only the selection being changed.
            normalized = _normalize_team_patch({**patch, 'projectWorkflowDefaults': {
                project_id: workflow_id,
            } if workflow_id else {}}, current=current)
            if len(defaults) > 256:
                raise ValueError('workflow_defaults_invalid')
            normalized['projectWorkflowDefaults'] = defaults
            updated = {**current, **normalized, 'updatedAt': now_iso()}
            if 'defaultWorkflowId' in patch and is_workflow_team(current):
                updated.pop('projectId', None)
                updated.pop('workflowSteps', None)
            return updated, {'patch': normalized, 'team': updated}

        scopes = {project_id}
        definition = self.workflow_store.get_workflow(workflow_id) if workflow_id else None
        if definition and definition.get('ownerTeamId'):
            scopes.add(definition['ownerTeamId'])
        with ExitStack() as locks:
            for scope in sorted(scopes):
                locks.enter_context(resource_transaction(self.engine, f'workflows:{scope}'))
            return self._mutate(team_id, 'team.updated', update_default)

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

    def _workflow_view(self, team: dict[str, Any]) -> dict[str, Any]:
        definitions = self.workflow_store.list_workflows(team_id=team['id'])
        legacy = next((item for item in definitions if item['id'] == team['id']), None)
        if legacy and 'workflowSteps' in team:
            team = {**team, 'workflowSteps': legacy['workflowSteps'], 'projectId': legacy['projectId']}
        return {**team, 'workflows': [{**definition, 'teamId': team['id']} for definition in definitions]}

    def save_workflow(self, team_id: str, payload: dict[str, Any], *, workflow_id: str | None = None) -> dict[str, Any]:
        with store_transaction(self.engine):
            team = self._active_team(team_id)
            if workflow_id and workflow_id not in {item['id'] for item in team['workflows']}:
                raise KeyError(workflow_id)
            # Preserve the historical Team-side validation contract.
            workflow_definition(team, payload, current=next((item for item in team['workflows'] if item['id'] == workflow_id), None))
            definition = self.workflow_store.save_workflow(team['ownerUserId'], payload, workflow_id=workflow_id)
            self.workflow_store.link(team_id, definition['id'])
            self._mutate(team_id, 'team.workflow_updated' if workflow_id else 'team.workflow_created',
                         lambda current: (current, {'workflow': {**definition, 'teamId': team_id}, 'team': current}))
            return {**definition, 'teamId': team_id}

    def delete_workflow(self, team_id: str, workflow_id: str) -> dict[str, Any]:
        with store_transaction(self.engine):
            team = self._active_team(team_id)
            if workflow_id not in {item['id'] for item in team['workflows']}:
                raise KeyError(workflow_id)
            self.workflow_store.delete_workflow(workflow_id)
            self._mutate(team_id, 'team.workflow_deleted', lambda current: (current, {'workflowId': workflow_id, 'team': current}))
            return self._workflow_view(team)

    def link_workflow(self, team_id: str, workflow_id: str, *, linked: bool = True) -> dict[str, Any]:
        definition = self.workflow_store.get_workflow(workflow_id)
        if not definition:
            raise ValueError('workflow_not_found')
        with resource_transaction(self.engine, f"workflows:{definition.get('projectId') or definition.get('ownerTeamId')}"):
            if not self.workflow_store.get_workflow(workflow_id):
                raise ValueError('workflow_not_found')
            current = self._active_team(team_id)
            if definition.get('ownerTeamId') and definition['ownerTeamId'] != team_id:
                raise ValueError('workflow_team_required')
            if definition['ownerUserId'] != current['ownerUserId']:
                raise ValueError('workflow_owner_required')
            if linked:
                self.workflow_store.link(team_id, workflow_id)
            else:
                self.workflow_store.unlink(team_id, workflow_id)
            return self._mutate(team_id, 'team.workflow_linked' if linked else 'team.workflow_unlinked',
                                lambda team: (team, {'workflowId': workflow_id, 'team': team}))

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
                "timestamp": format_db_time(row["timestamp"]),
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
                    current = self._workflow_view(_normalized_team_snapshot(
                        row["snapshot"] or {}, row["owner_user_id"]
                    ))
                    if current.get("deletedAt"):
                        raise KeyError(team_id)
                    sequence = int(row["event_version"] or 0)
                    mutation = mutate(current)
                    if mutation is None:
                        return {**current, "version": sequence}
                    team, payload = mutation
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
                return {**team, "version": sequence + 1}
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
    if is_workflow_team(payload) and set(payload) - TEAM_FIELDS:
        raise ValueError("Unsupported workflow Team fields.")
    owner_user_id = owner_user_id.strip()
    if not owner_user_id:
        raise ValueError("ownerUserId is required.")
    name = _required_name(payload.get("name"))
    members = payload.get("memberAgentIds")
    lead = payload.get("leadAgentId")
    if not isinstance(members, list) or not members or any(
        not isinstance(member, str) or not member.strip() for member in members
    ):
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
    team = {
        **workflow_fields(payload),
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
        **({"humanApproval": True} if _human_approval(payload.get("humanApproval")) else {}),
        "enabled": payload.get("enabled") is not False,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }

    if "defaultWorkflowId" in payload:
        team["defaultWorkflowId"] = validate_default_workflow(team, payload["defaultWorkflowId"])
    return team


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


def _human_approval(value: Any) -> bool:
    """Whether the team's person approves the work before its round's final
    step (ADR-023). Absent means no."""
    if value is None:
        return False
    if not isinstance(value, bool):
        raise ValueError("humanApproval must be a boolean.")
    return value


def _normalize_team_patch(
    patch: dict[str, Any], *, current: dict[str, Any]
) -> dict[str, Any]:
    unknown = set(patch) - TEAM_FIELDS
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
    if "humanApproval" in patch:
        normalized["humanApproval"] = _human_approval(patch["humanApproval"])
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
    if 'projectWorkflowDefaults' in patch:
        defaults = patch['projectWorkflowDefaults']
        if not isinstance(defaults, dict) or len(defaults) > 256:
            raise ValueError('workflow_defaults_invalid')
        for project_id, workflow_id in defaults.items():
            definition = next((item for item in team_workflows(current) if item['id'] == workflow_id), None)
            if not definition or definition.get('projectId') not in (None, project_id) or not definition['enabled']:
                raise ValueError('workflow_defaults_invalid')
            validate_default_workflow({**current, **normalized}, workflow_id)
        normalized['projectWorkflowDefaults'] = dict(defaults)
    if "defaultWorkflowId" in patch:
        normalized["defaultWorkflowId"] = validate_default_workflow({**current, **normalized}, patch["defaultWorkflowId"])
        if "collaborationStyle" in patch and patch["collaborationStyle"] is not None and normalized["defaultWorkflowId"] != workflow_id_for_style(patch["collaborationStyle"]):
            raise ValueError("workflow_selection_conflict")
    elif "collaborationStyle" in patch:
        normalized["defaultWorkflowId"] = workflow_id_for_style(patch["collaborationStyle"])
    workflow = workflow_fields({**patch, **normalized}, current=current)
    if workflow:
        normalized.update(workflow)
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
        "snapshot": {key: value for key, value in team.items() if key != "workflows"},
        "event_version": event_version,
        "created_at": parse_db_time(team["createdAt"]),
        "updated_at": parse_db_time(team["updatedAt"]),
        "deleted_at": parse_db_time(team.get("deletedAt")),
    }


def _team_event_row(
    team_database_id: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": event["id"],
        "team_id": team_database_id,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": parse_db_time(event["timestamp"]),
        "payload": {
            key: value
            for key, value in event.items()
            if key not in {"id", "type", "teamId", "timestamp"}
        },
    }
