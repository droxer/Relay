"""Which runs on one node are certain to wait for each other's workspace.

The daemon serializes runs on one physical workspace, so a run delivered
behind another that holds it only occupies a slot it cannot use. The backend
cannot prove two *different* workspace names are physically distinct (links and
aliases), so it defers only on equality and leaves the daemon's canonical locks
authoritative for everything else.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

NODE_ROOT_KEY = "node-root"
IN_FLIGHT_STATUSES = frozenset({"running", "dispatching"})


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
) -> bool:
    """Whether another session's run holds, is delivering, or is queued ahead
    for this workspace key. ``created_order`` is None for a request not yet
    created: everything already queued is ahead of it."""
    for run in active_runs:
        other = run.get("sessionId")
        if other and other != session_id and key_of_session(other) == key:
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
        ahead = created_order is None or _order(request) < created_order
        if (holds_a_command or ahead) and key_of_session(other) == key:
            return True
    return False
