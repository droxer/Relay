from __future__ import annotations

from typing import Any
from ...projects.manager import initial_manager_id, manager_role_patch, ManagerError

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ...core.ids import new_database_id
from ...persistence.project.store import ProjectValidationError, ProjectVersionConflict
from ...projects.catalog import (
    create_project_payload,
    resolve_target_node_id,
    update_project_payload,
)
from ...projects.runtime import project_runtime_node
from ...core.daemon_capabilities import (
    has_capability,
    DAEMON_CAPABILITY_WORKSPACE_READ_SHARED,
)
from ...projects.deletion import (
    ProjectDeletionError,
    delete_project as delete_project_record,
)
from ..deps import AppContextDep
from ..actors import request_actor
from ..bodies import JsonBodyDep
from .setup_task import close_setup_task
from .access import project_for_owner, require_owned_project
from .links import (
    link_existing_directory,
    new_linked_workspace_subpath,
    requested_host_path,
)
from ..computers.workspace_transport import (
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
    if project.get("ownerUserId") != actor["userId"]:
        raise HTTPException(403, "Project belongs to another user.")
    return project


def _project_workspace_node(
    ctx: AppContextDep, project: dict[str, Any]
) -> dict[str, Any]:
    node = project_runtime_node(project, ctx.registry.monitor_nodes())
    if node is None or not has_capability(node, DAEMON_CAPABILITY_WORKSPACE_READ_SHARED):
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
    try:
        candidate = {**payload, "ownerUserId": actor["userId"]}
        # The legacy manager choice assigns the Project Lead; null keeps the supplied lead.
        selected = initial_manager_id(ctx, candidate, body.get("managerAgentId"))
        if selected:
            payload.update(manager_role_patch(ctx, candidate, selected))
    except ManagerError as error:
        raise HTTPException(error.status, error.code) from error
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
    current = require_owned_project(ctx, project_id, actor["userId"])
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
    if "setupResolution" in body:
        # Applying or dismissing the proposal ends its drafting task.
        close_setup_task(ctx, project.get("setup"))
    return {"project": project}


@router.post("/projects/{project_id}/archive")
def archive_project(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    project_for_owner(ctx, project_id, actor["userId"])
    expected_version = _required_expected_version(request)
    try:
        project = ctx.project_store.archive_project(
            project_id, expected_version=expected_version
        )
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except (ProjectValidationError, ProjectVersionConflict, ValueError) as error:
        raise _project_error(error) from error
    return {"project": project}


@router.post("/projects/{project_id}/unarchive")
def unarchive_project(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    # The owner rule without the live-project filter: only an archived
    # project can be reopened, and only by the person who owns it.
    project = ctx.project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    if project.get("ownerUserId") != actor["userId"]:
        raise HTTPException(403, "Project belongs to another user.")
    expected_version = _required_expected_version(request)
    try:
        project = ctx.project_store.unarchive_project(
            project_id, expected_version=expected_version
        )
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except (ProjectValidationError, ProjectVersionConflict, ValueError) as error:
        raise _project_error(error) from error
    return {"project": project}


def _required_expected_version(request: Request) -> int:
    raw_version = request.query_params.get("expectedVersion")
    try:
        expected_version = int(raw_version) if raw_version is not None else None
    except ValueError:
        expected_version = None
    if expected_version is None:
        raise HTTPException(400, "project_expected_version_required")
    return expected_version


PROJECT_DELETION_STATUS = {
    "project_delete_forbidden": 403,
    "project_delete_unsupported": 501,
    "project_cleanup_queue_full": 503,
}


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
            lifecycle=ctx.execution_lifecycle,
            automation_store=ctx.automation_store,
        )
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except ProjectVersionConflict as error:
        raise _project_error(error) from error
    except ProjectDeletionError as error:
        raise HTTPException(
            PROJECT_DELETION_STATUS.get(error.code, 409),
            {
                "code": error.code,
                "message": error.code,
                "sessionIds": error.session_ids,
                "taskIds": error.task_ids,
            },
        ) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
