"""Task entry into the dedicated Project workflow runtime.

Claim, frozen ledger, navigation link and execution generation commit together,
including when the very first step waits for approval and has no command yet.
"""
from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_URL, uuid5

from ..agents.routing import resolve_agent_assignments
from ..collaboration.workflow_compilation import compile_workflow
from ..core.computer_identity import computer_id
from ..daemon_registry.dispatch.workflow_tasks import sync_workflow_task
from ..persistence.engine import store_transaction
from ..persistence.protocols import TaskDispatchAssignment
from ..projects.runtime import project_runtime_node
from ..security.actor import Actor
from ..teams.workflow import validate_workflow_write
from .assignment import team_for_assignment, validate_project_task_assignment, validate_task_workflow
from .claims import dispatch_claim_active
from .dispatch_outcome import TaskDispatchContext, DispatchResult, _result, _record_result
from .placement import task_goal_text
from .requests import TaskRequestError
from .dispatch_failure import record_dispatch_failure


def dispatch_task_workflow(
    ctx: TaskDispatchContext, source: dict[str, Any], actor: Actor, *, record_pending: bool,
) -> DispatchResult:
    registry = ctx.registry
    project = ctx.project_store.get_project(source["projectId"]) if source.get("projectId") else None
    if project is None:
        code = "project_not_found" if source.get("projectId") else "team_workflow_project_mismatch"
        if not record_pending:
            return _record_result(ctx, source["id"], "rejected", code=code)
        # A scheduled task left assigned would be refused again on every tick.
        return _record_pending_failure(ctx, source, code)
    try:
        with registry.dispatch_lock, registry.dispatch_scope([
            node["id"] for node in registry.monitor_nodes()
            if computer_id(node) == project["computerId"]
        ]), store_transaction(registry.daemon_store.engine), ctx.task_store.task_write_scope(source["id"]) as task:
            if dispatch_claim_active(task) or registry.daemon_store.active_run_request_for_task(task["id"]):
                return _result(task, "queued", code="task_execution_active")
            if task.get("deletedAt") or task.get("status") not in ("backlog", "assigned", "queued"):
                return _result(task, "rejected", code="invalid_state")
            if TaskDispatchAssignment.capture(task) != TaskDispatchAssignment.capture(source):
                return _result(task, "queued", code="dispatch_superseded")
            owner = task["ownerUserId"]
            team = team_for_assignment(ctx, actor, task["assignedTeamId"],
                                       expected_user_id=owner, project_id=task.get("projectId"))
            assert team is not None
            validate_project_task_assignment(ctx, task, assigned_agent_id=None, assigned_team_id=team["id"])
            team = validate_task_workflow(ctx, task) or team
            validate_workflow_write(ctx, owner, team)
            project = ctx.project_store.get_project(task["projectId"])
            if not project:
                raise ValueError("project_not_found")
            node = project_runtime_node(project, registry.monitor_nodes())
            if node is None:
                raise ValueError("workflow_computer_unavailable")
            roster = resolve_agent_assignments(
                [{"agentId": aid} for aid in team["memberAgentIds"]], user_id=owner,
                is_admin=False, agent_store=ctx.agent_store, placement_store=ctx.agent_placement_store,
                daemon_nodes=registry.monitor_nodes(), required_node_id=node["id"],
            )
            if task["status"] == "backlog":
                task = ctx.task_store.update_task(task["id"], {"status": "assigned"})
            claimed = ctx.task_store.claim_task_for_dispatch(
                task["id"], roster[0]["agent"], expected_assignment=TaskDispatchAssignment.capture(task),
            )
            if not claimed:
                return _result(ctx.task_store.get_task(task["id"]), "queued", code="dispatch_in_progress")
            claim_id = claimed["dispatchClaim"]["id"]
            sid = str(uuid5(NAMESPACE_URL, "relay.task-workflow.v1:" + claim_id))
            assignments = compile_workflow(team, roster, run_id=sid)
            session = registry.stage_workflow_gate({
                "id": sid, "ownerUserId": owner, "teamId": team["id"],
                "projectId": project["id"], "computerId": project["computerId"],
                "workspacePath": node.get("workspacePath") or "/workspace",
                "workspaceLayout": "project", "workspaceSubpath": project["workspaceSubpath"],
                "taskGoal": task_goal_text(task),
            }, assignments, task=claimed)
            ctx.task_store.link_session(task["id"], sid)
            if session["workflowRuns"][0]["status"] == "ready":
                session = registry.admit_workflow_first_step(sid)
            else:
                request = registry.daemon_store.active_run_request_for_task(task["id"])
                assert request is not None
                sync_workflow_task(registry, request, session)
            ctx.task_store.clear_dispatch_retry(task["id"])
            ctx.task_store.release_dispatch_claim(task["id"], claim_id)
            updated = ctx.task_store.record_dispatch_outcome(task["id"], "started")
            return _result(updated, "started", session=session)
    except (ValueError, TaskRequestError) as error:
        if not record_pending:
            raise
        code = error.detail if isinstance(error, TaskRequestError) else str(error)
        return _record_pending_failure(ctx, source, code)


def _record_pending_failure(ctx: TaskDispatchContext, source: dict[str, Any], code: str) -> DispatchResult:
    """Block a refused scheduled start; record a computer wait only when it changes."""
    registry = ctx.registry
    with registry.dispatch_lock, ctx.task_store.task_write_scope(source["id"]) as current:
        if (not TaskDispatchAssignment.capture(source).matches(current)
            or current.get("status") not in ("backlog", "assigned", "queued")
            or registry.daemon_store.active_run_request_for_task(source["id"])):
            return _result(current, "queued", code="dispatch_superseded")
        if code == "workflow_computer_unavailable":
            if current.get("dispatchOutcome") == {"state": "queued", "code": code, "message": code}:
                return _result(current, "queued", code=code, message=code)
            return _record_result(ctx, source["id"], "queued", code=code, message=code)
        updated = record_dispatch_failure(ctx.task_store, current, code=code, message=code)
        return _result(updated, updated["dispatchOutcome"]["state"], code=code,
                       message=updated["dispatchOutcome"].get("message"))
