"""Workflow aggregate independent of optional Team references."""
from collections.abc import Collection
from copy import deepcopy
from typing import Any

from sqlalchemy import delete, insert, select, update
from sqlalchemy.exc import IntegrityError

from ...core.ids import new_database_id, now_iso
from ...core.workflows import project_workflow_definition, team_workflows
from ..db_time import parse_db_time
from ..engine import shared_engine, store_transaction
from ..resource_lock import resource_transaction
from ..sql import names_no_uuid_row
from ..tables.workflows import workflows, links, events
from ..tables.teams import teams
from .migration import migrate_team_workflows


class DatabaseWorkflowStore:
    def __init__(self, database_url: str):
        self.engine = shared_engine(database_url)

    def get_workflow(self, workflow_id: str, *, include_deleted: bool = False) -> dict[str, Any] | None:
        if names_no_uuid_row(self.engine, workflow_id):
            return None
        statement = select(workflows.c.snapshot, workflows.c.event_version).where(workflows.c.id == workflow_id)
        if not include_deleted:
            statement = statement.where(workflows.c.deleted_at.is_(None))
        with store_transaction(self.engine) as conn:
            row = conn.execute(statement).one_or_none()
        return {**deepcopy(row.snapshot), 'version': row.event_version} if row else None

    def list_workflows(self, owner: str | None = None, *, project_id: str | None = None,
                       team_id: str | None = None, project_only: bool = False,
                       standalone_only: bool = False,
                       project_ids: Collection[str] | None = None) -> list[dict[str, Any]]:
        statement = select(workflows.c.snapshot, workflows.c.event_version).where(workflows.c.deleted_at.is_(None))
        if owner:
            statement = statement.where(workflows.c.owner_user_id == owner)
        if standalone_only:
            statement = statement.where(workflows.c.computer_id.is_not(None))
        if project_id:
            if names_no_uuid_row(self.engine, project_id):
                return []
            statement = statement.where(workflows.c.project_id == project_id)
        elif project_only:
            statement = statement.where(workflows.c.project_id.is_not(None))
        if project_ids is not None:
            if not project_ids:
                return []
            statement = statement.where(workflows.c.project_id.in_(project_ids))
        if team_id:
            statement = statement.join(links, links.c.workflow_id == workflows.c.id).where(links.c.team_id == team_id)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).all()
        values = [{**deepcopy(row.snapshot), 'version': row.event_version} for row in rows]
        return sorted(values, key=lambda value: (value['name'].casefold(), value['id']))

    def for_teams(self, team_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
        if not team_ids:
            return {}
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(links.c.team_id, workflows.c.snapshot, workflows.c.event_version).join(
                workflows, workflows.c.id == links.c.workflow_id,
            ).where(links.c.team_id.in_(team_ids), workflows.c.deleted_at.is_(None))).all()
        result: dict[str, list[dict[str, Any]]] = {}
        for team_id, snapshot, version in rows:
            result.setdefault(str(team_id), []).append({**deepcopy(snapshot), 'teamId': str(team_id), 'version': version})
        for values in result.values():
            values.sort(key=lambda value: (value['name'].casefold(), value['id']))
        return result

    def save_workflow(
        self, owner: str, payload: dict[str, Any], *, workflow_id: str | None = None, expected_version: int | None = None,
    ) -> dict[str, Any]:
        old = self.get_workflow(workflow_id) if workflow_id else None
        if workflow_id and not old:
            raise KeyError(workflow_id)
        if old and old['ownerUserId'] != owner:
            raise ValueError('workflow_owner_required')
        with resource_transaction(self.engine, self._scope_key(old or payload, owner)):
            current = self.get_workflow(workflow_id) if workflow_id else None
            if workflow_id and not current:
                raise KeyError(workflow_id)
            if expected_version is not None and (not current or current['version'] != expected_version):
                raise ValueError('workflow_version_conflict')
            definition = project_workflow_definition(owner, payload, current=current)
            if not current or current['name'].casefold() != definition['name'].casefold():
                if any(value['id'] != definition['id'] and value['name'].casefold() == definition['name'].casefold()
                       for value in self.list_workflows(owner)
                       if value.get('projectId') == definition.get('projectId') and value.get('ownerTeamId') == definition.get('ownerTeamId')
                       and value.get('computerId') == definition.get('computerId')):
                    raise ValueError('workflow_name_taken')
            if current and current['enabled'] and not definition['enabled']:
                self.assert_not_default(current['id'])
            try:
                with store_transaction(self.engine) as conn:
                    version = 0
                    if current:
                        version = current['version']
                        conn.execute(update(workflows).where(workflows.c.id == workflow_id).values(**self._row(definition, version + 1)))
                    else:
                        conn.execute(insert(workflows).values(**self._row(definition, 1)))
                    self._event(conn, definition, version, 'workflow.updated' if current else 'workflow.created')
            except IntegrityError as error:
                # The only user-controlled unique key is Project + folded name.
                if 'uq_workflows_live_project_name' in str(error) or 'workflows.project_id, workflows.name_key' in str(error):
                    raise ValueError('workflow_name_taken') from error
                raise
            return {**definition, 'version': version + 1}

    def delete_workflow(self, workflow_id: str) -> None:
        current = self.get_workflow(workflow_id)
        if not current:
            raise KeyError(workflow_id)
        with resource_transaction(self.engine, self._scope_key(current, current['ownerUserId'])):
            self.assert_not_default(workflow_id)
            with store_transaction(self.engine) as conn:
                version = conn.execute(select(workflows.c.event_version).where(workflows.c.id == workflow_id)).scalar_one()
                definition = {key: value for key, value in current.items() if key != 'version'}
                definition.update(enabled=False, deletedAt=now_iso(), updatedAt=now_iso())
                conn.execute(update(workflows).where(workflows.c.id == workflow_id).values(**self._row(definition, version + 1)))
                self._event(conn, definition, version, 'workflow.deleted')

    def assert_not_default(self, workflow_id: str) -> None:
        with store_transaction(self.engine) as conn:
            snapshots = conn.execute(select(teams.c.snapshot).join(links, links.c.team_id == teams.c.id).where(teams.c.deleted_at.is_(None), links.c.workflow_id == workflow_id)).scalars().all()
        if any(value.get('defaultWorkflowId') == workflow_id or (value.get('workflowSteps') and value['id'] == workflow_id) or workflow_id in (value.get('projectWorkflowDefaults') or {}).values()
               for value in snapshots):
            raise ValueError('workflow_is_default')

    def link(self, team_id: str, workflow_id: str) -> None:
        with resource_transaction(self.engine, f'workflow-link:{team_id}:{workflow_id}'):
            with store_transaction(self.engine) as conn:
                if conn.execute(select(links.c.workflow_id).where(links.c.team_id == team_id, links.c.workflow_id == workflow_id)).first():
                    return
                conn.execute(insert(links).values(team_id=team_id, workflow_id=workflow_id))

    def unlink(self, team_id: str, workflow_id: str) -> None:
        if (self.get_workflow(workflow_id) or {}).get('ownerTeamId') == team_id:
            raise ValueError('workflow_owner_link_required')
        with store_transaction(self.engine) as conn:
            team = conn.execute(select(teams.c.snapshot).where(teams.c.id == team_id)).scalar_one()
            if team.get('defaultWorkflowId') == workflow_id or (team.get('workflowSteps') and team['id'] == workflow_id) or workflow_id in (team.get('projectWorkflowDefaults') or {}).values():
                raise ValueError('workflow_is_default')
            conn.execute(delete(links).where(links.c.team_id == team_id, links.c.workflow_id == workflow_id))

    def import_team(self, team: dict[str, Any]) -> None:
        """Idempotent compatibility write; migration also extracts old snapshots."""
        if team.get('workflowStorageVersion') == 1:
            return
        with store_transaction(self.engine) as conn:
            for value in team_workflows(team):
                existing = conn.execute(select(workflows.c.id).where(workflows.c.id == value['id'])).first()
                definition = {key: deepcopy(value[key]) for key in ('id', 'name', 'projectId', 'workflowSteps', 'enabled', 'createdAt', 'updatedAt')}
                definition['ownerUserId'] = team['ownerUserId']
                if not existing:
                    conn.execute(insert(workflows).values(**self._row(definition, 1)))
                    self._event(conn, definition, 0, 'workflow.imported')
                self.link(team['id'], value['id'])
            snapshot = {key: value for key, value in team.items() if key != 'workflows'}
            snapshot['workflowStorageVersion'] = 1
            conn.execute(update(teams).where(teams.c.id == team['id']).values(snapshot=snapshot))

    def migrate_legacy(self) -> None:
        with store_transaction(self.engine) as conn:
            migrate_team_workflows(conn)

    @staticmethod
    def _scope_key(value: dict[str, Any], owner: str) -> str:
        scope = value.get('projectId') or value.get('ownerTeamId')
        # Team default/link writers use the same legacy scope lock.
        return f'workflows:{scope}' if scope else f"workflows:standalone:{owner}:{value.get('computerId')}"

    @staticmethod
    def _row(value: dict[str, Any], version: int) -> dict[str, Any]:
        return {'id': value['id'], 'owner_user_id': value['ownerUserId'], 'project_id': value.get('projectId'), 'owner_team_id': value.get('ownerTeamId'),
                'computer_id': value.get('computerId'),
                'name': value['name'], 'name_key': value['name'].casefold(), 'snapshot': deepcopy(value),
                'event_version': version, 'created_at': parse_db_time(value['createdAt']),
                'updated_at': parse_db_time(value['updatedAt']), 'deleted_at': parse_db_time(value.get('deletedAt'))}

    @staticmethod
    def _event(conn: Any, value: dict[str, Any], sequence: int, kind: str) -> None:
        conn.execute(insert(events).values(id=new_database_id(), workflow_id=value['id'], sequence=sequence,
                                          type=kind, timestamp=parse_db_time(value['updatedAt']), payload={'workflow': deepcopy(value)}))
