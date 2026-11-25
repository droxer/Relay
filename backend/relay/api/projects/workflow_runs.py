"""Start an independent Workflow, optionally with one of its linked Teams."""
import json
from hashlib import sha256
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ...agents.routing import resolve_agent_assignments
from ...collaboration.manifest import compile_assignment_work_graph, create_round_manifest
from ...collaboration.models import CollaborationIdempotencyError
from ...collaboration.workflow_compilation import compile_workflow
from ...core.computer_identity import computer_id
from ...core.ids import new_database_id
from ...core.workflow_selection import predefined_style
from ...persistence.sql import names_no_uuid_row
from ...persistence.resource_lock import resource_transaction
from ...projects.workflow import validate_project_workflow
from ...projects.runtime import project_runtime_node, project_styled_assignments, project_work_error
from ..agents.workflow_gates import _body
from ..bodies import JsonBodyDep
from ..threads.transcript import workflow_transcript
from ..deps import AppContextDep
from ..projects.access import current_project_node, require_owned_project
from .workflows import owned_definition, workflow_owner

router = APIRouter()


@router.post('/workflows/{workflow_id}/runs', status_code=201)
async def start_workflow(workflow_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    try:
        style = predefined_style(workflow_id)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error
    if style is None:
        return await run_in_threadpool(_start_custom_workflow, workflow_id, request, ctx, _request_body)
    try:
        existing, prepared = await run_in_threadpool(
            _prepare_project_preset, style, workflow_id, request, ctx, _request_body,
        )
        if prepared:
            node_id, payload = prepared
            existing = await ctx.backend.run(node_id, payload)
        assert existing is not None
        return await run_in_threadpool(workflow_transcript, ctx.session_store, existing)
    except CollaborationIdempotencyError as error:
        raise HTTPException(409, "workflow_request_conflict") from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


def _prepare_project_preset(
    style: str, workflow_id: str, request: Request, ctx: AppContextDep, body: dict[str, Any],
) -> tuple[dict[str, Any] | None, tuple[str, dict[str, Any]] | None]:
    owner = workflow_owner(request, ctx)
    if "teamId" in body:
        raise HTTPException(400, "workflow_team_forbidden")
    project_id = body.get("projectId")
    if not isinstance(project_id, str) or not project_id or names_no_uuid_row(ctx.workflow_store.engine, project_id):
        raise HTTPException(400, "workflow_project_required")
    request_id, goal = _body({key: value for key, value in body.items() if key != "projectId"})
    project = require_owned_project(ctx, project_id, owner)
    identity = json.dumps(["relay.project.preset", owner, workflow_id, request_id])
    fingerprint = sha256(json.dumps([project_id, goal]).encode()).hexdigest()
    existing = ctx.backend.idempotent_run(identity, owner, expected_fingerprint=fingerprint, hydrate=False)
    if existing:
        return existing, None
    if code := project_work_error(project):
        raise ValueError(code)

    nodes = ctx.registry.monitor_nodes()
    roster, snapshot = project_styled_assignments(
        project, style=style, agent_store=ctx.agent_store, placement_store=ctx.agent_placement_store,
        daemon_nodes=nodes,
    )
    node = project_runtime_node(project, nodes)
    if not node:
        raise ValueError("workflow_computer_unavailable")
    assignments = resolve_agent_assignments(
        [{**item, "assignmentId": new_database_id()} for item in roster],
        user_id=owner, is_admin=False, agent_store=ctx.agent_store,
        placement_store=ctx.agent_placement_store, daemon_nodes=nodes, required_node_id=node["id"],
    )
    assignments = compile_assignment_work_graph(assignments, purpose="accomplish", team_snapshot=None)
    return None, (node["id"], {
        "actorUserId": owner,
        "agentFirst": True,
        "taskGoal": goal,
        "projectId": project_id,
        "workspaceLayout": "project",
        "workspaceSubpath": project["workspaceSubpath"],
        "idempotencyKey": identity,
        "idempotencyFingerprint": fingerprint,
        "_hydrateSession": False,
        "assignments": assignments,
        "collaboration": {"manifest": create_round_manifest(
            source="run", purpose="accomplish", address={"kind": "room"},
            assignments=assignments, team_snapshot=None, project_snapshot=snapshot,
        )},
    })


def _start_custom_workflow(workflow_id: str, request: Request, ctx: AppContextDep, _request_body: dict[str, Any]) -> dict[str, Any]:
    owner = workflow_owner(request, ctx)
    definition = owned_definition(request, ctx, workflow_id)
    team_id = _request_body.get('teamId')
    if team_id is not None and (not isinstance(team_id, str) or not team_id):
        raise HTTPException(400, 'workflow_team_invalid')
    if team_id and names_no_uuid_row(ctx.workflow_store.engine, team_id):
        raise HTTPException(400, 'workflow_team_invalid')
    request_id, goal = _body({key: value for key, value in _request_body.items() if key not in {'teamId', 'projectId'}})
    project_id = definition.get('projectId') or _request_body.get('projectId')
    if not isinstance(project_id, str) or names_no_uuid_row(ctx.workflow_store.engine, project_id):
        raise HTTPException(400, 'workflow_project_required')
    if definition.get('projectId') and _request_body.get('projectId', project_id) != project_id:
        raise HTTPException(409, 'team_workflow_project_mismatch')
    project = ctx.project_store.get_project(project_id)
    if not project or project.get('ownerUserId') != owner:
        raise HTTPException(403, 'workflow_project_owner_required')
    identity = json.dumps(['relay.workflow.v2', owner, workflow_id, request_id])
    session_id = str(uuid5(NAMESPACE_URL, identity))
    try:
        with ctx.registry.dispatch_lock, ctx.registry.dispatch_scope([
            node['id'] for node in ctx.registry.monitor_nodes() if computer_id(node) == project['computerId']
        ]), resource_transaction(ctx.registry.daemon_store.engine, f'workflow-start:{session_id}'):
            try:
                existing = ctx.session_store.get_session_header(session_id)
            except KeyError:
                existing = None
            if existing:
                if existing.get('ownerUserId') != owner or existing.get('teamId') != team_id or existing.get('projectId') != project_id or existing.get('taskGoal') != goal:
                    raise ValueError('workflow_request_conflict')
                if existing['workflowRuns'][0]['status'] == 'ready' and existing['status'] not in ('completed', 'failed', 'cancelled'):
                    return workflow_transcript(ctx.session_store, ctx.registry.admit_workflow_first_step(session_id))
                return workflow_transcript(ctx.session_store, existing)
            team = ctx.team_store.get_team(team_id) if team_id else None
            if team_id and not team:
                raise ValueError('workflow_team_unavailable')
            snapshot = validate_project_workflow(ctx, definition, team, project_id=project_id)
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
            if session['workflowRuns'][0]['status'] == 'ready':
                session = ctx.registry.admit_workflow_first_step(session_id)
            return workflow_transcript(ctx.session_store, session)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
