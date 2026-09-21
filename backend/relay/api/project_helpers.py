from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from ..core.computer_identity import computer_id
from ..services.project_runtime import project_work_error
from .deps import AppContextDep


def project_for_owner(
    ctx: AppContextDep, project_id: str | None, owner_employee_id: str,
    *, require_enabled: bool = False,
) -> dict[str, Any] | None:
    if not project_id:
        return None
    project = ctx.project_store.get_project(project_id)
    if not project or project.get("archivedAt"):
        raise HTTPException(404, "Project not found.")
    if project.get("ownerEmployeeId") != owner_employee_id:
        raise HTTPException(403, "Project belongs to another employee.")
    if require_enabled and (code := project_work_error(project)):
        raise HTTPException(409, code)
    return project


def ensure_task_project_writable(ctx: AppContextDep, task: dict[str, Any]) -> None:
    # Call only after task access is authorized. Do not apply this to internal
    # result/event recording: already admitted work may finish after archival.
    if project_id := task.get("projectId"):
        if code := project_work_error(ctx.project_store.get_project(project_id)):
            raise HTTPException(409, code)


def current_project_node(
    ctx: AppContextDep, project: dict[str, Any]
) -> dict[str, Any] | None:
    candidates = [
        node
        for node in ctx.registry.monitor_nodes()
        if not node.get("retiredAt") and computer_id(node) == project["computerId"]
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda node: (
            0
            if node.get("online")
            and not node.get("stale")
            and node.get("status") in ("ready", "busy", "running")
            else 1,
            node["id"],
        ),
    )


def project_session_fields(
    ctx: AppContextDep, project: dict[str, Any]
) -> dict[str, Any]:
    node = current_project_node(ctx, project)
    return {
        "project_id": project["id"],
        "workspace_layout": "project",
        "workspace_subpath": project["workspaceSubpath"],
        "computer_id": project["computerId"],
        "workspace_path": (node or {}).get("workspacePath") or "/workspace",
    }


def ensure_project_node_matches(
    project: dict[str, Any], node: dict[str, Any] | None
) -> None:
    if node is not None and computer_id(node) != project["computerId"]:
        raise HTTPException(409, "project_computer_mismatch")
