"""Owner-session management of a Team's reusable workflow definitions."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...core.workflows import team_workflows, workflow_definition, workflow_execution_snapshot, workflow_catalog
from ...security.request_auth import require_user_session
from ...teams.workflow import validate_workflow_write
from ..actors import chat_service_user_header
from ..bodies import JsonBodyDep
from ..deps import AppContextDep

router = APIRouter()


def owned_workflow_team(request: Request, ctx: AppContextDep, team_id: str) -> dict[str, Any]:
    if chat_service_user_header(request):
        raise HTTPException(403, 'workflow_owner_session_required')
    owner = require_user_session(request, ctx.auth_store)['userId']
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


def _save(team: dict[str, Any], body: dict[str, Any], ctx: AppContextDep,
          workflow_id: str | None = None) -> dict[str, Any]:
    current = next((item for item in team_workflows(team) if item['id'] == workflow_id), None)
    if workflow_id and current is None:
        raise HTTPException(404, 'workflow_not_found')
    try:
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
