"""Read live run records and owner-scoped Activity rows."""

from __future__ import annotations

from typing import Any

from sqlalchemy import false, select

from ...core.computer_identity import computer_id as resolve_computer_id
from ..db_time import format_db_time
from ..engine import store_transaction
from ..sql import names_no_uuid_row
from ..tables.sessions import sessions
from .rows import row_to_run
from .state import DaemonStoreState


class DaemonRunReads(DaemonStoreState):
    def active_workspace_wait(self, run_id: str, blocker_session_id: str | None) -> tuple[bool, bool]:
        """Is the waiting run alive, and is the reported blocker still active?"""
        if names_no_uuid_row(self.engine, run_id):
            return False, False
        runs = self.runs.c
        active = select(runs.id).where(runs.status == "running")
        blocker = (
            active.where(runs.session_id == blocker_session_id).exists()
            if blocker_session_id and not names_no_uuid_row(self.engine, blocker_session_id)
            else false()
        )
        with store_transaction(self.engine) as conn:
            waiting, blocked = conn.execute(select(active.where(runs.id == run_id).exists(), blocker)).one()
        return waiting, blocked

    def list_active_runs(
        self, node_id: str | None = None, *, node_ids: set[str] | None = None,
        session_ids: set[str] | None = None, limit: int | None = None, after_id: str | None = None,
    ) -> list[dict[str, Any]]:
        statement = select(self.runs).where(self.runs.c.status == "running")
        if node_id is not None:
            statement = statement.where(self.runs.c.node_id == node_id)
        if node_ids is not None:
            statement = statement.where(self.runs.c.node_id.in_(node_ids))
        if session_ids is not None:
            statement = statement.where(self.runs.c.session_id.in_(session_ids))
        if after_id is not None:
            statement = statement.where(self.runs.c.id > after_id)
        if limit is not None:
            statement = statement.order_by(self.runs.c.id).limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [row_to_run(row) for row in rows]

    def list_workspace_active_runs(
        self, owner_user_id: str, *, project_id: str | None = None, team_id: str | None = None,
        agent_id: str | None = None, computer_id: str | None = None,
    ) -> list[dict[str, Any]]:
        runs, nodes = self.runs, self.nodes
        statement = select(
            runs.c.id.label("runId"), runs.c.session_id.label("sessionId"), runs.c.task_goal.label("taskGoal"),
            runs.c.agent, runs.c.started_at.label("startedAt"), nodes.c.id,
            nodes.c.user_id.label("userId"), nodes.c.workspace_id.label("workspaceId"),
            nodes.c.managed_node_id.label("managedNodeId"),
        ).join(
            sessions, sessions.c.id == runs.c.session_id,
        ).join(nodes, nodes.c.id == runs.c.node_id).where(
            sessions.c.owner_user_id == owner_user_id, runs.c.status == "running", nodes.c.status != "deleted",
        ).order_by(runs.c.started_at.desc(), runs.c.id)
        if project_id is not None:
            statement = statement.where(sessions.c.project_id == project_id)
        if team_id is not None:
            statement = statement.where(sessions.c.snapshot["teamId"].as_string() == team_id)
        if agent_id is not None:
            statement = statement.where(runs.c.logical_agent_id == agent_id)
        if project_id is None and team_id is None and agent_id is None:
            statement = statement.where(nodes.c.user_id == owner_user_id)
        with store_transaction(self.engine) as conn:
            return [
                {
                    "runId": row["runId"], "sessionId": row["sessionId"], "taskGoal": row["taskGoal"],
                    "agent": row["agent"], "startedAt": format_db_time(row["startedAt"]),
                }
                for row in conn.execute(statement).mappings()
                if project_id is None or resolve_computer_id(row) == computer_id
            ]
