"""A Task owner's completion and the execution it supersedes."""
from collections.abc import Callable
from contextlib import nullcontext
from typing import Any

from ..collaboration.workflow_events import active_workflow_run
from ..persistence.events import relay_event
from ..sessions.controller import SessionController
from ..tasks.execution import manually_completed
from ..tasks.requests import TaskRequestError
from .task_verification import checked_review


def mark_task_done(
    ctx: Any, task: dict[str, Any], actor_user_id: str, body: dict[str, Any],
    reload_task: Callable[[], dict[str, Any]],
    *, session_id: str | None = None,
) -> dict[str, Any]:
    # A streamed daemon event takes the node lock before writing the database.
    # Take the same lock before opening the Task write scope when stopping a run.
    with ctx.registry.dispatch_lock:
        active = ctx.registry.daemon_store.active_run_request_for_task(task["id"])
        with (ctx.registry.dispatch_scope([active["nodeId"]] if active else []),
              ctx.session_store.mutation_scope(active["sessionId"]) if active else nullcontext(),
              ctx.task_store.task_write_scope(task["id"]),
              checked_review(ctx, task, body, session_id=session_id)):
            current = reload_task()
            if current.get("isRoutine") or ("reviewRevision" in body and current["status"] != "review"):
                raise TaskRequestError(409, "task_acceptance_requires_review")
            if manually_completed(current):
                return current
            updated = ctx.task_store.update_task(current["id"], {**body, "actorUserId": actor_user_id})
            outcome = "Task accepted after review." if current["status"] == "review" else "Task marked done by user."
            complete_linked_task_sessions(ctx, updated, outcome, actor_user_id)
            return updated


def complete_linked_task_sessions(ctx: Any, task: dict[str, Any], outcome: str, actor_user_id: str) -> None:
    # Serialize with admission so a newer thread round cannot acquire the
    # session between checking its scope and completing it.
    with ctx.registry.dispatch_lock:
        controller = SessionController(ctx.session_store)
        sessions = set(task.get("linkedSessionIds", []))
        active = ctx.registry.daemon_store.active_run_request_for_task(task["id"])
        if active:
            sessions.add(active["sessionId"])
        for session_id in sorted(sessions):
            _complete_if_task_scoped(ctx, controller, task, session_id, outcome, actor_user_id)


def _complete_if_task_scoped(
    ctx: Any,
    controller: SessionController,
    task: dict[str, Any],
    session_id: str,
    outcome: str,
    actor_user_id: str,
) -> None:
    try:
        session = ctx.session_store.get_session_header(session_id, for_update=True)
    except (KeyError, FileNotFoundError):
        return
    run_request = ctx.registry.daemon_store.active_run_request_for_session_any_node(session_id)
    if run_request:
        if run_request.get("taskId") != task["id"]:
            return
    elif _active_round(session).get("workScope") != {"kind": "task", "taskId": task["id"]}:
        return
    if run_request:
        cancelled = ctx.registry.cancel_run_request_before_delivery(run_request["id"], outcome)
        if not cancelled and ctx.registry.get(run_request["nodeId"]):
            ctx.registry.cancel_active_run(run_request["nodeId"], session_id, outcome, actor_user_id=actor_user_id)
            stopping = ctx.registry.daemon_store.get_run_request(run_request["id"]) or {}
            if (stopping.get("state") or {}).get("_relay_stop_command_id"):
                # The daemon can still report execution and output. Its terminal
                # acknowledgement closes the Thread through normal finalization.
                return
    if session.get("status") not in ("completed", "failed", "cancelled"):
        workflow = active_workflow_run(session)
        if workflow and workflow["status"] not in ("cancelled", "completed"):
            # Completing the Task stops the remaining Workflow steps; only the
            # daemon can supply the required outputs that finish the Workflow.
            ctx.session_store.append_event(session_id, relay_event("session.status", session_id, {
                "status": "cancelled", "phase": "cancelled", "actorUserId": actor_user_id,
            }))
        else:
            controller.complete_session(session_id, outcome)


def _active_round(session: dict[str, Any]) -> dict[str, Any]:
    return next(
        (
            item
            for item in session.get("collaborationRounds", [])
            if item.get("roundId") == session.get("activeRoundId")
        ),
        {},
    )
