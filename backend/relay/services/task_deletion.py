from __future__ import annotations

from contextlib import nullcontext
from typing import Any, Literal, Protocol, TypedDict

from ..persistence.protocols import ChatStore, SessionStore, TaskStore
from ..persistence.task_store import TaskExecutionActiveError, dispatch_claim_active
from ..persistence.store_common import store_transaction
from ..sessions.controller import SessionController, SessionRunInFlightError

TERMINAL_SESSION_STATUSES = frozenset({"completed", "failed", "cancelled"})


class TaskDeletionContext(Protocol):
    task_store: TaskStore
    session_store: SessionStore
    chat_store: ChatStore


class TaskDeletionResult(TypedDict):
    task: dict[str, Any]
    outcome: Literal["deleted", "already_deleted"]


class TaskDeletionError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def task_has_active_linked_session(
    session_store: SessionStore, task: dict[str, Any], *, execution_lifecycle: Any = None
) -> bool:
    for session_id in task.get("linkedSessionIds", []):
        try:
            session = session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            continue
        if execution_lifecycle is not None:
            # An unfinished conversation can be idle, and a completed one can
            # still hold an execution reservation awaiting daemon exit evidence.
            if not execution_lifecycle.status(session)["canDelete"]:
                return True
        elif session.get("status") not in TERMINAL_SESSION_STATUSES:
            return True
    return False


def delete_task(
    ctx: TaskDeletionContext,
    task_id: str,
    actor: dict[str, Any],
    *,
    execution_lifecycle: Any = None,
) -> TaskDeletionResult:
    engine = getattr(ctx.task_store, "engine", None)
    with store_transaction(engine) if engine is not None else nullcontext():
        return _delete_task(ctx, task_id, actor, execution_lifecycle)


def _delete_task(
    ctx: TaskDeletionContext, task_id: str, actor: dict[str, Any],
    execution_lifecycle: Any,
) -> TaskDeletionResult:
    try:
        task = ctx.task_store.get_task(task_id)
    except (KeyError, FileNotFoundError) as error:
        raise TaskDeletionError("task_not_found") from error

    actor_employee_id = actor.get("employeeId")
    if not actor.get("isAdmin") and task.get("ownerEmployeeId") != actor_employee_id:
        raise TaskDeletionError("task_delete_forbidden")

    if task.get("deletedAt"):
        return {"task": task, "outcome": "already_deleted"}

    related = [task]
    if task.get("isRoutine"):
        for occurrence_id in task.get("occurrenceIds", []):
            try:
                related.append(ctx.task_store.get_task(occurrence_id))
            except (KeyError, FileNotFoundError):
                continue
        for record in related:
            if dispatch_claim_active(record) or task_has_active_linked_session(
                ctx.session_store, record, execution_lifecycle=execution_lifecycle
            ):
                raise TaskDeletionError("task_execution_active")

    try:
        deleted = ctx.task_store.delete_task(
            task_id,
            deleted_by=actor_employee_id,
            reject_active_claim=True,
            active_linked_session=lambda current: task_has_active_linked_session(
                ctx.session_store, current, execution_lifecycle=execution_lifecycle
            ),
        )
        if task.get("isRoutine"):
            # Reload after locking/deleting the parent: concurrent promotion may
            # have appended an occurrence since the initial read.
            related = [deleted]
            for occurrence_id in deleted.get("occurrenceIds", []):
                try:
                    related.append(ctx.task_store.get_task(occurrence_id))
                except (KeyError, FileNotFoundError):
                    continue
            session_ids = {sid for record in related for sid in record.get("linkedSessionIds", [])}
            for record in related[1:]:
                ctx.task_store.delete_task(
                    record["id"], deleted_by=actor_employee_id, reject_active_claim=True,
                    active_linked_session=lambda current: task_has_active_linked_session(
                        ctx.session_store, current, execution_lifecycle=execution_lifecycle
                    ),
                )
            controller = SessionController(ctx.session_store, task_store=ctx.task_store)
            for session_id in sorted(session_ids):
                try:
                    session = ctx.session_store.get_session(session_id)
                except (KeyError, FileNotFoundError):
                    continue
                if execution_lifecycle and not execution_lifecycle.status(session)["canDelete"]:
                    raise TaskExecutionActiveError(task_id)
                controller.delete_session(session_id, snapshot=session, deleted_by=actor_employee_id)
                ctx.chat_store.clear_conversation_sessions(session_id)
            deleted = ctx.task_store.get_task(task_id)
    except (TaskExecutionActiveError, SessionRunInFlightError) as error:
        raise TaskDeletionError("task_execution_active") from error
    return {"task": deleted, "outcome": "deleted"}
