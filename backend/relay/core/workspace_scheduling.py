"""Pure workspace scheduling policy shared by admission, delivery and storage.

Non-Project workspaces retain serialization, so delivering a run behind their
holder only occupies a slot it cannot use. Project workspaces allow concurrent
runs and bypass contention and queue preference at the call sites. For other
layouts the backend defers on equal names and the daemon's canonical locks
handle physical aliases.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .thread_queue import queue_can_continue

NODE_ROOT_KEY = "node-root"
IN_FLIGHT_STATUSES = frozenset({"running", "dispatching"})


def preferred_thread_id(
    last_executing_thread: dict[str, Any] | None, *, follow_up_admitted: bool
) -> str | None:
    """Keep the current Thread's queue ahead of undelivered workspace waiters.

    Consuming a queued message transfers priority to its admitted execution;
    an empty queue releases priority only after that execution has settled.
    """
    session = last_executing_thread
    if not session or session.get("archived") or session.get("deletionRequestedAt"):
        return None
    return session["id"] if follow_up_admitted or queue_can_continue(session) else None


def workspace_key(
    layout: str | None, subpath: str | None, session_id: str | None
) -> str:
    """A conservative key for a shared directory or a Thread's own workspace."""
    if layout in ("project", "task") and subpath:
        return f"subpath:{subpath}"
    if layout == "thread" and session_id:
        return f"thread:{session_id}"
    return NODE_ROOT_KEY


def session_workspace_key(session: dict[str, Any]) -> str:
    return workspace_key(
        session.get("workspaceLayout"), session.get("workspaceSubpath"), session.get("id")
    )


def _order(request: dict[str, Any]) -> tuple[str, str]:
    return (request.get("createdAt") or "", request["id"])


def workspace_is_contended(
    *,
    key: str,
    session_id: str | None,
    request_id: str | None,
    created_order: tuple[str, str] | None,
    active_runs: list[dict[str, Any]],
    node_requests: list[dict[str, Any]],
    key_of_session: Callable[[str], str | None],
    preferred_session_id: str | None = None,
) -> bool:
    """Whether another session's run holds, is delivering, or is queued ahead
    for this workspace key. ``created_order`` is None for a request not yet
    created: everything already queued is ahead of it. A preferred Thread may
    pass undelivered waiters, but never an active run or dispatch claim."""
    for run in active_runs:
        other = run.get("sessionId")
        if other and other != session_id and key_of_session(other) == key:
            return True
    if preferred_session_id and preferred_session_id != session_id:
        return True
    for request in node_requests:
        other = request.get("sessionId")
        if (
            request["id"] == request_id
            or not other
            or other == session_id
            or request.get("status") not in IN_FLIGHT_STATUSES
        ):
            continue
        holds_a_command = bool(request.get("currentCommandId")) or request["status"] == "dispatching"
        is_preferred = preferred_session_id is not None and preferred_session_id == session_id
        ahead = not is_preferred and (
            created_order is None or _order(request) < created_order
        )
        if (holds_a_command or ahead) and key_of_session(other) == key:
            return True
    return False
