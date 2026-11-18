"""Keep a workspace's last executing Thread ahead while it has follow-ups.

Read durable runs and queues rather than process-local state, so a daemon poll
or recovery on another backend replica observes the same handoff policy.
"""

from typing import Any

from sqlalchemy import exists, select

from ...core.workspace_scheduling import preferred_thread_id
from ..engine import store_transaction
from ..tables import daemon, sessions
from .state import DaemonStoreState


def preferred_workspace_session(conn: Any, node_id: str, session: dict[str, Any]) -> str | None:
    layout, subpath = session.get("workspaceLayout"), session.get("workspaceSubpath")
    if layout != "task" or not subpath:
        return None
    threads = sessions.sessions
    previous = conn.execute(
        select(threads.c.snapshot)
        .join(daemon.runs, daemon.runs.c.session_id == threads.c.id)
        .where(
            daemon.runs.c.node_id == node_id,
            threads.c.snapshot["workspaceLayout"].as_string() == layout,
            threads.c.snapshot["workspaceSubpath"].as_string() == subpath,
        )
        .order_by(daemon.runs.c.started_at.desc(), daemon.runs.c.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if not previous:
        return None
    # Once the message is consumed, its admitted run still owns the handoff.
    admitted = conn.scalar(select(exists().where(
        daemon.run_requests.c.node_id == node_id,
        daemon.run_requests.c.session_id == previous["id"],
        daemon.run_requests.c.status.in_(("running", "dispatching")),
    )))
    return preferred_thread_id(previous, follow_up_admitted=bool(admitted))


class WorkspaceQueueRows(DaemonStoreState):
    def preferred_workspace_session(self, node_id: str, session: dict[str, Any]) -> str | None:
        with store_transaction(self.engine) as conn:
            return preferred_workspace_session(conn, node_id, session)
