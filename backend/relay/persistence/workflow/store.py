"""Workflow aggregate independent of optional Team references."""
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
        statement = select(workflows.c.snapshot).where(workflows.c.id == workflow_id)
        if not include_deleted:
            statement = statement.where(workflows.c.deleted_at.is_(None))
        with store_transaction(self.engine) as conn:
            value = conn.execute(statement).scalar_one_or_none()
        return deepcopy(value) if value else None

    def list_workflows(self, owner: str | None = None, *, project_id: str | None = None,
                       team_id: str | None = None) -> list[dict[str, Any]]:
        statement = select(workflows.c.snapshot).where(workflows.c.deleted_at.is_(None))
        if owner:
            statement = statement.where(workflows.c.owner_user_id == owner)
        if project_id:
            if names_no_uuid_row(self.engine, project_id):
                return []
            statement = statement.where(workflows.c.project_id == project_id)
        if team_id:
            statement = statement.join(links, links.c.workflow_id == workflows.c.id).where(links.c.team_id == team_id)
        with store_transaction(self.engine) as conn:
            values = conn.execute(statement).scalars().all()
        return sorted((deepcopy(value) for value in values), key=lambda value: (value['name'].casefold(), value['id']))

    def for_teams(self, team_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
        if not team_ids:
            return {}
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(links.c.team_id, workflows.c.snapshot).join(
                workflows, workflows.c.id == links.c.workflow_id,
            ).where(links.c.team_id.in_(team_ids), workflows.c.deleted_at.is_(None))).all()
        result: dict[str, list[dict[str, Any]]] = {}
        for team_id, snapshot in rows:
            result.setdefault(str(team_id), []).append({**deepcopy(snapshot), 'teamId': str(team_id)})
        for values in result.values():
            values.sort(key=lambda value: (value['name'].casefold(), value['id']))
        return result

    def save_workflow(self, owner: str, payload: dict[str, Any], *, workflow_id: str | None = None) -> dict[str, Any]:
        project_id = payload.get('projectId')
        old = self.get_workflow(workflow_id) if workflow_id else None
        if workflow_id and not old:
            raise KeyError(workflow_id)
        if old and old['ownerUserId'] != owner:
            raise ValueError('workflow_owner_required')
        scope = old['projectId'] if old else project_id
        with resource_transaction(self.engine, f'workflows:{scope}'):
            current = self.get_workflow(workflow_id) if workflow_id else None
            if workflow_id and not current:
                raise KeyError(workflow_id)
            definition = project_workflow_definition(owner, payload, current=current)
            if not current or current['name'].casefold() != definition['name'].casefold():
                if any(value['id'] != definition['id'] and value['name'].casefold() == definition['name'].casefold()
                       for value in self.list_workflows(owner, project_id=definition['projectId'])):
                    raise ValueError('workflow_name_taken')
            if current and current['enabled'] and not definition['enabled']:
                self.assert_not_default(current['id'])
            try:
                with store_transaction(self.engine) as conn:
                    version = 0
                    if current:
                        version = conn.execute(select(workflows.c.event_version).where(workflows.c.id == workflow_id)).scalar_one()
                        conn.execute(update(workflows).where(workflows.c.id == workflow_id).values(**self._row(definition, version + 1)))
                    else:
                        conn.execute(insert(workflows).values(**self._row(definition, 1)))
                    self._event(conn, definition, version, 'workflow.updated' if current else 'workflow.created')
            except IntegrityError as error:
                # The only user-controlled unique key is Project + folded name.
                if 'uq_workflows_live_project_name' in str(error) or 'workflows.project_id, workflows.name_key' in str(error):
                    raise ValueError('workflow_name_taken') from error
                raise
            return definition

    def delete_workflow(self, workflow_id: str) -> None:
        current = self.get_workflow(workflow_id)
        if not current:
            raise KeyError(workflow_id)
        with resource_transaction(self.engine, f"workflows:{current['projectId']}"):
            self.assert_not_default(workflow_id)
            with store_transaction(self.engine) as conn:
                version = conn.execute(select(workflows.c.event_version).where(workflows.c.id == workflow_id)).scalar_one()
                definition = {**current, 'enabled': False, 'deletedAt': now_iso(), 'updatedAt': now_iso()}
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
    def _row(value: dict[str, Any], version: int) -> dict[str, Any]:
        return {'id': value['id'], 'owner_user_id': value['ownerUserId'], 'project_id': value['projectId'],
                'name': value['name'], 'name_key': value['name'].casefold(), 'snapshot': deepcopy(value),
                'event_version': version, 'created_at': parse_db_time(value['createdAt']),
                'updated_at': parse_db_time(value['updatedAt']), 'deleted_at': parse_db_time(value.get('deletedAt'))}

    @staticmethod
    def _event(conn: Any, value: dict[str, Any], sequence: int, kind: str) -> None:
        conn.execute(insert(events).values(id=new_database_id(), workflow_id=value['id'], sequence=sequence,
                                          type=kind, timestamp=parse_db_time(value['updatedAt']), payload={'workflow': deepcopy(value)}))
