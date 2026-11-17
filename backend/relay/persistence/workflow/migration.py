"""Extract historical nested definitions without changing their identities."""
from copy import deepcopy
from typing import Any

from sqlalchemy import insert, select, update

from ...core.ids import new_database_id
from ...core.workflows import team_workflows
from ..db_time import parse_db_time
from ..tables.teams import teams
from ..tables.workflows import workflows, links, events


def migrate_team_workflows(conn: Any) -> None:
    for team in conn.execute(select(teams.c.snapshot)).scalars().all():
        if team.get('workflowStorageVersion') == 1:
            continue
        for original in team_workflows(team):
            definition = {key: deepcopy(original[key]) for key in (
                'id', 'name', 'projectId', 'workflowSteps', 'enabled', 'createdAt', 'updatedAt',
            )}
            definition['ownerUserId'] = team['ownerUserId']
            if conn.execute(select(workflows.c.id).where(workflows.c.id == definition['id'])).first():
                raise ValueError('workflow_migration_identity_conflict')
            conn.execute(insert(workflows).values(
                id=definition['id'], owner_user_id=team['ownerUserId'], project_id=definition['projectId'],
                name=definition['name'], name_key=definition['name'].casefold(), snapshot=definition,
                event_version=1, created_at=parse_db_time(definition['createdAt']),
                updated_at=parse_db_time(definition['updatedAt']), deleted_at=None,
            ))
            conn.execute(insert(links).values(team_id=team['id'], workflow_id=definition['id']))
            conn.execute(insert(events).values(id=new_database_id(), workflow_id=definition['id'], sequence=0,
                                              type='workflow.imported', timestamp=parse_db_time(definition['updatedAt']),
                                              payload={'workflow': definition}))
        snapshot = {key: value for key, value in team.items() if key != 'workflows'}
        snapshot['workflowStorageVersion'] = 1
        conn.execute(update(teams).where(teams.c.id == team['id']).values(snapshot=snapshot))
