"""Start an independent Workflow, optionally with one of its linked Teams."""
import json
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from fastapi import APIRouter, HTTPException, Request

from ...agents.routing import resolve_agent_assignments
from ...collaboration.workflow_compilation import compile_workflow
from ...core.computer_identity import computer_id
from ...persistence.sql import names_no_uuid_row
from ...persistence.resource_lock import resource_transaction
from ...projects.workflow import validate_project_workflow
from ..agents.workflow_gates import _body
from ..bodies import JsonBodyDep
from ..deps import AppContextDep
from ..projects.access import current_project_node
from .workflows import owned_definition, workflow_owner

router = APIRouter()


@router.post('/workflows/{workflow_id}/runs', status_code=201)
def start_workflow(workflow_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    owner = workflow_owner(request, ctx)
    definition = owned_definition(request, ctx, workflow_id)
    team_id = _request_body.get('teamId')
    if team_id is not None and (not isinstance(team_id, str) or not team_id):
        raise HTTPException(400, 'workflow_team_invalid')
    if team_id and names_no_uuid_row(ctx.workflow_store.engine, team_id):
        raise HTTPException(400, 'workflow_team_invalid')
    request_id, goal = _body({key: value for key, value in _request_body.items() if key != 'teamId'})
    project = ctx.project_store.get_project(definition['projectId'])
    if not project or project.get('ownerUserId') != owner:
        raise HTTPException(403, 'workflow_project_owner_required')
    identity = json.dumps(['relay.workflow.v2', owner, workflow_id, request_id])
    session_id = str(uuid5(NAMESPACE_URL, identity))
    try:
        with ctx.registry.dispatch_lock, ctx.registry.dispatch_scope([
            node['id'] for node in ctx.registry.monitor_nodes() if computer_id(node) == project['computerId']
        ]), resource_transaction(ctx.registry.daemon_store.engine, f'workflow-start:{session_id}'):
            try:
                existing = ctx.session_store.get_session(session_id)
            except KeyError:
                existing = None
            if existing:
                if existing.get('ownerUserId') != owner or existing.get('teamId') != team_id or existing.get('taskGoal') != goal:
                    raise ValueError('workflow_request_conflict')
                if existing['workflowRuns'][0]['status'] == 'ready' and existing['status'] not in ('completed', 'failed', 'cancelled'):
                    return ctx.registry.admit_workflow_first_step(session_id)
                return existing
            team = ctx.team_store.get_team(team_id) if team_id else None
            if team_id and (not team or workflow_id not in {item['id'] for item in team.get('workflows', [])}):
                raise ValueError('workflow_team_unavailable')
            snapshot = validate_project_workflow(ctx, definition, team)
            node = current_project_node(ctx, project)
            if not node:
                raise ValueError('workflow_computer_unavailable')
            roster = resolve_agent_assignments(
                [{'agentId': aid} for aid in snapshot['memberAgentIds']], user_id=owner, is_admin=False,
                agent_store=ctx.agent_store, placement_store=ctx.agent_placement_store,
                daemon_nodes=ctx.registry.monitor_nodes(), required_node_id=node['id'],
            )
            assignments = compile_workflow(snapshot, roster, run_id=session_id)
            session = ctx.registry.stage_workflow_gate({
                'id': session_id, 'ownerUserId': owner, 'teamId': team_id, 'projectId': project['id'],
                'computerId': project['computerId'], 'workspaceLayout': 'project',
                'workspacePath': node.get('workspacePath') or '/workspace',
                'workspaceSubpath': project['workspaceSubpath'], 'taskGoal': goal,
            }, assignments)
            return ctx.registry.admit_workflow_first_step(session_id) if session['workflowRuns'][0]['status'] == 'ready' else session
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
