"""Reading threads: snapshots, headers, summaries, token usage, and dashboard metrics.

A mixin of ``DatabaseSessionStore``; it shares the store's engine and tables
(declared on ``SessionStoreState``) and is not used on its own.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, UTC
from functools import partial
from typing import Any
from sqlalchemy import (
    case,
    func,
    literal_column,
    select,
    text,
)
from .output_compaction import compact_completed_run_output
from ..db_time import format_db_time
from ..engine import store_transaction
from .rows import (
    _artifact_field_sql,
    _canonical_database_session_id,
    hydrate_session_logs,
)
from .state import SessionStoreState


class SessionReadRows(SessionStoreState):
    def get_session(self, session_id: str) -> dict[str, Any]:
        session_pk = _canonical_database_session_id(session_id)
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.sessions.c.id, self.sessions.c.snapshot).where(
                        self.sessions.c.id == session_pk
                    )
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(session_id)
            events = self._events_for_session(conn, row["id"])
        return hydrate_session_logs(row["snapshot"] or {}, events)

    def get_session_header(self, session_id: str) -> dict[str, Any]:
        """Read authorization and list fields without loading the event log."""
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.sessions.c.snapshot, self.sessions.c.version).where(
                        self.sessions.c.id == session_id
                    )
                )
                .mappings()
                .first()
            )
        if not row:
            raise KeyError(session_id)
        return {
            **(row["snapshot"] or {}),
            "eventCount": int(row["version"] or 0),
        }

    def list_sessions(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.sessions.c.id, self.sessions.c.snapshot).order_by(
                        self.sessions.c.updated_at.desc()
                    )
                )
                .mappings()
                .all()
            )
            session_ids = [row["id"] for row in rows]
            events_by_session: dict[Any, list[dict[str, Any]]] = defaultdict(list)
            if session_ids:
                event_rows = (
                    conn.execute(
                        select(self.events.c.session_id, self.events.c.payload)
                        .where(self.events.c.session_id.in_(session_ids))
                        .order_by(self.events.c.session_id, self.events.c.sequence)
                    )
                    .mappings()
                    .all()
                )
                for event_row in event_rows:
                    events_by_session[event_row["session_id"]].append(
                        event_row["payload"]
                    )
        return [
            hydrate_session_logs(row["snapshot"] or {}, events_by_session[row["id"]])
            for row in rows
        ]

    def list_session_summaries(
        self, *, owner_user_id: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        # Project JSON fields in SQL: completed run logs never cross the wire.
        fields = (
            "daemonNodeId",
            "managedNodeId",
            "workspacePath",
            "ownerUserId",
            "ownerAgentId",
            "teamId",
            "projectId",
            "workspaceLayout",
            "workspaceSubpath",
            "computerId",
            "currentAgent",
            "pendingDecision",
            "permissionRequests",
            "archived",
            "deletionRequestedAt",
            "title",
            "taskGoal",
            "status",
            "workOutcome",
            "phase",
            "createdAt",
            "updatedAt",
        )
        pg = self.engine.dialect.name == "postgresql"
        runs = (
            "sessions.snapshot->'agentRuns'"
            if pg
            else "json_extract(sessions.snapshot, '$.agentRuns')"
        )
        artifacts = (
            "sessions.snapshot->'artifacts'"
            if pg
            else "json_extract(sessions.snapshot, '$.artifacts')"
        )
        elements = "jsonb_array_elements" if pg else "json_each"
        array_length = "jsonb_array_length" if pg else "json_array_length"
        value = partial(_artifact_field_sql, pg)
        statement = select(
            self.sessions.c.id,
            self.sessions.c.version,
            *(self.sessions.c.snapshot[field].label(field) for field in fields),
            literal_column(f"COALESCE({array_length}({runs}), 0)").label("runCount"),
            literal_column(
                f"EXISTS (SELECT 1 FROM {elements}({runs}) a WHERE {value('status')} = 'running')"
            ).label("hasRunningAgent"),
            literal_column(
                f"(SELECT COUNT(DISTINCT COALESCE(NULLIF({value('workspaceRelativePath')}, ''), NULLIF({value('path')}, ''), {value('id')})) FROM {elements}({artifacts}) a WHERE {value('kind')} = 'workspace_file')"
            ).label("artifactCount"),
        ).order_by(self.sessions.c.updated_at.desc(), self.sessions.c.id.desc())
        if owner_user_id is not None:
            statement = statement.where(
                self.sessions.c.owner_user_id == owner_user_id
            )
        statement = statement.limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [
            {
                **{k: v for k, v in row.items() if k != "version" and v is not None},
                "eventCount": int(row["version"] or 0),
            }
            for row in rows
        ]

    def compact_completed_run_output(
        self, *, older_than: datetime, limit: int = 20
    ) -> int:
        """Redact streamed output of completed runs; see session_output_compaction."""
        return compact_completed_run_output(self, older_than=older_than, limit=limit)

    def list_session_snapshots(
        self, *, owner_user_id: str, project_id: str | None = None
    ) -> list[dict[str, Any]]:
        """One user's threads as projections, newest first, with no events.

        For views that need runs and artifacts but not the log: owner and
        project filter in SQL through their indexes, and completed run logs
        stay out of the snapshot already.
        """
        statement = (
            select(self.sessions.c.snapshot, self.sessions.c.version)
            .where(self.sessions.c.owner_user_id == owner_user_id)
            .order_by(self.sessions.c.updated_at.desc(), self.sessions.c.id.desc())
        )
        if project_id is not None:
            statement = statement.where(self.sessions.c.project_id == project_id)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [
            {**(row["snapshot"] or {}), "eventCount": int(row["version"] or 0)}
            for row in rows
        ]

    def list_token_usage(self) -> list[dict[str, Any]]:
        return self._read_token_usage(None)

    def dashboard_session_metrics(
        self, *, day_window: int = 14, now: datetime | None = None
    ) -> dict[str, Any]:
        """Aggregate dashboard counters in SQL without hydrating session events."""
        now = now or datetime.now(UTC)
        one_day = now - timedelta(hours=24)
        seven_days = now - timedelta(days=7)
        window_start = (now - timedelta(days=day_window - 1)).date()
        window_start_at = datetime.combine(
            window_start, datetime.min.time(), tzinfo=UTC
        )
        day = func.date(self.sessions.c.created_at)
        completed = func.sum(case((self.sessions.c.status == "completed", 1), else_=0))
        failed = func.sum(case((self.sessions.c.status == "failed", 1), else_=0))
        created = self.sessions.c.created_at
        with store_transaction(self.engine) as conn:
            # Totals, both windows, and the status breakdown in one grouped pass.
            status_rows = conn.execute(
                select(
                    self.sessions.c.status,
                    func.count(),
                    func.sum(case((created >= one_day, 1), else_=0)),
                    func.sum(case((created >= seven_days, 1), else_=0)),
                ).group_by(self.sessions.c.status)
            ).all()
            total = sum(int(row[1] or 0) for row in status_rows)
            last_24h = sum(int(row[2] or 0) for row in status_rows)
            last_7d = sum(int(row[3] or 0) for row in status_rows)
            user_rows = conn.execute(
                select(self.sessions.c.owner_user_id, func.count().label("count"))
                .where(self.sessions.c.owner_user_id.is_not(None))
                .group_by(self.sessions.c.owner_user_id)
                .order_by(text("count DESC"))
                .limit(5)
            ).all()
            daily_rows = (
                conn.execute(
                    select(
                        day.label("day"),
                        func.count().label("count"),
                        completed.label("completed"),
                        failed.label("failed"),
                    )
                    .where(self.sessions.c.created_at >= window_start_at)
                    .group_by(day)
                    .order_by(day)
                )
                .mappings()
                .all()
            )
        daily_by_day = {
            str(row["day"]): {
                "count": int(row["count"] or 0),
                "completed": int(row["completed"] or 0),
                "failed": int(row["failed"] or 0),
            }
            for row in daily_rows
        }
        return {
            "total": total,
            "last24h": last_24h,
            "last7d": last_7d,
            "statusCounts": {str(row[0]): int(row[1]) for row in status_rows},
            "dailyCounts": [
                {
                    "date": (window_start + timedelta(days=offset)).isoformat(),
                    **daily_by_day.get(
                        (window_start + timedelta(days=offset)).isoformat(),
                        {"count": 0, "completed": 0, "failed": 0},
                    ),
                }
                for offset in range(day_window)
            ],
            "topUsers": [
                {"userId": str(user_id), "sessionCount": int(count)}
                for user_id, count in user_rows
            ],
        }

    def list_dashboard_token_usage(self, *, since: datetime) -> list[dict[str, Any]]:
        """Read the ledger rows of runs that finished inside the reporting window."""
        return self._read_token_usage(since)

    def _read_token_usage(self, since: datetime | None) -> list[dict[str, Any]]:
        query = (
            select(
                self.run_token_usage,
                self.sessions.c.task_goal.label("session_task_goal"),
            )
            .select_from(
                self.run_token_usage.outerjoin(
                    self.sessions,
                    self.run_token_usage.c.session_id == self.sessions.c.id,
                )
            )
            .order_by(self.run_token_usage.c.completed_at.desc())
        )
        if since is not None:
            query = query.where(self.run_token_usage.c.completed_at >= since)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(query).mappings().all()
        return [
            {
                "sessionId": row["session_id"],
                "runId": row["run_id"],
                "ownerUserId": row["owner_user_id"],
                "taskGoal": row["task_goal"] or row["session_task_goal"],
                "agent": row["agent"],
                "reported": bool(row["reported"]),
                "input": int(row["input_tokens"] or 0),
                "output": int(row["output_tokens"] or 0),
                "cache": int(row["cache_tokens"] or 0),
                "cacheRead": int(row["cache_read_tokens"] or 0),
                "cacheWrite": int(row["cache_write_tokens"] or 0),
                "total": int(row["total_tokens"] or 0),
                "completedAt": format_db_time(row["completed_at"]),
            }
            for row in rows
        ]
