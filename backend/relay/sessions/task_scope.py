"""Which task a person's stop or finish on a thread speaks for.

Links are history and navigation, never execution authority, so a thread
action may only touch the task it is executing: the task its active run
request claimed, or — between rounds — the task its active collaboration
round is scoped to while that task is still in flight.
"""

from __future__ import annotations

from typing import Any

from ..collaboration.models import COLLABORATION_MANIFEST_STATE_KEY
from ..persistence.task_execution import request_execution_owner

IN_FLIGHT_TASK_STATUSES = frozenset({"assigned", "running", "waiting_for_human"})


def thread_task_scope(
    session: dict[str, Any],
    run_request: dict[str, Any] | None,
    task_store: Any,
    daemon_store: Any = None,
) -> tuple[str | None, dict[str, Any] | None]:
    """Return ``(task_id, execution_owner)`` for the thread's executing task."""
    if run_request and run_request.get("taskId"):
        return run_request["taskId"], request_execution_owner(run_request)
    if task_store is None:
        return None, None
    active_round = next(
        (
            item
            for item in session.get("collaborationRounds", [])
            if item.get("roundId") == session.get("activeRoundId")
        ),
        {},
    )
    scope = active_round.get("workScope") or {}
    if scope.get("kind") != "task" or not scope.get("taskId"):
        return None, None
    try:
        task = task_store.get_task(scope["taskId"])
    except (KeyError, FileNotFoundError):
        return None, None
    if (
        task.get("deletedAt")
        or task.get("isRoutine")
        or task.get("status") not in IN_FLIGHT_TASK_STATUSES
    ):
        return None, None
    owner = active_round.get("taskExecutionOwner")
    current_owner = task.get("executionOwner")
    if owner is None and current_owner is not None:
        # Older rounds did not retain their claim. Establish provenance from
        # the retained request; the current task claim alone is not authority.
        request = (
            daemon_store.get_run_request(current_owner["requestId"])
            if daemon_store else None
        )
        manifest = ((request or {}).get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        ) or {}
        if (
            not request
            or request.get("sessionId") != session["id"]
            or request.get("taskId") != task["id"]
            or manifest.get("roundId") != active_round.get("roundId")
        ):
            return None, None
        owner = request_execution_owner(request)
    legacy = current_owner is None and (owner or {}).get("revision") == 0
    if owner is not None and owner != current_owner and not legacy:
        return None, None
    # Revision zero also fences unclaimed legacy work against a racing claim.
    return task["id"], owner or {"requestId": active_round["roundId"], "revision": 0}
