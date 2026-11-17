"""Owner-session decisions for durable workflow gates.

Approval and first-step command publication share a transaction. The dedicated
registry adapter rechecks live admission against the frozen ledger.
"""
from __future__ import annotations

from ...core.workflows import snapshot_team_id

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...collaboration.workflow_events import workflow_answer_text
from ...persistence.events import relay_event
from ...persistence.resource_lock import resource_transaction
from ...security.request_auth import require_user_session
from ...teams.workflow import validate_workflow_write
from ...daemon_registry.dispatch.workflow_admission import workflow_node_ids
from ..actors import chat_service_user_header, get_session_or_404
from ..bodies import JsonBodyDep
from ..deps import AppContext, AppContextDep

from ...daemon_registry.dispatch.workflow_tasks import sync_workflow_task
from ...daemon_registry.dispatch.workflow_admission import workflow_request_id

router = APIRouter()
_FIELDS = frozenset({
    "kind", "workflowRunId", "workflowStepId", "workflowAttempt",
    "assignmentId", "expectedRevision",
})


def assert_workflow_owner_session(
    request: Request, ctx: AppContext, session: dict[str, Any],
) -> None:
    """A stop/deletion must not turn service access into workflow authority.

    Keep the owner's exit available after Project/Agent admission becomes
    invalid. Only the recorded owner's real session is needed to stop work.
    Legacy Threads retain their existing authorization behavior.
    """
    if not session.get("workflowRuns"):
        return
    if chat_service_user_header(request):
        raise HTTPException(403, "workflow_owner_session_required")
    account = require_user_session(request, ctx.auth_store)
    if account.get("userId") != session.get("ownerUserId"):
        raise HTTPException(403, "workflow_owner_required")


def _validate_body(body: dict[str, Any]) -> None:
    kind = body.get("kind")
    fields = _FIELDS | {"answer"} if kind == "answer" else _FIELDS
    if set(body) != fields or kind not in ("approve", "reject", "retry", "cancel", "answer"):
        raise HTTPException(400, "workflow_gate_decision_invalid")
    if kind == "answer":
        try:
            body["answer"] = workflow_answer_text(body["answer"])
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
    for key in ("workflowRunId", "workflowStepId", "assignmentId"):
        value = body[key]
        if not isinstance(value, str) or not value.strip() or len(value) > 200:
            raise HTTPException(400, "workflow_gate_identity_invalid")
    for key, minimum in (("workflowAttempt", 1), ("expectedRevision", 0)):
        if type(body[key]) is not int or body[key] < minimum:
            raise HTTPException(400, "workflow_gate_revision_invalid")


@router.post("/threads/{session_id}/workflow-decisions")
def workflow_decision(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep,
) -> dict[str, Any]:
    if chat_service_user_header(request):
        raise HTTPException(403, "workflow_owner_session_required")
    account = require_user_session(request, ctx.auth_store)
    owner = account.get("userId")
    # Do not let user input overwrite the event type, timestamp or audit actor.
    _validate_body(_request_body)
    with ctx.registry.dispatch_lock, ctx.registry.dispatch_scope(
        workflow_node_ids(get_session_or_404(ctx.session_store, session_id)),
    ), resource_transaction(
        ctx.registry.daemon_store.engine, f"workflow-gate:{session_id}",
    ), ctx.session_store.mutation_scope(session_id):
        session = get_session_or_404(ctx.session_store, session_id)
        if not owner or session.get("ownerUserId") != owner:
            raise HTTPException(403, "workflow_owner_required")
        if _request_body["kind"] in ("retry", "cancel", "answer"):
            try:
                return ctx.registry.decide_workflow_recovery(session_id, {**_request_body, "actorUserId": owner})
            except ValueError as error:
                raise HTTPException(409, str(error)) from error
        project_id = session.get("projectId")
        project = ctx.project_store.get_project(project_id) if project_id else None
        if not project or project.get("ownerUserId") != owner:
            raise HTTPException(403, "workflow_project_owner_required")
        run = next((item for item in session.get("workflowRuns", [])
                    if item["workflowRunId"] == _request_body["workflowRunId"]), None)
        if not run or session.get("activeWorkflowRunId") != run["workflowRunId"]:
            raise HTTPException(409, "workflow_run_mismatch")
        snapshot = run["teamSnapshot"]
        if any(session.get(key) != (snapshot_team_id(snapshot) if key == "teamId" else snapshot.get(team_key)) for key, team_key in (
            ("teamId", "id"), ("projectId", "projectId"),
            ("computerId", "computerId"), ("ownerUserId", "ownerUserId"),
        )) or project["computerId"] != snapshot["computerId"]:
            raise HTTPException(409, "workflow_scope_mismatch")
        try:
            if _request_body["kind"] == "approve":
                # Use the frozen definition, not the Team's latest edit. This
                # check is not a grant for later dispatch; live admission must
                # also be checked immediately before each command.
                validate_workflow_write(ctx, owner, snapshot)
            result = ctx.session_store.append_event(session_id, relay_event(
                "workflow.gate_decided", session_id,
                {**_request_body, "actorUserId": owner},
            ))
            if _request_body["kind"] == "approve":
                return ctx.registry.admit_workflow_first_step(
                    session_id, validate=lambda snapshot: validate_workflow_write(ctx, owner, snapshot),
                )
            workflow_request = ctx.registry.daemon_store.get_run_request(workflow_request_id(run))
            if workflow_request:
                sync_workflow_task(ctx.registry, workflow_request, result)
            return result
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
