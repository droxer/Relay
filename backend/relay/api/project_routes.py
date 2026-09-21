from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

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
from ..services.project_runtime import project_runtime_node
from ..services.project_deletion import delete_project as delete_project_record
from .deps import AppContextDep
from .helpers import JsonBodyDep, request_actor
from .project_helpers import project_for_owner
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
    if not actor["isAdmin"] and project.get("ownerEmployeeId") != actor["employeeId"]:
        raise HTTPException(403, "Project belongs to another employee.")
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
            actor["employeeId"], include_archived=True
        )
    }


@router.post("/projects", status_code=201)
def create_project(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = _request_body
    try:
        payload = create_project_payload(
            actor["employeeId"],
            body,
            registry=ctx.registry,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        )
        project = ctx.project_store.create_project(actor["employeeId"], payload)
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
    current = project_for_owner(ctx, project_id, actor["employeeId"])
    body = _request_body
    try:
        target_node_id = resolve_target_node_id(
            ctx.registry.monitor_nodes(), current["computerId"]
        )
        patch, expected_version = update_project_payload(
            actor["employeeId"],
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


@router.post("/projects/{project_id}/archive")
def archive_project(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    project_for_owner(ctx, project_id, actor["employeeId"])
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
    if project["ownerEmployeeId"] != actor["employeeId"]:
        raise HTTPException(403, "Project belongs to another employee.")
    try:
        expected_version = int(request.query_params.get("expectedVersion", ""))
    except ValueError as error:
        raise HTTPException(400, "project_expected_version_required") from error
    try:
        return delete_project_record(
            ctx, project_id, expected_version=expected_version,
            employee_id=actor["employeeId"],
            lifecycle=request.app.state.execution_lifecycle,
        )
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except ProjectVersionConflict as error:
        raise _project_error(error) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
