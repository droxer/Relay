"""Deleting a thread once its execution allows it.

Deletion is judged and written under the dispatch lock and the execution
lifecycle's admission scope, so no run can be admitted to the thread between
the check that it may be deleted and the delete itself. Whether it may is the
lifecycle's ``canDelete``: a delivered reservation releases only on exit
evidence or a recorded human assertion (see ``ExecutionLifecycle``).
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..sessions.controller import SessionController, SessionRunInFlightError


def delete_thread(
    ctx: Any,
    session_id: str,
    *,
    execution_lifecycle: Any,
    deleted_by: str,
    reload: Callable[[], dict[str, Any]],
) -> None:
    """Delete a thread, or raise ``SessionRunInFlightError`` while it must stay.

    ``reload`` re-reads the thread under the locks with the caller's access rule.
    """
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_user_id=deleted_by,
    )
    with ctx.registry.dispatch_lock, execution_lifecycle.admission_scope():
        snapshot = reload()
        if not execution_lifecycle.status(snapshot)["canDelete"]:
            raise SessionRunInFlightError(session_id)
        controller.delete_session(session_id, snapshot=snapshot, deleted_by=deleted_by)
    ctx.chat_store.clear_conversation_sessions(session_id)
