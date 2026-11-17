"""Owner-managed independent Project Workflows and optional Team links."""
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...persistence.sql import names_no_uuid_row
from ...core.workflows import project_workflow_definition
from ...projects.workflow import validate_project_workflow
from ...teams.workflow import validate_team_definition
from ...security.request_auth import require_user_session
from ..actors import chat_service_user_header
from ..bodies import JsonBodyDep
from ..deps import AppContextDep
from ..agents.workflows import owned_workflow_team

router = APIRouter()


def workflow_owner(request: Request, ctx: AppContextDep) -> str:
    if chat_service_user_header(request):
        raise HTTPException(403, 'workflow_owner_session_required')
    return str(require_user_session(request, ctx.auth_store)['userId'])


def owned_definition(request: Request, ctx: AppContextDep, workflow_id: str) -> dict[str, Any]:
    owner = workflow_owner(request, ctx)
    definition = ctx.workflow_store.get_workflow(workflow_id)
    if not definition:
        raise HTTPException(404, 'workflow_not_found')
    if definition['ownerUserId'] != owner:
        raise HTTPException(403, 'workflow_owner_required')
    return definition


@router.get('/workflows')
def list_workflows(request: Request, ctx: AppContextDep, projectId: str | None = None) -> dict[str, Any]:
    owner = workflow_owner(request, ctx)
    return {'workflows': ctx.workflow_store.list_workflows(owner, project_id=projectId)}


@router.get('/workflows/{workflow_id}')
def get_workflow(workflow_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return {'workflow': owned_definition(request, ctx, workflow_id)}


def save_definition(request: Request, ctx: AppContextDep, body: dict[str, Any], workflow_id: str | None = None) -> dict[str, Any]:
    owner = workflow_owner(request, ctx)
    current = owned_definition(request, ctx, workflow_id) if workflow_id else None
    try:
        definition = project_workflow_definition(owner, body, current=current)
        if definition.get('projectId') and names_no_uuid_row(ctx.workflow_store.engine, definition['projectId']):
            raise ValueError("workflow_project_not_found")
        if definition.get('ownerTeamId'):
            team = owned_workflow_team(request, ctx, definition['ownerTeamId'])
            validate_team_definition(ctx, definition, team)
        else:
            validate_project_workflow(ctx, definition, require_enabled=False)
        saved = ctx.workflow_store.save_workflow(owner, body, workflow_id=workflow_id)
        if saved.get('ownerTeamId'):
            ctx.team_store.link_workflow(saved['ownerTeamId'], saved['id'])
        return {'workflow': saved}
    except KeyError as error:
        raise HTTPException(404, "workflow_not_found") from error
    except ValueError as error:
        raise HTTPException(409 if str(error) in ('workflow_name_taken', 'workflow_is_default') else 400, str(error)) from error


@router.post('/workflows', status_code=201)
def create_workflow(request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    return save_definition(request, ctx, _request_body)


@router.patch('/workflows/{workflow_id}')
def update_workflow(workflow_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    return save_definition(request, ctx, _request_body, workflow_id)


@router.delete('/workflows/{workflow_id}')
def delete_workflow(workflow_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    owned_definition(request, ctx, workflow_id)
    try:
        ctx.workflow_store.delete_workflow(workflow_id)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'deletedWorkflowId': workflow_id}


@router.put('/teams/{team_id}/workflows/{workflow_id}/link')
def link_workflow(team_id: str, workflow_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    team = owned_workflow_team(request, ctx, team_id)
    definition = owned_definition(request, ctx, workflow_id)
    try:
        if definition.get('ownerTeamId'):
            validate_team_definition(ctx, definition, team)
        else:
            validate_project_workflow(ctx, definition, team, require_enabled=False)
        ctx.team_store.link_workflow(team_id, workflow_id)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'team': ctx.team_store.get_team(team_id)}


@router.delete('/teams/{team_id}/workflows/{workflow_id}/link')
def unlink_workflow(team_id: str, workflow_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    owned_workflow_team(request, ctx, team_id)
    owned_definition(request, ctx, workflow_id)
    try:
        ctx.team_store.link_workflow(team_id, workflow_id, linked=False)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'team': ctx.team_store.get_team(team_id)}


@router.put('/teams/{team_id}/workflow-defaults/{project_id}')
def set_project_default(team_id: str, project_id: str, request: Request, ctx: AppContextDep,
                        *, _request_body: JsonBodyDep) -> dict[str, Any]:
    team = owned_workflow_team(request, ctx, team_id)
    workflow_id = _request_body.get('workflowId')
    if set(_request_body) != {'workflowId'} or not isinstance(workflow_id, str):
        raise HTTPException(400, 'workflow_defaults_invalid')
    definition = owned_definition(request, ctx, workflow_id)
    if (definition.get('projectId') and definition['projectId'] != project_id) or workflow_id not in {item['id'] for item in team.get('workflows', [])}:
        raise HTTPException(409, 'workflow_defaults_invalid')
    try:
        validate_project_workflow(ctx, definition, team, project_id=project_id)
        updated = ctx.team_store.set_project_workflow_default(team_id, project_id, workflow_id)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'team': updated}


@router.delete('/teams/{team_id}/workflow-defaults/{project_id}')
def clear_project_default(team_id: str, project_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    owned_workflow_team(request, ctx, team_id)
    try:
        return {'team': ctx.team_store.set_project_workflow_default(team_id, project_id, None)}
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
