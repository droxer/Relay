"""Owner-managed independent Project Workflows and optional Team links."""
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from ...persistence.sql import names_no_uuid_row
from ...core.workflow_selection import PREDEFINED_WORKFLOWS
from ...core.workflows import (
    apply_workflow_step_changes, project_workflow_definition, workflow_preview,
    workflow_step_agent_ids, workflow_step_changes,
)
from ...projects.workflow import validate_project_workflow
from ...computer.workflows import validate_standalone_workflow
from ...teams.workflow import validate_team_definition
from ...security.request_auth import require_user_session
from ..actors import chat_service_user_header
from ..bodies import JsonBodyDep
from ..conditional_get import private_conditional_json
from ..deps import AppContextDep
from ..agents.workflows import owned_workflow_team
from ..agents.teams import _team_view, _team_workflow_default_update

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


@router.get('/workflows', response_model=None)
def list_workflows(
    request: Request, ctx: AppContextDep, projectId: str | None = None, scope: str | None = None,
) -> dict[str, Any] | Response:
    owner = workflow_owner(request, ctx)
    if scope not in (None, 'standalone') or (scope == 'standalone' and projectId):
        raise HTTPException(400, 'workflow_scope_invalid')
    view = request.query_params.get('view')
    definitions = ctx.workflow_store.list_workflows(owner, project_id=projectId,
                                                   project_only=view == 'choices' and scope != 'standalone',
                                                   standalone_only=scope == 'standalone')
    if view == 'choices':
        return private_conditional_json(request, {
            'workflows': [
                {**{key: definition[key] for key in ('id', 'name', 'projectId', 'computerId', 'enabled') if key in definition},
                 'stepAgentIds': workflow_step_agent_ids(definition)}
                for definition in definitions
            ],
            **({'predefinedWorkflows': PREDEFINED_WORKFLOWS} if projectId else {}),
        })
    if view == 'preview':
        return private_conditional_json(request, {
            'view': 'preview', 'workflows': [workflow_preview(definition) for definition in definitions],
        })
    return {'workflows': definitions}


@router.get('/workflows/{workflow_id}')
def get_workflow(workflow_id: str, request: Request, ctx: AppContextDep) -> Response:
    definition = owned_definition(request, ctx, workflow_id)
    if request.query_params.get('view') == 'name':
        definition = {key: definition[key] for key in ('id', 'name')}
    return private_conditional_json(request, {'workflow': definition})


def save_definition(request: Request, ctx: AppContextDep, body: dict[str, Any], workflow_id: str | None = None) -> dict[str, Any]:
    owner = workflow_owner(request, ctx)
    current = owned_definition(request, ctx, workflow_id) if workflow_id else None
    try:
        patch = dict(body)
        expected_version = patch.pop('expectedVersion', None)
        if 'expectedVersion' in body or 'workflowStepChanges' in body:
            if not current or isinstance(expected_version, bool) or not isinstance(expected_version, int):
                raise ValueError('workflow_version_required')
            if current['version'] != expected_version:
                raise ValueError('workflow_version_conflict')
        if 'workflowStepChanges' in patch:
            if not current or 'workflowSteps' in patch:
                raise ValueError('workflow_step_changes_invalid')
            patch['workflowSteps'] = apply_workflow_step_changes(current['workflowSteps'], patch.pop('workflowStepChanges'))
        definition = project_workflow_definition(owner, patch, current=current)
        if definition.get('projectId') and names_no_uuid_row(ctx.workflow_store.engine, definition['projectId']):
            raise ValueError("workflow_project_not_found")
        team_link_unchanged = False
        if definition.get('ownerTeamId'):
            team = owned_workflow_team(request, ctx, definition['ownerTeamId'])
            validate_team_definition(ctx, definition, team)
            # The owning Team cannot unlink its Workflow.
            team_link_unchanged = bool(current and any(item['id'] == current['id'] for item in team.get('workflows', [])))
        elif definition.get('computerId'):
            validate_standalone_workflow(ctx, definition, require_enabled=False)
        else:
            validate_project_workflow(ctx, definition, require_enabled=False)
        saved = ctx.workflow_store.save_workflow(owner, patch, workflow_id=workflow_id, expected_version=expected_version)
        if saved.get('ownerTeamId') and not team_link_unchanged:
            ctx.team_store.link_workflow(saved['ownerTeamId'], saved['id'])
        if (current and expected_version is not None and request.query_params.get('view') == 'update'
                and body.keys() <= {'expectedVersion', 'name', 'workflowStepChanges'}):
            return {'workflowUpdate': {
                **{key: saved[key] for key in ('id', 'name', 'updatedAt', 'version')},
                'baseVersion': expected_version,
                'workflowStepChanges': workflow_step_changes(current['workflowSteps'], saved['workflowSteps']),
                **({'teamLinkUnchanged': True} if team_link_unchanged else {}),
            }}
        return {'workflow': saved}
    except KeyError as error:
        raise HTTPException(404, "workflow_not_found") from error
    except ValueError as error:
        raise HTTPException(409 if str(error) in ('workflow_name_taken', 'workflow_is_default', 'workflow_version_conflict') else 400, str(error)) from error


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
        updated = ctx.team_store.link_workflow(team_id, workflow_id)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return _team_link_result(request, ctx, updated, workflow_id)


@router.delete('/teams/{team_id}/workflows/{workflow_id}/link')
def unlink_workflow(team_id: str, workflow_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    owned_workflow_team(request, ctx, team_id)
    owned_definition(request, ctx, workflow_id)
    try:
        updated = ctx.team_store.link_workflow(team_id, workflow_id, linked=False)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return _team_link_result(request, ctx, updated, workflow_id)


def _team_link_result(request: Request, ctx: AppContextDep, team: dict[str, Any], workflow_id: str) -> dict[str, Any]:
    if request.query_params.get('format') != 'delta':
        return _team_write_result(request, ctx, team)
    definitions = team['workflows']
    linked = next((item for item in definitions if item['id'] == workflow_id), None)
    version = team['version']
    return {'teamWorkflowUpdate': {
        'teamId': team['id'], 'baseVersion': version - 1, 'version': version, 'updatedAt': team['updatedAt'],
        'workflowId': workflow_id, 'workflow': workflow_preview(linked) if linked else None,
        'workflowOrder': [{'id': item['id'], 'version': item['version']} for item in definitions],
    }}


def _team_write_result(request: Request, ctx: AppContextDep, team: dict[str, Any]) -> dict[str, Any]:
    return {'team': _team_view(ctx, team, view='preview') if request.query_params.get('view') == 'preview' else team}


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
    if request.query_params.get('format') == 'delta':
        return _team_workflow_default_update(updated, project_id=project_id)
    return _team_write_result(request, ctx, updated)


@router.delete('/teams/{team_id}/workflow-defaults/{project_id}')
def clear_project_default(team_id: str, project_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    owned_workflow_team(request, ctx, team_id)
    try:
        updated = ctx.team_store.set_project_workflow_default(team_id, project_id, None)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    if request.query_params.get('format') == 'delta':
        return _team_workflow_default_update(updated, project_id=project_id)
    return _team_write_result(request, ctx, updated)
