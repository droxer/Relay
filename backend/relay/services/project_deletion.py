"""Atomic project removal and durable execution-plane workspace cleanup."""
from __future__ import annotations

from typing import Any

from loguru import logger
from sqlalchemy import delete, select

from ..core.ids import new_database_id
from ..daemon_registry.records import WORKSPACE_DELETE_COMMAND
from ..core.daemon_capabilities import (
    DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE,
    has_capability,
)
from ..persistence.project_store import ProjectVersionConflict
from ..core.workspace_layout import LINKED_WORKSPACE_PREFIX
from ..persistence.resource_lock import resource_transaction
from ..persistence.store_common import store_transaction
from ..persistence.task.rules import dispatch_claim_active
from ..sessions.controller import SessionController, SessionRunInFlightError
from .task_deletion import TASK_DELETION_LOCK, task_has_active_linked_session

# What happens to the project's files once its records are gone.
CLEANUP_KEPT = "kept"  # a linked directory belongs to the user
CLEANUP_QUEUED = "queued"  # a live node that can delete it will
CLEANUP_WAITING_FOR_UPGRADE = "waiting_for_upgrade"  # the live node is too old
CLEANUP_WAITING_FOR_COMPUTER = "waiting_for_computer"  # runs when the computer re-enrolls
CLEANUP_ORPHANED = "orphaned"  # Relay no longer knows the computer


class ProjectDeletionError(ValueError):
    def __init__(
        self,
        code: str,
        *,
        session_ids: list[str] | None = None,
        task_ids: list[str] | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.session_ids = session_ids or []
        self.task_ids = task_ids or []


def delete_project(
    ctx: Any,
    project_id: str,
    *,
    expected_version: int,
    user_id: str,
    lifecycle: Any,
    automation_store: Any = None,
) -> dict[str, Any]:
    engine = _shared_engine(ctx)
    initial = ctx.project_store.get_project(project_id)
    if initial is None:
        raise KeyError(project_id)
    _assert_deletable(initial, project_id, expected_version, user_id)
    _assert_workspace(initial, project_id)
    # A linked directory existed before the project and belongs to the user;
    # deleting the project forgets the link and never removes the directory.
    linked = initial["workspaceSubpath"].startswith(LINKED_WORKSPACE_PREFIX)
    node, cleanup = (None, CLEANUP_KEPT) if linked else _cleanup_target(
        ctx.registry, initial["computerId"]
    )
    with (
        ctx.registry.dispatch_lock,
        ctx.registry.dispatch_scope([node["id"]] if node else []),
        lifecycle.admission_scope(),
    ):
        _settle_threads(ctx, engine, project_id, user_id, lifecycle)
        # Take the task-deletion lock first, like every task cascade, so a
        # concurrent task delete sharing one of these threads cannot deadlock.
        with resource_transaction(engine, TASK_DELETION_LOCK) as conn:
            project = _lock_project(conn, ctx, project_id, expected_version, user_id)
            if project["workspaceSubpath"] != initial["workspaceSubpath"]:
                raise ProjectDeletionError("project_workspace_invalid")
            removed = _delete_records(conn, ctx, project_id, user_id, lifecycle)
            command_id, cleanup = _queue_cleanup(ctx, project, node, cleanup)
    if cleanup == CLEANUP_WAITING_FOR_COMPUTER:
        cleanup = _adopt_by_live_node(ctx.registry, initial["computerId"], cleanup)
    _forget_after_commit(ctx, automation_store, removed)
    return {
        "deletedProjectId": project_id,
        "workspaceCleanup": cleanup,
        "cleanupCommandId": command_id,
        "detachedTaskIds": removed["detachedTaskIds"],
    }


def _shared_engine(ctx: Any) -> Any:
    engine = getattr(ctx.project_store, "engine", None)
    # Local command storage cannot join SQL transactions; delivery additionally
    # checks the committed absence of this project, including after a crash.
    stores = (ctx.session_store, ctx.task_store, ctx.daemon_store)
    if engine is None or any(
        getattr(store, "engine", engine) is not engine for store in stores
    ):
        raise ProjectDeletionError("project_delete_unsupported")
    return engine


def _assert_deletable(
    project: dict[str, Any], project_id: str, expected_version: int, user_id: str
) -> None:
    if project["ownerUserId"] != user_id:
        raise ProjectDeletionError("project_delete_forbidden")
    if project["version"] != expected_version:
        raise ProjectVersionConflict(project_id)


def _assert_workspace(project: dict[str, Any], project_id: str) -> None:
    subpath = project["workspaceSubpath"]
    if not subpath.startswith(LINKED_WORKSPACE_PREFIX) and subpath != f"projects/{project_id}":
        raise ProjectDeletionError("project_workspace_invalid")


def _cleanup_target(registry: Any, computer: str) -> tuple[dict[str, Any] | None, str]:
    """Pick the node record that will carry the cleanup, and say when it runs."""
    live = registry.live_cleanup_node(computer)
    if live is not None:
        capable = has_capability(live, DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE)
        return live, CLEANUP_QUEUED if capable else CLEANUP_WAITING_FOR_UPGRADE
    # The files outlive the node: queue on the newest retired record so a
    # re-enrolled node for this computer adopts the cleanup on registration.
    records = registry.computer_node_records(computer)
    if records:
        newest = max(records, key=lambda node: (node.get("updatedAt") or "", node["id"]))
        return newest, CLEANUP_WAITING_FOR_COMPUTER
    return None, CLEANUP_ORPHANED


def _project_sessions(
    conn: Any, sessions: Any, project_id: str, *, lock: bool
) -> list[dict[str, Any]]:
    statement = (
        select(sessions.sessions.c.snapshot)
        .where(sessions.sessions.c.project_id == project_id)
        .order_by(sessions.sessions.c.id)
    )
    return list(conn.execute(statement.with_for_update() if lock else statement).scalars())


def _settle_threads(
    ctx: Any, engine: Any, project_id: str, user_id: str, lifecycle: Any
) -> None:
    """Apply what deleting each thread on its own would, before the cascade.

    Deleting the project is the person's assertion that a run Relay already
    gave up on is gone, exactly as deleting that one thread would be. Live
    runs are never stopped here, and every refusal that can be known now is
    raised before anything is asserted, so a refused delete leaves every
    thread as it was. Only a full cleanup queue is discovered later.
    """
    tasks = ctx.task_store
    with store_transaction(engine) as conn:
        sessions = _project_sessions(conn, ctx.session_store, project_id, lock=False)
        project_tasks = conn.execute(
            select(tasks.tasks.c.snapshot).where(tasks.tasks.c.project_id == project_id)
        ).scalars().all()
    live_sessions = [session["id"] for session in sessions if _live(lifecycle, session)]
    live_tasks = [
        task["id"] for task in project_tasks
        if dispatch_claim_active(task) or any(
            _live(lifecycle, linked)
            for linked in _linked_sessions(ctx.session_store, task)
        )
    ]
    if live_sessions or live_tasks:
        raise ProjectDeletionError(
            "project_execution_active", session_ids=live_sessions, task_ids=live_tasks
        )
    for session in sessions:
        lifecycle.settle_for_deletion(session, user_id)


def _live(lifecycle: Any, session: dict[str, Any]) -> bool:
    """Blocks deletion even after settling: neither finished nor given up on."""
    status = lifecycle.status(session)
    return not status["canDelete"] and not status["canReportGone"]


def _linked_sessions(sessions: Any, task: dict[str, Any]) -> list[dict[str, Any]]:
    linked = []
    for session_id in task.get("linkedSessionIds", []):
        try:
            linked.append(sessions.get_session(session_id))
        except (KeyError, FileNotFoundError):
            continue
    return linked


def _lock_project(
    conn: Any, ctx: Any, project_id: str, expected_version: int, user_id: str
) -> dict[str, Any]:
    projects = ctx.project_store
    project = conn.execute(
        select(projects.projects.c.snapshot)
        .where(projects.projects.c.id == project_id)
        .with_for_update()
    ).scalar_one_or_none()
    if project is None:
        raise KeyError(project_id)
    _assert_deletable(project, project_id, expected_version, user_id)
    return project


def _assert_idle(
    ctx: Any, tasks: list[dict[str, Any]], sessions: list[dict[str, Any]], lifecycle: Any
) -> None:
    busy_sessions = [
        session["id"] for session in sessions if not lifecycle.status(session)["canDelete"]
    ]
    busy_tasks = [
        task["id"] for task in tasks
        if dispatch_claim_active(task) or task_has_active_linked_session(
            ctx.session_store, task, execution_lifecycle=lifecycle
        )
    ]
    if busy_sessions or busy_tasks:
        raise ProjectDeletionError(
            "project_execution_active", session_ids=busy_sessions, task_ids=busy_tasks
        )


def _detach_outside_tasks(
    conn: Any, tasks: Any, session_ids: list[str], project_task_ids: set[str], user_id: str
) -> list[str]:
    """Unlink tasks outside the project from its threads, keeping the tasks.

    Deleting a thread on its own drops a task it leaves threadless. A task in
    another project, or in no project, is not this deletion's to remove.
    """
    if not session_ids:
        return []
    links = conn.execute(
        select(tasks.task_sessions.c.task_id, tasks.task_sessions.c.session_id)
        .where(tasks.task_sessions.c.session_id.in_(session_ids))
        .order_by(tasks.task_sessions.c.task_id)
    ).all()
    detached: list[str] = []
    for raw_task_id, session_id in links:
        task_id = str(raw_task_id)
        if task_id in project_task_ids:
            continue
        tasks.unlink_session_in_transaction(conn, task_id, str(session_id), deleted_by=user_id)
        if task_id not in detached:
            detached.append(task_id)
    return detached


def _delete_records(
    conn: Any, ctx: Any, project_id: str, user_id: str, lifecycle: Any
) -> dict[str, Any]:
    projects, sessions, tasks = ctx.project_store, ctx.session_store, ctx.task_store
    project_tasks = conn.execute(
        select(tasks.tasks.c.snapshot)
        .where(tasks.tasks.c.project_id == project_id)
        .order_by(tasks.tasks.c.id).with_for_update()
    ).scalars().all()
    project_sessions = _project_sessions(conn, sessions, project_id, lock=True)
    _assert_idle(ctx, project_tasks, project_sessions, lifecycle)
    task_ids = [task["id"] for task in project_tasks]
    session_ids = [session["id"] for session in project_sessions]
    detached = _detach_outside_tasks(conn, tasks, session_ids, set(task_ids), user_id)
    controller = SessionController(sessions, task_store=tasks)
    for session in project_sessions:
        try:
            controller.delete_session(session["id"], snapshot=session, deleted_by=user_id)
        except SessionRunInFlightError as error:
            raise ProjectDeletionError(
                "project_execution_active", session_ids=[session["id"]]
            ) from error
    # Apply the authoritative deletion event before purging task history.
    for task in project_tasks:
        tasks.delete_task(task["id"], deleted_by=user_id, reject_active_claim=True)
    for table in (tasks.task_sessions, tasks.events):
        conn.execute(delete(table).where(table.c.task_id.in_(task_ids)))
    conn.execute(delete(tasks.tasks).where(tasks.tasks.c.id.in_(task_ids)))
    for table in (projects.members, projects.events_table):
        conn.execute(delete(table).where(table.c.project_id == project_id))
    conn.execute(delete(projects.projects).where(projects.projects.c.id == project_id))
    return {
        "sessionIds": session_ids,
        "routineIds": [task["id"] for task in project_tasks if task.get("isRoutine")],
        "detachedTaskIds": detached,
    }


def _queue_cleanup(
    ctx: Any, project: dict[str, Any], node: dict[str, Any] | None, cleanup: str
) -> tuple[str | None, str]:
    if node is None:
        return None, cleanup
    command_id = new_database_id()
    try:
        # Polling discovers this durable command without replica-local state.
        ctx.daemon_store.enqueue_command(node["id"], {
            "id": command_id,
            "type": WORKSPACE_DELETE_COMMAND,
            "sessionId": project["id"],
            "workspaceLayout": "project",
            "workspaceSubpath": project["workspaceSubpath"],
            "path": "",
        })
    except KeyError:
        # The node record vanished after it was chosen; nothing can carry it.
        logger.warning("Project cleanup has no node to run on", project_id=project["id"])
        return None, CLEANUP_ORPHANED
    except ValueError as error:
        raise ProjectDeletionError("project_cleanup_queue_full") from error
    return command_id, cleanup


def _adopt_by_live_node(registry: Any, computer: str, cleanup: str) -> str:
    """Hand a just-committed cleanup to a node that registered meanwhile.

    A successor that registered between choosing the retired target and the
    commit could not see the command, so it moved nothing; it is moved now.
    """
    live = registry.live_cleanup_node(computer)
    if live is None:
        return cleanup
    try:
        registry.rehome_workspace_cleanups(computer, live["id"])
    except Exception:  # noqa: BLE001 - post-delete cleanup is best-effort; the deletion already committed
        logger.exception("Failed to move project cleanup", computer_id=computer)
        return cleanup
    capable = has_capability(live, DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE)
    return CLEANUP_QUEUED if capable else CLEANUP_WAITING_FOR_UPGRADE


def _forget_after_commit(ctx: Any, automation_store: Any, removed: dict[str, Any]) -> None:
    """Drop state kept outside the SQL transaction.

    The deletion already committed, so a failure here is logged rather than
    reported as a failed delete. A chat binding left behind resolves to no
    session, which chat lookups already treat as unbound.
    """
    for session_id in removed["sessionIds"]:
        try:
            ctx.chat_store.clear_conversation_sessions(session_id)
        except Exception:  # noqa: BLE001 - post-delete cleanup is best-effort; the deletion already committed
            logger.exception("Failed to clear chat bindings", session_id=session_id)
    if automation_store is None:
        return
    try:
        automation_store.forget_routines(removed["routineIds"])
    except Exception:  # noqa: BLE001 - post-delete cleanup is best-effort; the deletion already committed
        logger.exception("Failed to drop automation state", routine_ids=removed["routineIds"])
