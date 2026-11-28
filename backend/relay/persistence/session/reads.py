"""Reading threads: snapshots, headers, summaries, and token usage.

A mixin of ``DatabaseSessionStore``; it shares the store's engine and tables
(declared on ``SessionStoreState``) and is not used on its own.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from functools import partial
from typing import Any
from ...core.project_roles import with_project_lead_discussion
from sqlalchemy import (
    Text,
    and_,
    case,
    cast,
    func,
    literal_column,
    or_,
    select,
    text,
    tuple_,
    type_coerce,
)
from .output_compaction import compact_completed_run_output
from ..db_time import format_db_time
from ..engine import store_transaction
from .. import sql
from ..tables.sessions import POSTGRES_QUEUED_THREAD, SQLITE_QUEUED_THREAD
from ..tables.tasks import tasks
from ..workspace import ThreadListFilter, ThreadSummaryPosition, workspace_task_scope, workspace_thread_scope
from ..tables.daemon import active_run_request, run_requests, runs as daemon_runs
from .rows import (
    _artifact_field_sql,
    _canonical_database_session_id,
    compact_database_session_snapshot,
    session_event_cursor_expression,
    hydrate_session_logs,
)
from .state import SessionStoreState

# Where a summary page ends: the last row's ``updated_at`` and id.
SummaryPosition = tuple[datetime, str]
_POSITION_COLUMN = "_positionUpdatedAt"


class SessionReadRows(SessionStoreState):
    def project_thread_id(self, thread_id: str, project_id: str, owner_user_id: str) -> str | None:
        try:
            session_id = _canonical_database_session_id(thread_id)
        except KeyError:
            return None
        sessions = self.sessions
        with store_transaction(self.engine) as conn:
            found = conn.scalar(select(sessions.c.id).where(
                sessions.c.id == session_id,
                sessions.c.project_id == project_id,
                sessions.c.owner_user_id == owner_user_id,
            ))
        return str(found) if found is not None else None

    @contextmanager
    def summary_read_scope(self) -> Iterator[None]:
        with store_transaction(self.engine) as conn:
            if conn.dialect.name == "postgresql":
                conn.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            yield

    def summary_page_stamp(
        self, *, owner_user_id: str, limit: int, before: ThreadSummaryPosition | None,
        project_id: str | None = None,
        thread_filter: ThreadListFilter | None = None,
    ) -> tuple[list[str], list[Any]] | None:
        """Read page identity without expanding its JSON or the execution projection.

        When execution can change with wall time, or affinity requires a legacy
        lookup, the caller must validate the fully assembled response instead.
        """
        sessions = self.sessions
        snapshot = sessions.c.snapshot
        live_request = select(run_requests.c.id).where(
            run_requests.c.session_id == sessions.c.id,
            active_run_request,
        ).exists()
        live_run = select(daemon_runs.c.id).where(
            daemon_runs.c.session_id == sessions.c.id, daemon_runs.c.status == "running",
        ).exists()
        legacy_affinity = and_(
            snapshot["daemonNodeId"].as_string().is_not(None),
            snapshot["computerId"].as_string().is_(None),
            snapshot["managedNodeId"].as_string().is_(None),
        )
        revision = (cast(literal_column("sessions.xmin"), Text)
                    if self.engine.dialect.name == "postgresql" else snapshot)
        statement = select(
            sessions.c.id, sessions.c.updated_at, sessions.c.version, revision,
            or_(live_request, live_run, legacy_affinity),
        ).where(*workspace_thread_scope(sessions, owner_user_id, project_id=project_id, thread_filter=thread_filter))
        statement = self._summary_page_scope(statement, before, thread_filter).limit(limit + 1)
        with store_transaction(self.engine) as conn:
            records = conn.execute(statement).all()
        page = records[:limit]
        if any(row[-1] for row in page):
            return None
        ids = [str(row[0]) for row in page]
        return ids, [[tuple(row[:-1]) for row in page], len(records) > limit]

    def _summary_page_scope(
        self, statement: Any, before: ThreadSummaryPosition | None, thread_filter: ThreadListFilter | None = None,
    ) -> Any:
        position = self.sessions.c.updated_at
        thread_id = self.sessions.c.id
        if thread_filter and thread_filter.kind == "chats":
            pinned = self.sessions.c.snapshot["discussionPinned"].as_boolean().is_(True)
            if before is not None:
                # Cursors issued before pinning was introduced start in the unpinned group.
                before_pinned = before[2] if len(before) == 3 else False
                statement = statement.where(tuple_(pinned, position, thread_id) < (before_pinned, before[0], before[1]))
            return statement.order_by(pinned.desc(), position.desc(), thread_id.desc())
        if before is not None:
            statement = statement.where(tuple_(position, thread_id) < (before[0], before[1]))
        return statement.order_by(position.desc(), thread_id.desc())

    def queue_receipt(self, thread_id: str, message_id: str) -> dict[str, Any] | None:
        return self.session_event(thread_id, f"queue.accepted:{message_id}", "session.queue")

    def session_event(self, thread_id: str, event_id: str, event_type: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(select(self.events.c.payload).where(
                self.events.c.session_id == thread_id,
                self.events.c.type == event_type,
                session_event_cursor_expression(self.events) == event_id,
            ).limit(1))

    def queued_thread_ids(self, limit: int = 100, after: str | None = None) -> list[str]:
        with store_transaction(self.engine) as conn:
            predicate = POSTGRES_QUEUED_THREAD if conn.dialect.name == "postgresql" else SQLITE_QUEUED_THREAD
            statement = select(self.sessions.c.id).where(text(predicate))
            if after:
                statement = statement.where(self.sessions.c.id > after)
            return list(conn.scalars(statement.order_by(self.sessions.c.id).limit(limit)))

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self._read_session(session_id, None)

    def get_session_with_events(
        self, session_id: str, event_types: tuple[str, ...], *, include_event_boundary: bool = False,
    ) -> dict[str, Any]:
        """Read the Thread with the event types needed for execution.

        eventCount still describes the durable sequence.
        """
        return self._read_session(session_id, event_types, include_event_boundary=include_event_boundary)

    def _read_session(
        self, session_id: str, event_types: tuple[str, ...] | None,
        *, include_event_boundary: bool = False,
    ) -> dict[str, Any]:
        session_pk = _canonical_database_session_id(session_id)
        statement = select(self.sessions.c.id, self.sessions.c.snapshot, self.sessions.c.version)
        if include_event_boundary:
            last_event_id = (
                select(self.events.c.payload["id"].as_string())
                .where(self.events.c.session_id == self.sessions.c.id)
                .order_by(self.events.c.sequence.desc())
                .limit(1)
                .scalar_subquery()
            )
            statement = statement.add_columns(last_event_id.label("lastEventId"))
        with store_transaction(self.engine) as conn:
            row = conn.execute(statement.where(self.sessions.c.id == session_pk)).mappings().first()
            if not row:
                raise KeyError(session_id)
            events = self._events_for_session(
                conn, row["id"], event_types, before_sequence=row["version"] if include_event_boundary else None,
            )
        session = hydrate_session_logs(with_project_lead_discussion(row["snapshot"] or {}), events)
        if event_types is not None:
            session["eventCount"] = int(row["version"] or 0)
        if include_event_boundary:
            session["lastEventId"] = row["lastEventId"]
        return session

    def get_session_header(self, session_id: str, *, for_update: bool = False) -> dict[str, Any]:
        """Read snapshot fields without loading the event log.

        ``for_update`` holds the row until an enclosing store transaction
        commits; Task review uses it to serialize acceptance with late output.
        """
        # A thread id that is not a UUID names no thread; on Postgres the
        # uuid column would otherwise reject the bind with a DataError (500).
        session_pk = _canonical_database_session_id(session_id)
        with store_transaction(self.engine) as conn:
            statement = select(self.sessions.c.snapshot, self.sessions.c.version).where(
                self.sessions.c.id == session_pk
            )
            row = (
                conn.execute(statement.with_for_update() if for_update else statement)
                .mappings()
                .first()
            )
        if not row:
            raise KeyError(session_id)
        return {
            **with_project_lead_discussion(row["snapshot"] or {}),
            "eventCount": int(row["version"] or 0),
        }

    def session_version(self, session_id: str) -> int:
        """The thread's event count alone: one primary-key read, no payload."""
        session_pk = _canonical_database_session_id(session_id)
        with store_transaction(self.engine) as conn:
            version = conn.scalar(
                select(self.sessions.c.version).where(self.sessions.c.id == session_pk)
            )
        if version is None:
            raise KeyError(session_id)
        return int(version)

    def list_session_workflows(self, session_ids: list[str], owner_user_id: str) -> list[dict[str, Any]]:
        ids = []
        for session_id in session_ids:
            try:
                ids.append(_canonical_database_session_id(session_id))
            except KeyError:
                continue
        if not ids:
            return []
        sessions = self.sessions
        statement = select(
            sessions.c.id, sessions.c.owner_user_id.label("ownerUserId"), sessions.c.status,
            sessions.c.snapshot["workflowRuns"].label("workflowRuns"),
            sessions.c.snapshot["activeWorkflowRunId"].as_string().label("activeWorkflowRunId"),
        ).where(sessions.c.owner_user_id == owner_user_id)
        results: dict[str, dict[str, Any]] = {}
        with store_transaction(self.engine) as conn:
            for start in range(0, len(ids), 500):
                for row in conn.execute(statement.where(sessions.c.id.in_(ids[start:start + 500]))).mappings():
                    results[row["id"]] = {**row, "workflowRuns": row["workflowRuns"] or []}
        return [results[session_id] for session_id in dict.fromkeys(ids) if session_id in results]

    def list_sessions(
        self, *, owner_user_id: str | None = None, include_archived: bool = True
    ) -> list[dict[str, Any]]:
        """Full records for the selected scope; history binds stay bounded."""
        statement = select(self.sessions.c.id, self.sessions.c.snapshot).order_by(
            self.sessions.c.updated_at.desc(), self.sessions.c.id.desc()
        )
        if owner_user_id is not None:
            if sql.names_no_uuid_row(self.engine, owner_user_id):
                return []
            statement = statement.where(self.sessions.c.owner_user_id == owner_user_id)
        if not include_archived:
            statement = statement.where(self.sessions.c.snapshot["archived"].as_boolean().is_not(True))
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(statement)
                .mappings()
                .all()
            )
            session_ids = [row["id"] for row in rows]
            events_by_session: dict[Any, list[dict[str, Any]]] = defaultdict(list)
            for offset in range(0, len(session_ids), 500):
                event_rows = (
                    conn.execute(
                        select(self.events.c.session_id, self.events.c.payload)
                        .where(self.events.c.session_id.in_(session_ids[offset:offset + 500]))
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
        summaries, _ = self.list_session_summary_page(
            owner_user_id=owner_user_id, limit=limit
        )
        return summaries

    def list_session_record_page(
        self, *, owner_user_id: str, limit: int, before: SummaryPosition | None = None,
        include_archived: bool = True, project_id: str | None = None,
        thread_filter: ThreadListFilter | None = None,
    ) -> tuple[list[dict[str, Any]], SummaryPosition | None]:
        """Page owner-visible snapshots without opening the event log."""
        if sql.names_no_uuid_row(self.engine, owner_user_id):
            return [], None
        sessions = self.sessions
        snapshot = sessions.c.snapshot
        # Older stores can carry inline events. Drop them at the database boundary.
        compact = (snapshot.op("-", return_type=snapshot.type)(literal_column("'events'"))
                   if self.engine.dialect.name == "postgresql"
                   else func.json_remove(snapshot, "$.events", type_=snapshot.type))
        statement = select(
            sessions.c.id, sessions.c.updated_at, sessions.c.version, compact.label("snapshot"),
        ).where(*workspace_thread_scope(sessions, owner_user_id, project_id=project_id, thread_filter=thread_filter))
        if not include_archived:
            statement = statement.where(snapshot["archived"].as_boolean().is_not(True))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(self._summary_page_scope(statement, before).limit(limit + 1)).mappings().all()
        page = rows[:limit]
        position = (page[-1]["updated_at"], str(page[-1]["id"])) if len(rows) > limit else None
        return [
            compact_database_session_snapshot(row["snapshot"], event_count=int(row["version"]))
            for row in page
        ], position

    def list_session_summary_page(
        self,
        *,
        owner_user_id: str | None = None,
        limit: int = 100,
        before: ThreadSummaryPosition | None = None,
        project_id: str | None = None,
        team_id: str | None = None,
        agent_id: str | None = None,
        thread_filter: ThreadListFilter | None = None,
    ) -> tuple[list[dict[str, Any]], ThreadSummaryPosition | None]:
        """Page newest first within each group, with pinned Project discussions first."""
        # Project JSON fields in SQL: completed run logs never cross the wire.
        fields = (
            "daemonNodeId",
            "managedNodeId",
            "workspacePath",
            "ownerUserId",
            "ownerAgentId",
            "participantAgentIds",
            "teamId",
            "projectId",
            "projectLeadDiscussion",
            "workspaceLayout",
            "workspaceSubpath",
            "computerId",
            "currentAgent",
            "pendingDecision",
            "permissionMode",
            "permissionRequests",
            "nextSteps",
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
            self.sessions.c.updated_at.label(_POSITION_COLUMN),
            *(self.sessions.c.snapshot[field].label(field) for field in fields),
            self.sessions.c.snapshot["discussionPinned"].as_boolean().label("discussionPinned"),
            # The newest run is the live one; a Task's workflow started again
            # appends its run to the same thread.
            literal_column(
                "sessions.snapshot->'workflowRuns'->-1->>'status'"
                if pg
                else "json_extract(sessions.snapshot, '$.workflowRuns[#-1].status')"
            ).label("workflowStatus"),
            literal_column(f"COALESCE({array_length}({runs}), 0)").label("runCount"),
            literal_column(
                f"EXISTS (SELECT 1 FROM {elements}({runs}) a WHERE {value('status')} = 'running')"
            ).label("hasRunningAgent"),
            literal_column(
                f"(SELECT COUNT(DISTINCT COALESCE(NULLIF({value('workspaceRelativePath')}, ''), NULLIF({value('path')}, ''), {value('id')})) FROM {elements}({artifacts}) a WHERE {value('kind')} = 'workspace_file')"
            ).label("artifactCount"),
        )
        if owner_user_id is not None:
            statement = statement.where(*workspace_thread_scope(
                self.sessions, owner_user_id, project_id=project_id, team_id=team_id, agent_id=agent_id,
                thread_filter=thread_filter,
            ))
        page_size = max(1, limit)
        # One extra row says whether another page exists without a COUNT.
        statement = self._summary_page_scope(statement, before, thread_filter).limit(page_size + 1)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        page = rows[:page_size]
        position: ThreadSummaryPosition | None = None
        if len(rows) > page_size:
            last = page[-1]
            record_position = (last[_POSITION_COLUMN], str(last["id"]))
            position = (
                (*record_position, last["discussionPinned"] is True)
                if thread_filter and thread_filter.kind == "chats" else record_position
            )
        hidden = {"version", _POSITION_COLUMN}
        return [
            with_project_lead_discussion({
                **{k: v for k, v in row.items() if k not in hidden and v is not None},
                "eventCount": int(row["version"] or 0),
            })
            for row in page
        ], position

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

    def list_workspace_threads(
        self, *, owner_user_id: str, project_id: str | None = None,
        team_id: str | None = None, agent_id: str | None = None,
        limit: int | None = None, before: SummaryPosition | None = None,
    ) -> tuple[list[dict[str, Any]], SummaryPosition | None]:
        """Rows for Activities, including Threads an Agent joined after creation."""
        sessions = self.sessions
        snapshot = sessions.c.snapshot
        pg = self.engine.dialect.name == "postgresql"
        runs = "sessions.snapshot->'agentRuns'" if pg else "json_extract(sessions.snapshot, '$.agentRuns')"
        array_length = "jsonb_array_length" if pg else "json_array_length"
        fields = ("title", "taskGoal", "status", "updatedAt")
        statement = (
            select(sessions.c.id, sessions.c.updated_at.label(_POSITION_COLUMN),
                   *(snapshot[field].as_string().label(field) for field in fields),
                   literal_column(f"COALESCE({array_length}({runs}), 0)").label("runCount"))
            .where(*workspace_thread_scope(
                sessions, owner_user_id, project_id=project_id, team_id=team_id, agent_id=agent_id,
            ))
        )
        statement = self._summary_page_scope(statement, before)
        if limit is not None:
            limit = max(1, limit)
            statement = statement.limit(limit + 1)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        page = rows[:limit]
        next_position = (page[-1][_POSITION_COLUMN], str(page[-1]["id"])) if len(rows) > len(page) else None
        return [{key: value for key, value in row.items() if key != _POSITION_COLUMN} for row in page], next_position

    def workspace_thread_counts(
        self, owner: str, *, project_id: str | None = None,
        team_id: str | None = None, agent_id: str | None = None,
    ) -> tuple[int, int]:
        sessions = self.sessions
        snapshot = sessions.c.snapshot
        task_scope = workspace_task_scope(tasks, owner, project_id=project_id, team_id=team_id, agent_id=agent_id)
        waiting = select(tasks.c.id).where(
            *task_scope, tasks.c.status == "waiting_for_human",
            tasks.c.snapshot["waitingSessionId"].as_string() == cast(sessions.c.id, Text),
        ).exists()
        rounds = snapshot["collaborationRounds"]
        if self.engine.dialect.name == "postgresql":
            values = func.jsonb_array_elements(case((func.jsonb_typeof(rounds) == "array", rounds)))
        else:
            values = func.json_each(rounds)
        entries = values.table_valued("value").alias("round_entry")
        current = type_coerce(entries.c.value, snapshot.type)
        held = select(tasks.c.id).select_from(tasks, entries).where(
            *task_scope, current["roundId"].as_string() == snapshot["activeRoundId"].as_string(),
            current["workScope"]["kind"].as_string() == "task",
            current["workScope"]["taskId"].as_string() == cast(tasks.c.id, Text),
        ).exists()
        active = or_(sessions.c.status.in_(("running", "waiting_for_human")), and_(
            sessions.c.status == "completed", or_(waiting, and_(snapshot["workOutcome"].as_string() == "blocked", ~held)),
        ))
        statement = select(func.count(), func.count().filter(active)).select_from(sessions).where(
            *workspace_thread_scope(sessions, owner, project_id=project_id, team_id=team_id, agent_id=agent_id),
        )
        with store_transaction(self.engine) as conn:
            total, active_count = conn.execute(statement).one()
        return int(total), int(active_count)

    def project_thread_count(self, owner: str, project_id: str) -> int:
        sessions = self.sessions
        with store_transaction(self.engine) as conn:
            return int(conn.scalar(select(func.count()).select_from(sessions).where(
                sessions.c.owner_user_id == owner, sessions.c.project_id == project_id,
            )) or 0)

    def list_open_sessions_idle_since(self, cutoff: datetime) -> list[dict[str, Any]]:
        """Open (``running``) threads untouched since ``cutoff``, as snapshots.

        Filtered in SQL on the materialized status and ``updated_at``, so the
        boot repair that settles abandoned threads never reads every log.
        """
        statement = (
            select(self.sessions.c.snapshot)
            .where(self.sessions.c.status == "running", self.sessions.c.updated_at < cutoff)
            .order_by(self.sessions.c.updated_at, self.sessions.c.id)
        )
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [row["snapshot"] or {} for row in rows]

    def list_token_usage(self) -> list[dict[str, Any]]:
        """Full retained run ledger, including metadata for non-dashboard callers."""
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
