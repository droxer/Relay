"""Owner-session management of a Team's reusable workflow definitions."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import Response

from ...persistence.sql import names_no_uuid_row
from ...core.workflows import (
    project_workflow_definition,
    team_workflows,
    workflow_catalog,
    workflow_definition,
    workflow_execution_snapshot,
    workflow_step_agent_ids,
)
from ...security.request_auth import require_user_session
from ...teams.workflow import validate_workflow_write, validate_team_definition
from ..actors import chat_service_user_header
from ..bodies import JsonBodyDep
from ..conditional_get import private_conditional_json
from ..deps import AppContextDep

router = APIRouter()


def owned_workflow_team(request: Request, ctx: AppContextDep, team_id: str) -> dict[str, Any]:
    if chat_service_user_header(request):
        raise HTTPException(403, 'workflow_owner_session_required')
    owner = require_user_session(request, ctx.auth_store)['userId']
    if names_no_uuid_row(ctx.workflow_store.engine, team_id):
        raise HTTPException(404, "team_not_found")
    team = ctx.team_store.get_team(team_id)
    if not team or team.get('deletedAt'):
        raise HTTPException(404, 'team_not_found')
    if team.get('ownerUserId') != owner:
        raise HTTPException(403, 'workflow_owner_required')
    return team


@router.get('/teams/{team_id}/workflows')
def list_workflows(team_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    team = owned_workflow_team(request, ctx, team_id)
    return {'workflows': team_workflows(team), 'workflowOptions': workflow_catalog(team)}


@router.get('/teams/{team_id}/workflow-choices')
def list_workflow_choices(team_id: str, request: Request, ctx: AppContextDep) -> Response:
    team = owned_workflow_team(request, ctx, team_id)
    owner, computer = team['ownerUserId'], team.get('computerId')
    linked_project_ids = {
        item['projectId'] for item in team.get('workflows', [])
        if item.get('projectId') and not item.get('ownerTeamId')
    }
    # Legacy workflow Teams can still display their original Project.
    if team.get('projectId') and team.get('workflowSteps'):
        linked_project_ids.add(team['projectId'])
    projects = ctx.project_store.workflow_projects(owner, computer, linked_project_ids)
    eligible_projects = {project_id for project_id, _, eligible in projects if eligible}
    members = set(team['memberAgentIds'])
    choices = [
        {key: item[key] for key in ('id', 'name', 'projectId')}
        for item in ctx.workflow_store.list_workflows(owner, project_ids=eligible_projects)
        if item['enabled'] and not item.get('ownerTeamId') and members.issuperset(workflow_step_agent_ids(item))
    ]
    visible_project_ids = linked_project_ids | {item['projectId'] for item in choices}
    return private_conditional_json(request, {
        'workflows': choices,
        'projects': [{'id': project_id, 'name': name} for project_id, name, _ in projects if project_id in visible_project_ids],
    })


def _save(team: dict[str, Any], body: dict[str, Any], ctx: AppContextDep,
          workflow_id: str | None = None) -> dict[str, Any]:
    current = next((item for item in team_workflows(team) if item['id'] == workflow_id), None)
    if workflow_id and current is None:
        raise HTTPException(404, 'workflow_not_found')
    try:
        if body.get('projectId') and body.get('ownerTeamId'):
            raise ValueError('workflow_owner_scope_required')
        if not body.get('projectId', (current or {}).get('projectId')):
            if body.get('ownerTeamId', team['id']) != team['id']:
                raise ValueError('workflow_team_required')
            payload = {**body, 'ownerTeamId': team['id'], 'projectId': None}
            definition = project_workflow_definition(team['ownerUserId'], payload, current=current)
            validate_team_definition(ctx, definition, team)
            saved = ctx.workflow_store.save_workflow(team['ownerUserId'], payload, workflow_id=workflow_id)
            ctx.team_store.link_workflow(team['id'], saved['id'])
            return {'workflow': {**saved, 'teamId': team['id']}}
        definition = workflow_definition(team, body, current=current)
        snapshot = workflow_execution_snapshot({**team, 'workflows': [{**definition, 'enabled': True}]}, definition['id'])
        validate_workflow_write(ctx, team['ownerUserId'], snapshot)
        saved = ctx.team_store.save_workflow(team['id'], body, workflow_id=workflow_id)
    except ValueError as error:
        raise HTTPException(409 if str(error) in {'workflow_name_taken', 'workflow_is_default'} else 400, str(error)) from error
    except KeyError as error:
        raise HTTPException(404, 'workflow_not_found') from error
    return {'workflow': saved}


@router.post('/teams/{team_id}/workflows', status_code=201)
def create_workflow(team_id: str, request: Request, ctx: AppContextDep,
                    *, _request_body: JsonBodyDep) -> dict[str, Any]:
    return _save(owned_workflow_team(request, ctx, team_id), _request_body, ctx)


@router.patch('/teams/{team_id}/workflows/{workflow_id}')
def update_workflow(team_id: str, workflow_id: str, request: Request, ctx: AppContextDep,
                    *, _request_body: JsonBodyDep) -> dict[str, Any]:
    return _save(owned_workflow_team(request, ctx, team_id), _request_body, ctx, workflow_id)


@router.delete('/teams/{team_id}/workflows/{workflow_id}')
def delete_workflow(team_id: str, workflow_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    owned_workflow_team(request, ctx, team_id)
    try:
        team = ctx.team_store.delete_workflow(team_id, workflow_id)
    except KeyError as error:
        raise HTTPException(404, 'workflow_not_found') from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'workflows': team_workflows(team)}
