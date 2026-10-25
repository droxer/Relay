"""Atomic project removal and durable execution-plane workspace cleanup."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, NamedTuple

from loguru import logger
from sqlalchemy import delete, or_, select

from ..core.ids import new_database_id
from ..daemon_registry.records import WORKSPACE_DELETE_COMMAND
from ..core.daemon_capabilities import (
    DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE,
    has_capability,
)
from ..persistence.project.store import ProjectVersionConflict
from ..core.workspace_layout import LINKED_WORKSPACE_PREFIX
from ..persistence.resource_lock import resource_transaction
from ..persistence.engine import store_transaction
from ..tasks.claims import TaskExecutionActiveError, dispatch_claim_active
from ..sessions.controller import SessionController
from ..sessions.errors import SessionRunInFlightError
from ..tasks.deletion import TASK_DELETION_LOCK

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


class _Scope(NamedTuple):
    """Everything one project deletion must judge, read in one pass.

    `tasks` holds every project task row (the purge removes them all), `live`
    only those not already deleted: a deleted task has no execution left to
    protect, and the threads it kept are another task's business. `threads`
    are the project's own threads, `linked` the threads its live tasks ran in
    outside the project. Both liveness checks and the settling read this one
    shape, so they can never disagree about which threads count.
    """

    tasks: list[dict[str, Any]]
    live: list[dict[str, Any]]
    threads: list[dict[str, Any]]
    linked: list[dict[str, Any]]


def _scope(conn: Any, ctx: Any, project_id: str, *, lock: bool) -> _Scope:
    tasks, sessions = ctx.task_store, ctx.session_store
    task_query = (
        select(tasks.tasks.c.snapshot)
        .where(tasks.tasks.c.project_id == project_id)
        .order_by(tasks.tasks.c.id)
    )
    rows = list(conn.execute(task_query.with_for_update() if lock else task_query).scalars())
    live = [task for task in rows if not task.get("deletedAt")]
    linked_ids = (
        select(tasks.task_sessions.c.session_id)
        .where(tasks.task_sessions.c.task_id.in_([task["id"] for task in live]))
    )
    table = sessions.sessions
    # NO KEY UPDATE excludes execution admission and session writers, while
    # allowing a linker's KEY SHARE lock: linking locks the thread before the
    # task, whereas this cascade already holds the task rows. Outside threads
    # survive, so their locks never need upgrading for deletion.
    session_query = (
        select(table.c.snapshot, table.c.project_id)
        .where(or_(table.c.project_id == project_id, table.c.id.in_(linked_ids)))
        .order_by(table.c.id)
    )
    found = conn.execute(
        session_query.with_for_update(key_share=True) if lock else session_query
    ).all()
    threads = [row.snapshot for row in found if str(row.project_id) == project_id]
    linked = [row.snapshot for row in found if str(row.project_id) != project_id]
    return _Scope(rows, live, threads, linked)


def _busy(
    scope: _Scope, blocked: Callable[[dict[str, Any]], bool]
) -> tuple[list[str], list[str]]:
    """The threads `blocked` refuses and the live tasks that hold one or a claim."""
    busy_sessions = [
        session["id"] for session in (*scope.threads, *scope.linked) if blocked(session)
    ]
    held = set(busy_sessions)
    busy_tasks = [
        task["id"] for task in scope.live
        if dispatch_claim_active(task) or held.intersection(task.get("linkedSessionIds", []))
    ]
    return sorted(busy_sessions), busy_tasks


def _settle_threads(
    ctx: Any, engine: Any, project_id: str, user_id: str, lifecycle: Any
) -> None:
    """Apply what deleting each thread on its own would, before the cascade.

    Deleting the project is the person's assertion that a run Relay already
    gave up on is gone, exactly as deleting that one thread would be. That
    covers the threads its live tasks ran in outside the project too: those
    tasks are being deleted, and a given-up run there would otherwise block
    the locked check below on every retry. Live runs are never stopped here,
    and every refusal that can be known now is raised before anything is
    asserted, so a refused delete leaves every thread as it was. Only work
    that starts between this read and the locked one is discovered later.
    """
    with store_transaction(engine) as conn:
        scope = _scope(conn, ctx, project_id, lock=False)
    busy_sessions, busy_tasks = _busy(scope, lambda session: _live(lifecycle, session))
    if busy_sessions or busy_tasks:
        raise ProjectDeletionError(
            "project_execution_active", session_ids=busy_sessions, task_ids=busy_tasks
        )
    for session in (*scope.threads, *scope.linked):
        lifecycle.settle_for_deletion(session, user_id)


def _live(lifecycle: Any, session: dict[str, Any]) -> bool:
    """Blocks deletion even after settling: neither finished nor given up on."""
    status = lifecycle.status(session)
    return not status["canDelete"] and not status["canReportGone"]


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


def _assert_idle(scope: _Scope, lifecycle: Any) -> None:
    busy_sessions, busy_tasks = _busy(
        scope, lambda session: not lifecycle.status(session)["canDelete"]
    )
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
    scope = _scope(conn, ctx, project_id, lock=True)
    _assert_idle(scope, lifecycle)
    project_tasks, project_sessions = scope.tasks, scope.threads
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
    for task in scope.live:
        try:
            tasks.delete_task(task["id"], deleted_by=user_id, reject_active_claim=True)
        except TaskExecutionActiveError as error:
            raise ProjectDeletionError(
                "project_execution_active", task_ids=[task["id"]]
            ) from error
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
