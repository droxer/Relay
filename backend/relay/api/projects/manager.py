"""Owner-facing manager conversations and command-scoped daemon tools."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from ...collaboration.models import RunIntent
from ...collaboration.service import CollaborationConductor
from ...collaboration.errors import CollaborationError
from ...projects.manager import ManagerError, ensure_manager_thread, manager_candidates, manager_view
from ...projects.manager_reads import manager_overview, read_manager_tool
from ...projects.manager_proposals import apply_proposal, stage_proposal
from ...projects.runtime import project_work_error
from ...tasks.requests import TaskRequestError
from ...tasks.prerequisites import PrerequisiteError
from ...persistence.project.store import ProjectVersionConflict
from ..actors import bearer_token, request_actor
from ..bodies import JsonBodyDep
from ..deps import AppContextDep
from ..tasks.payloads import request_reader
from .access import project_for_owner

router = APIRouter()


def _owned(ctx: AppContextDep, request: Request, project_id: str, *, writable: bool = False) -> dict[str, Any]:
    project = project_for_owner(ctx, project_id, request_actor(request, ctx.auth_store)["userId"])
    if not project:
        raise HTTPException(404, "project_not_found")
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
    if agent_id not in [a["id"] for a in manager_candidates(ctx, project)]:
        raise HTTPException(400, "manager_agent_ineligible")
    version = _request_body.get("expectedVersion")
    if not isinstance(version, int) or isinstance(version, bool):
        raise HTTPException(400, "project_expected_version_required")
    try:
        project = ctx.project_store.update_project(project_id, {"managerAgentId": agent_id, "managerInitialized": True}, expected_version=version)
    except ProjectVersionConflict as error:
        raise HTTPException(409, "project_version_conflict") from error
    return manager_view(ctx, project)


@router.get("/projects/{project_id}/manager/overview")
def overview(project_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    return manager_overview(ctx, _owned(ctx, request, project_id))


@router.post("/projects/{project_id}/manager/messages", status_code=202)
async def manager_message(project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    project = _owned(ctx, request, project_id, writable=True)
    text = _request_body.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 20000:
        raise HTTPException(400, "manager_message_invalid")
    view = await run_in_threadpool(manager_view, ctx, project)
    if view["manager"]["reason"]:
        raise HTTPException(409, view["manager"]["reason"])
    try:
        project, thread_id = await run_in_threadpool(ensure_manager_thread, ctx, view["project"])
        session = await CollaborationConductor(ctx).submit(RunIntent(
            task_goal=text.strip(), session_id=thread_id, requested_project_id=project_id,
            raw_assignments=[{"agentId": project["managerAgentId"], "mode": "action"}],
            source="project_manager", idempotency_key=_request_body.get("idempotencyKey"),
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
    except (PermissionError, KeyError) as error:
        raise HTTPException(401, "Unauthorized daemon node.") from error
    record = ctx.daemon_store.get_command(_request_body.get("commandId", ""))
    if not record or record["nodeId"] != sandbox_id or record["status"] != "dispatched" or record.get("leaseId") != _request_body.get("leaseId"):
        raise HTTPException(409, "manager_command_inactive")
    command = record["command"]
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
