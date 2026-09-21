"""Atomic project removal and durable execution-plane workspace cleanup."""
from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select

from ..core.computer_identity import computer_id
from ..core.ids import new_database_id
from ..persistence.project_store import ProjectVersionConflict
from ..persistence.store_common import store_transaction
from ..persistence.task_store import dispatch_claim_active
from ..sessions.controller import SessionController, SessionRunInFlightError
from .task_deletion import task_has_active_linked_session


class ProjectDeletionError(ValueError):
    pass


def delete_project(
    ctx: Any,
    project_id: str,
    *,
    expected_version: int,
    employee_id: str,
    lifecycle: Any,
) -> dict[str, Any]:
    projects = ctx.project_store
    sessions = ctx.session_store
    tasks = ctx.task_store
    # Local command storage cannot join SQL transactions; delivery additionally
    # checks the committed absence of this project, including after a crash.
    stores = (sessions, tasks, ctx.daemon_store)
    if any(getattr(store, "engine", projects.engine) is not projects.engine for store in stores):
        raise RuntimeError("Project deletion requires a shared database.")
    initial = projects.get_project(project_id)
    if initial is None:
        raise KeyError(project_id)
    nodes = [
        node for node in ctx.registry.monitor_nodes()
        if computer_id(node) == initial["computerId"]
        and not node.get("retiredAt")
        and "project-workspace-delete" in (node.get("capabilities") or [])
    ]
    if not nodes:
        raise ProjectDeletionError("project_cleanup_unavailable")
    node = min(nodes, key=lambda node: (not node.get("online"), node["id"]))
    with (
        ctx.registry.dispatch_lock,
        ctx.registry.dispatch_scope([node["id"]]),
        lifecycle.admission_scope(),
        store_transaction(projects.engine) as conn,
    ):
        project = conn.execute(
            select(projects.projects.c.snapshot)
            .where(projects.projects.c.id == project_id)
            .with_for_update()
        ).scalar_one_or_none()
        if project is None:
            raise KeyError(project_id)
        if project["ownerEmployeeId"] != employee_id:
            raise ProjectDeletionError("project_delete_forbidden")
        if project["version"] != expected_version:
            raise ProjectVersionConflict(project_id)
        if project["workspaceSubpath"] != f"projects/{project_id}":
            raise ProjectDeletionError("project_workspace_invalid")
        project_tasks = conn.execute(
            select(tasks.tasks.c.snapshot)
            .where(tasks.tasks.c.project_id == project_id)
            .order_by(tasks.tasks.c.id).with_for_update()
        ).scalars().all()
        project_sessions = conn.execute(
            select(sessions.sessions.c.snapshot)
            .where(sessions.sessions.c.project_id == project_id)
            .order_by(sessions.sessions.c.id).with_for_update()
        ).scalars().all()
        if any(
            dispatch_claim_active(task) or task_has_active_linked_session(
                sessions, task, execution_lifecycle=lifecycle
            ) for task in project_tasks
        ) or any(not lifecycle.status(session)["canDelete"] for session in project_sessions):
            raise ProjectDeletionError("project_execution_active")
        controller = SessionController(sessions, task_store=tasks)
        for session in project_sessions:
            try:
                controller.delete_session(
                    session["id"], snapshot=session, deleted_by=employee_id
                )
            except SessionRunInFlightError as error:
                raise ProjectDeletionError("project_execution_active") from error
        task_ids = [task["id"] for task in project_tasks]
        # Apply the authoritative deletion event before purging task history.
        for task in project_tasks:
            tasks.delete_task(task["id"], deleted_by=employee_id, reject_active_claim=True)
        for table in (tasks.task_sessions, tasks.events):
            conn.execute(delete(table).where(table.c.task_id.in_(task_ids)))
        conn.execute(delete(tasks.tasks).where(tasks.tasks.c.id.in_(task_ids)))
        for table in (projects.members, projects.events_table):
            conn.execute(delete(table).where(table.c.project_id == project_id))
        conn.execute(delete(projects.projects).where(projects.projects.c.id == project_id))
        command_id = new_database_id()
        # Polling discovers this durable command without replica-local state.
        ctx.daemon_store.enqueue_command(node["id"], {
            "id": command_id,
            "type": "workspace.delete",
            "sessionId": project_id,
            "workspaceLayout": "project",
            "workspaceSubpath": project["workspaceSubpath"],
            "path": "",
        })
    # File-backed chat bindings must only change after SQL commits.
    for session in project_sessions:
        ctx.chat_store.clear_conversation_sessions(session["id"])
    return {
        "deletedProjectId": project_id,
        "workspaceCleanup": "queued",
        "cleanupCommandId": command_id,
    }
