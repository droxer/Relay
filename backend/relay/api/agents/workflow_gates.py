"""Owner-session start of a Project workflow's frozen first step."""
from __future__ import annotations

import json
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ...core.workflow_selection import predefined_style
from ...collaboration.models import RunIntent
from ...collaboration.service import CollaborationConductor
from ...collaboration.errors import CollaborationError
from .workflows import owned_workflow_team

from ...agents.routing import resolve_agent_assignments
from ...collaboration.workflow_compilation import compile_workflow
from ...core.team_workflows import is_workflow_team
from ...core.workflows import workflow_execution_snapshot
from ...core.computer_identity import computer_id
from ...persistence.resource_lock import resource_transaction
from ...security.request_auth import require_user_session
from ...teams.workflow import validate_workflow_write
from ..actors import chat_service_user_header
from ..bodies import JsonBodyDep
from ..deps import AppContextDep
from ..projects.access import current_project_node, project_for_owner

router = APIRouter()


def _body(body: dict[str, Any]) -> tuple[str, str]:
    if set(body) != {"requestId", "taskGoal"}:
        raise HTTPException(400, "workflow_staging_body_invalid")
    request_id, goal = body["requestId"], body["taskGoal"]
    if not isinstance(request_id, str) or len(request_id) > 36:
        raise HTTPException(400, "workflow_staging_request_invalid")
    try:
        request_id = str(UUID(request_id))
    except ValueError as error:
        raise HTTPException(400, "workflow_staging_request_invalid") from error
    if not isinstance(goal, str) or not goal.strip() or len(goal) > 20000:
        raise HTTPException(400, "workflow_staging_goal_invalid")
    return request_id, goal.strip()


@router.post("/teams/{team_id}/workflow-runs", status_code=201)
@router.post("/teams/{team_id}/workflow-gates", status_code=201)
def stage_workflow_gate(
    team_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep,
    workflow_id: str | None = None,
) -> dict[str, Any]:
    """Freeze the run; deliver the first step when no approval gate is pending."""
    if chat_service_user_header(request):
        raise HTTPException(403, "workflow_owner_session_required")
    account = require_user_session(request, ctx.auth_store)
    owner = account["userId"]
    request_id, goal = _body(_request_body)
    team = ctx.team_store.get_team(team_id)
    if not team or team.get("deletedAt"):
        raise HTTPException(404, "team_not_found")
    if team.get("ownerUserId") != owner:
        raise HTTPException(403, "workflow_owner_required")
    if not team.get("enabled", True):
        raise HTTPException(409, "team_disabled")
    if workflow_id is None and is_workflow_team(team):
        # Legacy route snapshots retain their original Team-shaped envelope;
        # the steps themselves always come from the independent definition.
        definition = next((item for item in team.get('workflows', []) if item['id'] == team_id), None)
        if not definition or not definition.get('enabled', True):
            raise HTTPException(409, 'workflow_not_found')
        team = {**team, 'workflowSteps': definition['workflowSteps'], 'projectId': definition['projectId']}
    if workflow_id is not None:
        try:
            team = workflow_execution_snapshot(team, workflow_id)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
    if not is_workflow_team(team):
        raise HTTPException(409, "workflow_definition_required")
    project = project_for_owner(ctx, team["projectId"], owner, require_enabled=True)
    if project is None:
        raise HTTPException(404, "team_workflow_project_not_found")
    try:
        with ctx.registry.dispatch_lock, ctx.registry.dispatch_scope([
            node["id"] for node in ctx.registry.monitor_nodes()
            if computer_id(node) == project["computerId"]
        ]), resource_transaction(ctx.registry.daemon_store.engine, f"workflow-start:{owner}:{team_id}:{workflow_id or team_id}:{request_id}"):
            identity = json.dumps(["relay.workflow-gate.v1", owner, team_id, request_id]
                                  + ([workflow_id] if workflow_id and workflow_id != team_id else []))
            session_id = str(uuid5(NAMESPACE_URL, identity))
            try:
                existing = ctx.session_store.get_session(session_id)
            except KeyError:
                existing = None
            if existing is not None:
                if existing.get("ownerUserId") != owner or existing.get("teamId") != team_id or existing.get("taskGoal") != goal:
                    raise ValueError("workflow_request_conflict")
                if existing["workflowRuns"][0]["status"] == "ready" and existing.get("status") not in ("completed", "failed", "cancelled"):
                    return ctx.registry.admit_workflow_first_step(
                        session_id, validate=lambda snapshot: validate_workflow_write(ctx, owner, snapshot),
                    )
                return existing
            validate_workflow_write(ctx, owner, team)
            node = current_project_node(ctx, project)
            if node is None:
                raise ValueError("workflow_computer_unavailable")
            roster = resolve_agent_assignments(
                [{"agentId": aid} for aid in team["memberAgentIds"]],
                user_id=owner, is_admin=False, agent_store=ctx.agent_store,
                placement_store=ctx.agent_placement_store,
                daemon_nodes=ctx.registry.monitor_nodes(), required_node_id=node["id"],
            )
            # Include the owner in the key so another user's request cannot collide.
            assignments = compile_workflow(team, roster, run_id=session_id)
            session = ctx.registry.stage_workflow_gate({
                "id": session_id, "ownerUserId": owner, "teamId": team_id,
                "projectId": project["id"], "computerId": project["computerId"],
                "workspacePath": node.get("workspacePath") or "/workspace",
                "workspaceLayout": "project", "workspaceSubpath": project["workspaceSubpath"],
                "taskGoal": goal,
            }, assignments)
            if session["workflowRuns"][0]["status"] == "ready" and session.get("status") not in ("completed", "failed", "cancelled"):
                return ctx.registry.admit_workflow_first_step(
                    session["id"], validate=lambda snapshot: validate_workflow_write(ctx, owner, snapshot),
                )
            return session
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.post("/teams/{team_id}/workflows/{workflow_id}/runs", status_code=201)
async def start_team_workflow(
    team_id: str, workflow_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep,
) -> dict[str, Any]:
    try:
        style = predefined_style(workflow_id)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if style is None:
        return await run_in_threadpool(stage_workflow_gate, team_id, request, ctx,
                                       _request_body=_request_body, workflow_id=workflow_id)
    team = await run_in_threadpool(owned_workflow_team, request, ctx, team_id)
    if not team.get("enabled", True):
        raise HTTPException(409, "team_disabled")
    request_id, goal = _body(_request_body)
    try:
        return await CollaborationConductor(ctx).submit(RunIntent(
            task_goal=goal, session_id=None, raw_assignments=None, requested_team_id=team_id, style=style,
            idempotency_key=f"workflow:{team_id}:{workflow_id}:{request_id}",
        ), {"userId": team["ownerUserId"], "isAdmin": False})
    except CollaborationError as error:
        raise HTTPException(error.status, {"code": error.code, "message": str(error)}) from error
