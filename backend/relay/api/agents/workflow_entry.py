"""Route a new Team conversation through its selected custom Workflow."""
from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ...core.computer_identity import computer_id
from ...core.workflow_selection import default_workflow_id, predefined_style
from ...core.workflows import workflow_execution_snapshot
from ...core.team_workflows import is_workflow_team
from ...sessions.controller import SessionController
from ..bodies import string_field
from ..deps import AppContextDep
from .workflow_gates import stage_workflow_gate
from .workflows import owned_workflow_team


async def custom_workflow_entry(
    request: Request, ctx: AppContextDep, body: dict[str, Any], goal: str,
) -> dict[str, Any] | None:
    if body.get('sessionId') or body.get('session_id') or body.get('decision') or body.get('mode', 'action') != 'action':
        return None
    team_id = string_field(body, 'teamId') or string_field(body, 'team_id')
    if not team_id or body.get('style') is not None:
        return None
    team = await run_in_threadpool(ctx.team_store.get_team, team_id)
    if team is None:
        return None  # Generic admission provides the normal owner/not-found refusal.
    if is_workflow_team(team) and body.get('workflowId') is None and 'defaultWorkflowId' not in team:
        return None  # Keep legacy callers fenced; explicit canonical selection opts in.
    try:
        workflow_id = body['workflowId'] if body.get('workflowId') is not None else default_workflow_id(team, body.get('projectId') or body.get('project_id'))
        if predefined_style(workflow_id) is not None:
            return None
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    team = await run_in_threadpool(owned_workflow_team, request, ctx, team_id)
    try:
        snapshot = workflow_execution_snapshot(team, workflow_id)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    if body.get('assignments') is not None or body.get('attachmentIds') or body.get('connectionGrants'):
        raise HTTPException(400, 'workflow_start_overrides_unsupported')
    project_id = body.get('projectId') or body.get('project_id')
    if project_id and project_id != snapshot['projectId']:
        raise HTTPException(409, 'team_workflow_project_mismatch')
    node_id = body.get('daemonNodeId') or body.get('daemon_node_id')
    if node_id:
        node = ctx.registry.get(node_id)
        if not node or computer_id(node) != snapshot.get('computerId'):
            raise HTTPException(409, 'workflow_computer_mismatch')
    key = string_field(body, 'idempotencyKey') or string_field(body, 'idempotency_key') or str(uuid4())
    request_id = str(uuid5(NAMESPACE_URL, f'workflow-entry:{team["ownerUserId"]}:{key}'))
    session = await run_in_threadpool(stage_workflow_gate, team_id, request, ctx,
                                    _request_body={'requestId': request_id, 'taskGoal': goal}, workflow_id=workflow_id)
    # Reconcile the composer's optimistic turn once, including retried HTTP responses.
    message_id = string_field(body, 'userMessageId') or str(uuid5(NAMESPACE_URL, f'workflow-entry-message:{session["id"]}'))
    return await run_in_threadpool(_record_opening_turn, ctx, session['id'], team['ownerUserId'], goal, message_id)


def _record_opening_turn(ctx: AppContextDep, sid: str, owner: str, goal: str, message_id: str) -> dict[str, Any]:
    with ctx.session_store.mutation_scope(sid):
        current = ctx.session_store.get_session(sid)
        if any(event.get('type') == 'user.message' and event.get('id') == message_id for event in current['events']):
            return current
        return SessionController(ctx.session_store).record_user_message(sid, goal, owner, message_id)
