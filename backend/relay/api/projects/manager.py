"""Owner-facing manager conversations and command-scoped daemon tools."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from ...collaboration.models import RunIntent
from ...collaboration.service import CollaborationConductor
from ...collaboration.errors import CollaborationError
from ...projects.manager import ManagerError, ensure_manager_thread, manager_candidates, manager_role_patch, manager_view
from ...projects.manager_reads import manager_overview, read_manager_tool
from ...projects.manager_proposals import apply_proposal, stage_proposal
from ...projects.runtime import project_work_error
from ...tasks.requests import TaskRequestError
from ...tasks.prerequisites import PrerequisiteError
from ...persistence.project.store import ProjectVersionConflict
from ...persistence.sql import names_no_uuid_row
from ...daemon_registry.records import DeletedDaemonNodeError
from ..actors import bearer_token, request_actor
from ..bodies import JsonBodyDep
from ..deps import AppContextDep
from ..tasks.payloads import request_reader

router = APIRouter()


def _owned(ctx: AppContextDep, request: Request, project_id: str, *, writable: bool = False) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    if names_no_uuid_row(ctx.project_store.engine, project_id):
        raise HTTPException(404, "project_not_found")
    project = ctx.project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "project_not_found")
    if project["ownerUserId"] != actor["userId"]:
        raise HTTPException(403, "project_forbidden")
    if writable and (code := project_work_error(project)):
        raise HTTPException(409, code)
    return project


@router.get("/projects/{project_id}/manager")
def get_manager(project_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return manager_view(ctx, _owned(ctx, request, project_id))


@router.put("/projects/{project_id}/manager")
def set_manager(project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    project = _owned(ctx, request, project_id, writable=True)
    agent_id = _request_body.get("agentId")
    if not isinstance(agent_id, str) or agent_id not in [a["id"] for a in manager_candidates(ctx, project)]:
        raise HTTPException(400, "manager_agent_ineligible")
    version = _request_body.get("expectedVersion")
    if not isinstance(version, int) or isinstance(version, bool):
        raise HTTPException(400, "project_expected_version_required")
    try:
        project = ctx.project_store.update_project(project_id, manager_role_patch(ctx, project, agent_id), expected_version=version)
    except ProjectVersionConflict as error:
        raise HTTPException(409, "project_version_conflict") from error
    except ManagerError as error:
        raise HTTPException(error.status, error.code) from error
    return manager_view(ctx, project)


@router.get("/projects/{project_id}/manager/overview")
def overview(project_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return manager_overview(ctx, _owned(ctx, request, project_id))


@router.post("/projects/{project_id}/manager/conversation")
def manager_conversation(project_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    project = _owned(ctx, request, project_id)
    view = manager_view(ctx, project)
    project = view["project"]
    if project.get("managerThreadId"):
        return {"threadId": project["managerThreadId"]}
    if not project.get("managerAgentId"):
        raise HTTPException(409, "manager_unconfigured")
    try:
        _, thread_id = ensure_manager_thread(ctx, project)
    except ManagerError as error:
        raise HTTPException(error.status, error.code) from error
    return {"threadId": thread_id}


@router.post("/projects/{project_id}/manager/messages", status_code=202)
async def manager_message(project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    project = _owned(ctx, request, project_id, writable=True)
    text = _request_body.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 20000:
        raise HTTPException(400, "manager_message_invalid")
    key = _request_body.get("idempotencyKey")
    if not isinstance(key, str) or not 1 <= len(key) <= 200:
        raise HTTPException(400, "manager_idempotency_key_required")
    view = await run_in_threadpool(manager_view, ctx, project)
    if view["manager"]["reason"]:
        raise HTTPException(409, view["manager"]["reason"])
    try:
        project, thread_id = await run_in_threadpool(ensure_manager_thread, ctx, view["project"])
        session = await CollaborationConductor(ctx).submit(RunIntent(
            task_goal=text.strip(), session_id=thread_id, requested_project_id=project_id,
            raw_assignments=[{"agentId": project["managerAgentId"], "mode": "action"}],
            source="project_manager", idempotency_key=key,
        ), request_actor(request, ctx.auth_store))
    except (ManagerError, CollaborationError) as error:
        raise HTTPException(error.status, error.code) from error
    return {"threadId": session["id"], "project": project}


@router.post("/projects/{project_id}/manager/proposals/{proposal_id}/apply")
def apply_changes(project_id: str, proposal_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    project = _owned(ctx, request, project_id, writable=True)
    try:
        return apply_proposal(ctx, request_actor(request, ctx.auth_store), project, proposal_id, _request_body, request_reader())
    except ManagerError as error:
        raise HTTPException(error.status, error.code) from error
    except (TaskRequestError, PrerequisiteError) as error:
        raise HTTPException(error.status, getattr(error, "detail", str(error))) from error


@router.post("/projects/{project_id}/manager/proposals/{proposal_id}/dismiss")
def dismiss_changes(project_id: str, proposal_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    _owned(ctx, request, project_id, writable=True)
    with ctx.project_store.manager_transaction(project_id):
        proposal = ctx.project_store.manager_proposal(project_id, proposal_id)
        if not proposal:
            raise HTTPException(404, "proposal_not_found")
        if proposal["state"] != "pending":
            raise HTTPException(409, "manager_proposal_stale")
        proposal = {**proposal, "state": "dismissed", "revision": proposal["revision"] + 1,
                    "dismissedBy": request_actor(request, ctx.auth_store)["userId"]}
        ctx.project_store.save_manager_proposal(proposal)
    return {"proposal": proposal}


@router.post("/daemon-nodes/{sandbox_id}/project-manager/tools")
def manager_tool(sandbox_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    try:
        ctx.registry.assert_node_authenticated(sandbox_id, bearer_token(request))
    except DeletedDaemonNodeError as error:
        raise HTTPException(410, "Daemon node deleted.") from error
    except (PermissionError, KeyError) as error:
        raise HTTPException(401, "Unauthorized daemon node.") from error
    command_id, lease_id = _request_body.get("commandId"), _request_body.get("leaseId")
    if not isinstance(command_id, str) or not isinstance(lease_id, str) or not command_id or not lease_id:
        raise HTTPException(400, "manager_command_required")
    record = ctx.daemon_store.get_command(command_id)
    if not record or record["nodeId"] != sandbox_id or record["status"] != "dispatched" or record.get("leaseId") != _request_body.get("leaseId"):
        raise HTTPException(409, "manager_command_inactive")
    command = record["command"]
    active = ctx.daemon_store.active_run_request_for_session_any_node(command["sessionId"])
    if not active or active.get("currentCommandId") != command_id or active.get("status") != "running":
        raise HTTPException(409, "manager_command_inactive")
    scope = command.get("state", {}).get("project_manager") or {}
    project = ctx.project_store.get_project(scope.get("projectId", "")) if scope else None
    if not project or command.get("logicalAgentId") != scope.get("agentId") or command["sessionId"] != project.get("managerThreadId"):
        raise HTTPException(403, "manager_scope_required")
    if code := project_work_error(project):
        raise HTTPException(409, code)
    arguments = _request_body.get("arguments", {})
    if not isinstance(arguments, dict):
        raise HTTPException(400, "manager_arguments_invalid")
    if "projectId" in arguments and arguments["projectId"] != project["id"]:
        raise HTTPException(403, "manager_project_mismatch")
    try:
        if _request_body.get("tool") == "workspace":
            return {"authorized": True}
        if _request_body.get("tool") == "propose":
            return {"proposal": stage_proposal(ctx, project, command, arguments.get("operations"))}
        return read_manager_tool(ctx, project, _request_body.get("tool", ""), arguments)
    except ManagerError as error:
        raise HTTPException(error.status, error.code) from error
