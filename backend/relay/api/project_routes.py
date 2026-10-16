from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ..core.ids import new_database_id
from ..persistence.project_store import (
    ProjectValidationError,
    ProjectVersionConflict,
)
from ..services.project_catalog import (
    create_project_payload,
    resolve_target_node_id,
    update_project_payload,
)
from ..collaboration.models import RunIntent
from ..collaboration.service import CollaborationConductor, CollaborationError
from ..services.project_runtime import project_runtime_node, project_work_error
from ..services.project_setup import (
    PROJECT_SETUP_CAPABILITY,
    ProjectSetupError,
    annotate_setup,
    choose_setup_agent,
    drafting_setup,
    setup_candidates,
    setup_in_progress,
    setup_intent,
    setup_manifest_block,
    setup_task_goal,
)
from ..services.project_deletion import delete_project as delete_project_record
from .deps import AppContextDep
from .helpers import JsonBodyDep, request_actor
from .project_helpers import project_for_owner
from .project_links import (
    link_existing_directory,
    new_linked_workspace_subpath,
    requested_host_path,
)
from .workspace_transport import (
    dispatch_workspace_command,
    live_workspace_file,
    live_workspace_listing,
    raise_workspace_error,
    workspace_path,
)

router = APIRouter()


def _project_error(error: Exception) -> HTTPException:
    if isinstance(error, ProjectVersionConflict):
        return HTTPException(409, "project_version_conflict")
    code = error.code if isinstance(error, ProjectValidationError) else str(error)
    return HTTPException(409 if code == "project_name_taken" else 400, code)


def _readable_project(
    ctx: AppContextDep, request: Request, project_id: str
) -> dict[str, Any]:
    """Return an owner-visible project, including an archived project."""
    actor = request_actor(request, ctx.auth_store)
    project = ctx.project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    if not actor["isAdmin"] and project.get("ownerUserId") != actor["userId"]:
        raise HTTPException(403, "Project belongs to another user.")
    return project


def _project_workspace_node(
    ctx: AppContextDep, project: dict[str, Any]
) -> dict[str, Any]:
    node = project_runtime_node(project, ctx.registry.monitor_nodes())
    if node is None or "workspace-read-shared" not in (node.get("capabilities") or []):
        raise HTTPException(503, {"reason": "placement-unavailable"})
    return node


def _project_workspace_command(
    project: dict[str, Any], *, command_id: str, command_type: str, path: str
) -> dict[str, Any]:
    return {
        "id": command_id,
        "type": command_type,
        # Project ids use the same validated database-id alphabet as sessions.
        # The daemon only uses this field as a routing identifier for project
        # layouts; workspaceSubpath selects the persistent project root.
        "sessionId": project["id"],
        "workspaceLayout": "project",
        "workspaceSubpath": project["workspaceSubpath"],
        "path": path,
    }


@router.get("/projects")
def list_projects(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    return {
        "projects": ctx.project_store.list_projects(
            actor["userId"], include_archived=True
        )
    }


@router.post("/projects/workspace-check")
async def check_project_workspace(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    """Ask the selected computer whether an existing directory may be linked."""
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    body = _request_body
    host_path = requested_host_path(body)
    if host_path is None:
        raise HTTPException(400, "project_workspace_path_invalid")
    canonical = await link_existing_directory(
        ctx,
        owner_user_id=actor["userId"],
        node_id=body.get("daemonNodeId"),
        host_path=host_path,
        workspace_subpath=new_linked_workspace_subpath(),
        dry_run=True,
    )
    return {"workspaceHostPath": canonical}


@router.post("/projects", status_code=201)
async def create_project(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    body = _request_body
    host_path = requested_host_path(body)
    try:
        payload = await run_in_threadpool(
            create_project_payload,
            actor["userId"],
            body,
            registry=ctx.registry,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        )
    except (ProjectValidationError, ProjectVersionConflict, ValueError) as error:
        raise _project_error(error) from error
    if host_path is not None:
        # The computer validates and records the link before the project
        # exists, so the project's first run already finds its directory.
        workspace_subpath = new_linked_workspace_subpath()
        canonical = await link_existing_directory(
            ctx,
            owner_user_id=actor["userId"],
            node_id=body.get("daemonNodeId"),
            host_path=host_path,
            workspace_subpath=workspace_subpath,
        )
        payload = {
            **payload,
            "workspaceSubpath": workspace_subpath,
            "workspaceHostPath": canonical,
        }
    try:
        project = await run_in_threadpool(
            ctx.project_store.create_project, actor["userId"], payload
        )
    except (ProjectValidationError, ProjectVersionConflict, ValueError) as error:
        raise _project_error(error) from error
    return {"project": project}


@router.get("/projects/{project_id}")
def get_project(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    return {"project": _readable_project(ctx, request, project_id)}


@router.get("/projects/{project_id}/workspace/files")
async def project_workspace_files(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    project = _readable_project(ctx, request, project_id)
    path = workspace_path(request.query_params.get("path"))
    node = _project_workspace_node(ctx, project)
    event = await dispatch_workspace_command(
        ctx,
        node,
        _project_workspace_command(
            project,
            command_id=new_database_id(),
            command_type="workspace.list",
            path=path,
        ),
    )
    raise_workspace_error(event)
    return live_workspace_listing(
        event,
        path=path,
        metadata={
            "projectId": project["id"],
            "scope": "shared",
            "nodeId": node["id"],
        },
    )


@router.get("/projects/{project_id}/workspace/file")
async def project_workspace_file(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    project = _readable_project(ctx, request, project_id)
    path = workspace_path(request.query_params.get("path"), required=True)
    node = _project_workspace_node(ctx, project)
    event = await dispatch_workspace_command(
        ctx,
        node,
        _project_workspace_command(
            project,
            command_id=new_database_id(),
            command_type="workspace.read",
            path=path,
        ),
    )
    raise_workspace_error(event)
    return live_workspace_file(
        event,
        path=path,
        metadata={
            "projectId": project["id"],
            "scope": "shared",
            "nodeId": node["id"],
        },
    )


@router.patch("/projects/{project_id}")
def update_project(
    project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = project_for_owner(ctx, project_id, actor["userId"])
    body = _request_body
    try:
        target_node_id = resolve_target_node_id(
            ctx.registry.monitor_nodes(), current["computerId"]
        )
        patch, expected_version = update_project_payload(
            actor["userId"],
            current,
            body,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
            target_node_id=target_node_id,
        )
        project = ctx.project_store.update_project(
            project_id, patch, expected_version=expected_version
        )
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except (ProjectValidationError, ProjectVersionConflict, ValueError) as error:
        raise _project_error(error) from error
    return {"project": project}


@router.get("/projects/{project_id}/setup")
def get_project_setup(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """The project's agent-drafted setup, with each proposed member's current
    eligibility, and the agents a setup could staff."""
    actor = request_actor(request, ctx.auth_store)
    project = project_for_owner(ctx, project_id, actor["userId"])
    return {
        "setup": annotate_setup(
            project,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        ),
        "candidates": setup_candidates(
            project,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        ),
    }


@router.post("/projects/{project_id}/setup", status_code=202)
async def start_project_setup(
    project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    """Ask an agent on the project's computer to draft the project's setup.

    With `revise: true` the same thread drafts again from the last proposal
    and the owner's note; otherwise a fresh setup thread starts.
    """
    actor = request_actor(request, ctx.auth_store)
    project = project_for_owner(ctx, project_id, actor["userId"])
    body = _request_body
    if code := project_work_error(project):
        raise HTTPException(409, code)
    try:
        intent = setup_intent(body.get("intent"))
        candidates = setup_candidates(
            project,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        )
        previous = project.get("setup") or None
        revising = bool(body.get("revise")) and bool(previous and previous.get("threadId"))
        if setup_in_progress(previous, ctx.session_store):
            raise ProjectSetupError("project_setup_in_progress")
        agent_id = choose_setup_agent(
            candidates,
            body.get("agentId") or (previous.get("agentId") if revising else None),
            lead_agent_id=project.get("leadAgentId"),
        )
        node = project_runtime_node(project, ctx.registry.monitor_nodes())
        if node is None:
            raise ProjectSetupError("project_computer_offline")
        if PROJECT_SETUP_CAPABILITY not in (node.get("capabilities") or []):
            raise ProjectSetupError("project_setup_unsupported")
    except ProjectSetupError as error:
        raise HTTPException(error.status, error.code) from error
    previous_proposal = (previous or {}).get("proposal") if revising else None
    thread_id = previous["threadId"] if revising else None
    # Record the draft before dispatch so a fast result always finds it.
    draft = drafting_setup(
        intent=intent, agent_id=agent_id, thread_id=thread_id, previous=previous if revising else None,
    )

    def claim_draft(latest: dict[str, Any]) -> dict[str, Any]:
        if code := project_work_error(latest):
            raise ProjectSetupError(code)
        if setup_in_progress(latest.get("setup"), ctx.session_store):
            raise ProjectSetupError("project_setup_in_progress")
        if (latest.get("setup") or None) != previous:
            raise ProjectVersionConflict(project_id)
        return draft

    _mutate_setup(ctx, project_id, claim_draft)
    try:
        session = await CollaborationConductor(ctx).submit(
            RunIntent(
                task_goal=setup_task_goal(intent, revising=revising),
                session_id=thread_id,
                raw_assignments=[{"agentId": agent_id, "mode": "action"}],
                requested_project_id=project_id,
                idempotency_key=body.get("idempotencyKey") if isinstance(body.get("idempotencyKey"), str) else None,
                source="project_setup",
                project_setup=setup_manifest_block(
                    intent=intent,
                    candidates=candidates,
                    previous_proposal=previous_proposal,
                    draft_id=draft["draftId"],
                ),
            ),
            actor,
        )
    except CollaborationError as error:
        # Undo only our own draft: a revise falls back to the setup it was
        # revising, a fresh start is marked failed so it never waits forever.
        def restore(latest: dict[str, Any]) -> dict[str, Any] | None:
            current = latest.get("setup") or {}
            if current.get("state") != "drafting" or current.get("draftId") != draft["draftId"]:
                return None
            return previous if revising and previous else {**current, "state": "failed", "error": error.code}

        _mutate_setup(ctx, project_id, restore)
        detail: Any = str(error) if error.status in (400, 403) else {"code": error.code, "message": str(error)}
        raise HTTPException(error.status, detail) from error

    def attach_thread(latest: dict[str, Any]) -> dict[str, Any] | None:
        current = latest.get("setup") or {}
        if (
            current.get("state") != "drafting"
            or current.get("draftId") != draft["draftId"]
            or current.get("threadId") == session["id"]
        ):
            return None
        return {**current, "threadId": session["id"]}

    project = _mutate_setup(ctx, project_id, attach_thread)
    return {"project": project, "threadId": session["id"]}


def _mutate_setup(
    ctx: Any, project_id: str, change: Callable[[dict[str, Any]], dict[str, Any] | None]
) -> dict[str, Any]:
    try:
        return ctx.project_store.mutate_setup(project_id, change)
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except ProjectVersionConflict as error:
        raise _project_error(error) from error
    except ProjectSetupError as error:
        raise HTTPException(error.status, error.code) from error


@router.post("/projects/{project_id}/archive")
def archive_project(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    project_for_owner(ctx, project_id, actor["userId"])
    raw_version = request.query_params.get("expectedVersion")
    try:
        expected_version = int(raw_version) if raw_version is not None else None
    except ValueError:
        expected_version = None
    if expected_version is None:
        raise HTTPException(400, "project_expected_version_required")
    try:
        project = ctx.project_store.archive_project(
            project_id, expected_version=expected_version
        )
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except (ProjectValidationError, ProjectVersionConflict, ValueError) as error:
        raise _project_error(error) from error
    return {"project": project}


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    project = _readable_project(ctx, request, project_id)
    if project["ownerUserId"] != actor["userId"]:
        raise HTTPException(403, "Project belongs to another user.")
    try:
        expected_version = int(request.query_params.get("expectedVersion", ""))
    except ValueError as error:
        raise HTTPException(400, "project_expected_version_required") from error
    try:
        return delete_project_record(
            ctx, project_id, expected_version=expected_version,
            user_id=actor["userId"],
            lifecycle=request.app.state.execution_lifecycle,
        )
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except ProjectVersionConflict as error:
        raise _project_error(error) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
