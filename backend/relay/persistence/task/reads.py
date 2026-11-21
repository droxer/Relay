"""Reading tasks: one task, lists, per-thread lists, and summaries.

A mixin of ``DatabaseTaskStore``; it shares the store's engine and tables
(declared on ``TaskStoreState``) and is not used on its own.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Any
from sqlalchemy import (
    Text,
    and_,
    case,
    cast,
    false,
    func,
    or_,
    select,
    tuple_,
)
from sqlalchemy.dialects.postgresql import JSONB
from ...core.permission_requests import DEFAULT_TASK_PERMISSION_MODE
from .flow import wip_count_query, user_wip_limit
from .reducer import materialize_task_events
from ..engine import store_transaction
from ..sql import names_no_uuid_row
from ..tables.projects import projects
from .rows import (
    compact_task_snapshot,
    compact_task_summary,
)
from .state import TaskStoreState


def _live_owned_tasks(table: Any, user_id: str) -> tuple[Any, ...]:
    return (
        table.c.owner_user_id == user_id,
        table.c.deleted_at.is_(None),
        or_(table.c.project_id.is_(None), select(projects.c.id).where(projects.c.id == table.c.project_id).exists()),
    )


_ACTIVITY_EVENT_TYPES = (
    "task.created", "task.assigned", "task.unassigned", "task.project_set", "task.status",
    "task.session_linked", "task.session_unlinked", "task.occurrence_created", "task.dispatch_outcome", "task.activity",
)
_LIFECYCLE_EVENT_TYPES = ("task.status", "task.execution.claimed", "task.session_linked")


def _snapshot_activity_page(
    history: list[dict[str, Any]], *, limit: int, before: int | None,
) -> dict[str, Any]:
    activity = sorted(
        ((sequence, event) for sequence, event in enumerate(history) if event.get("type") in _ACTIVITY_EVENT_TYPES),
        key=lambda item: (item[1].get("timestamp") or "", item[0]),
    )
    end = len(activity)
    if before is not None:
        anchor = next((index for index, (sequence, _) in enumerate(activity) if sequence == before), None)
        if anchor is None:
            raise ValueError("Invalid Task Activity cursor.")
        end = anchor
    start = max(0, end - limit)
    previous = next((
        event.get("status") for _, event in reversed(activity[:start]) if event.get("type") == "task.status"
    ), None)
    return {
        "events": [event for _, event in activity[start:end]],
        "nextBefore": activity[start][0] if start else None,
        "previousStatus": previous or "backlog",
    }


class TaskReadRows(TaskStoreState):
    def work_page(
        self, owner: str, *, project_id: str | None, automation: bool,
        limit: int = 50, cursor: str = "", status: str = "", query: str = "",
        computer_id: str | None = None,
    ) -> dict[str, Any]:
        """Bounded, owner-scoped Task/Automation snapshots without event hydration."""
        filters = [self.tasks.c.owner_user_id == owner, self.tasks.c.deleted_at.is_(None),
                   self.tasks.c.is_routine.is_(automation), self.tasks.c.project_id == project_id]
        if computer_id is not None:
            filters.append(func.coalesce(
                self.tasks.c.snapshot["computerId"].as_string(),
                self.tasks.c.snapshot["workspaceBinding"]["computerId"].as_string(),
            ) == computer_id)
        if status:
            filters.append(self.tasks.c.routine_state == status if automation else self.tasks.c.status == status)
        if query:
            filters.append(self.tasks.c.title_casefold.contains(query.casefold(), autoescape=True))
        statement = select(self.tasks.c.snapshot, self.tasks.c.version).where(*filters)
        if cursor:
            column = cast(self.tasks.c.id, Text) if names_no_uuid_row(self.engine, cursor) else self.tasks.c.id
            statement = statement.where(column > cursor)
        with store_transaction(self.engine) as conn:
            total = int(conn.scalar(select(func.count()).select_from(self.tasks).where(*filters)) or 0)
            rows = conn.execute(statement.order_by(self.tasks.c.id).limit(limit + 1)).mappings().all()
        page = [compact_task_summary(row["snapshot"], event_count=int(row["version"])) for row in rows[:limit]]
        return {"tasks": page, "total": total, "nextCursor": page[-1]["id"] if len(rows) > limit else None}

    def wip_limit_for_user(self, scope: str) -> int:
        with store_transaction(self.engine) as conn:
            return user_wip_limit(conn, scope)

    def count_wip(self, scope: str) -> int:
        with store_transaction(self.engine) as conn:
            return int(conn.scalar(wip_count_query(scope)) or 0)

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._read_task(task_id, include_history=True)

    def get_task_record(self, task_id: str) -> dict[str, Any]:
        return self._read_task(task_id, include_history=False)

    def get_task_header(self, task_id: str) -> dict[str, Any]:
        """Read the Task identity and access fields without loading any events."""
        if names_no_uuid_row(self.engine, task_id):
            raise KeyError(task_id)
        tasks = self.tasks
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(
                tasks.c.id, tasks.c.owner_user_id.label("ownerUserId"), tasks.c.deleted_at.label("deletedAt"),
                tasks.c.project_id.label("projectId"), tasks.c.is_routine.label("isRoutine"),
            ).where(tasks.c.id == task_id)).mappings().first()
        if row is None:
            raise KeyError(task_id)
        return dict(row)

    def task_lifecycle_events(self, task_id: str) -> list[dict[str, Any]]:
        events = self.events
        with store_transaction(self.engine) as conn:
            selected = list(conn.scalars(select(events.c.payload).where(
                events.c.task_id == task_id, events.c.type.in_(_LIFECYCLE_EVENT_TYPES),
            ).order_by(events.c.sequence)))
            if selected:
                return selected
            history = self._snapshot_task_events(conn, task_id)
        return [event for event in history if event.get("type") in _LIFECYCLE_EVENT_TYPES]

    def task_activity_page(self, task_id: str, *, limit: int, before: int | None) -> dict[str, Any]:
        events = self.events
        owned = events.c.task_id == task_id
        position = tuple_(events.c.timestamp, events.c.sequence)
        newest = (events.c.timestamp.desc(), events.c.sequence.desc())
        page = select(events.c.payload, events.c.sequence, events.c.timestamp).where(
            owned, events.c.type.in_(_ACTIVITY_EVENT_TYPES),
        ).order_by(*newest).limit(limit + 1)
        with store_transaction(self.engine) as conn:
            if before is not None:
                anchor = conn.execute(select(events.c.timestamp, events.c.sequence).where(
                    owned, events.c.sequence == before,
                )).first()
                if anchor is None:
                    return self._legacy_task_activity(conn, task_id, limit=limit, before=before)
                page = page.where(position < tuple_(anchor.timestamp, anchor.sequence))
            rows = conn.execute(page).mappings().all()
            window = rows[:limit]
            if not window:
                if before is None:
                    return self._legacy_task_activity(conn, task_id, limit=limit, before=None)
                return {"events": [], "nextBefore": None, "previousStatus": "backlog"}
            oldest = window[-1]
            previous = conn.scalar(select(events.c.payload["status"].as_string()).where(
                owned, events.c.type == "task.status", position < tuple_(oldest["timestamp"], oldest["sequence"]),
            ).order_by(*newest).limit(1))
        return {
            "events": [row["payload"] for row in reversed(window)],
            "nextBefore": oldest["sequence"] if len(rows) > limit else None,
            "previousStatus": previous or "backlog",
        }

    def _legacy_task_activity(self, conn: Any, task_id: str, *, limit: int, before: int | None) -> dict[str, Any]:
        return _snapshot_activity_page(self._snapshot_task_events(conn, task_id), limit=limit, before=before)

    def _snapshot_task_events(self, conn: Any, task_id: str) -> list[dict[str, Any]]:
        # Treat the snapshot as the log only when no durable event rows exist.
        events = self.events
        has_events = conn.scalar(select(select(events.c.sequence).where(events.c.task_id == task_id).exists()))
        if has_events:
            return []
        return conn.scalar(select(self.tasks.c.snapshot["events"]).where(self.tasks.c.id == task_id)) or []

    def _read_task(self, task_id: str, *, include_history: bool) -> dict[str, Any]:
        if names_no_uuid_row(self.engine, task_id):
            raise KeyError(task_id)
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version).where(
                        self.tasks.c.id == task_id
                    )
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(task_id)
            snapshot = row["snapshot"] or {}
            version = int(row["version"] or 0)
            if not include_history and snapshot.get("eventCount") == version:
                return compact_task_snapshot(snapshot, event_count=version)
            events = self._events_for_task(conn, row["id"])
            if not events:
                events = list(snapshot.get("events", []))
            record = materialize_task_events(events) if events else snapshot
            return record if include_history else compact_task_snapshot(record, event_count=version)

    def list_tasks(
        self, *, user_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        statement = (
            select(self.tasks.c.id, self.tasks.c.snapshot)
            .where(self.tasks.c.deleted_at.is_(None))
            # Legacy/imported orphans must be excluded before pagination.
            .where(or_(
                self.tasks.c.project_id.is_(None),
                select(projects.c.id).where(projects.c.id == self.tasks.c.project_id).exists(),
            ))
            .order_by(self.tasks.c.updated_at.desc(), self.tasks.c.id.desc())
        )
        if user_id is not None:
            statement = statement.where(self.tasks.c.owner_user_id == user_id)
        if limit is not None:
            statement = statement.limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
            histories = defaultdict(list)
            # Use the IDs actually selected above, so concurrent ordering
            # changes cannot substitute a different page between queries.
            ids = [row["id"] for row in rows]
            for offset in range(0, len(ids), 500):
                for row in conn.execute(
                    select(self.events.c.task_id, self.events.c.payload)
                    .where(self.events.c.task_id.in_(ids[offset : offset + 500]))
                    .order_by(self.events.c.task_id, self.events.c.sequence)
                ).mappings():
                    histories[row["task_id"]].append(row["payload"])
        return [
            materialize_task_events(histories[row["id"]])
            if histories[row["id"]]
            else row["snapshot"]
            for row in rows
        ]

    def list_tasks_for_session(self, session_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.tasks.c.snapshot)
                    .join(
                        self.task_sessions,
                        self.task_sessions.c.task_id == self.tasks.c.id,
                    )
                    .where(self.task_sessions.c.session_id == session_id)
                    .order_by(self.tasks.c.id)
                )
                .mappings()
                .all()
            )
            return [
                dict(row["snapshot"])
                for row in rows
                if not row["snapshot"].get("deletedAt")
            ]

    def thread_permission_mode(self, user_id: str, thread_id: str, *, project_id: str | None) -> str:
        """Only an unambiguous, owned Task link in the Thread's scope supplies consent."""
        tasks = self.tasks
        links = self.task_sessions
        statement = select(tasks.c.snapshot["permissionMode"].as_string()).join(
            links, links.c.task_id == tasks.c.id,
        ).where(
            links.c.session_id == thread_id,
            tasks.c.owner_user_id == user_id,
            tasks.c.project_id == project_id,
            tasks.c.deleted_at.is_(None),
            tasks.c.is_routine.is_(False),
        ).limit(2)
        with store_transaction(self.engine) as conn:
            modes = conn.scalars(statement).all()
        return "yolo" if modes == ["yolo"] else DEFAULT_TASK_PERMISSION_MODE

    def thread_tasks(
        self, user_id: str, thread_id: str, *, active_task_id: str | None,
        project_id: str | None, next_steps: list[str],
    ) -> list[dict[str, Any]]:
        """The origin, waiting work, active round, and already adopted suggestions."""
        tasks = self.tasks
        owned = _live_owned_tasks(tasks, user_id)
        newest = (tasks.c.updated_at.desc(), tasks.c.id.desc())
        recent = select(tasks.c.id).where(*owned).order_by(*newest).limit(1)
        links = self.task_sessions
        origin = recent.join(links, links.c.task_id == tasks.c.id).where(links.c.session_id == thread_id)
        linked_ids = tasks.c.snapshot["linkedSessionIds"]
        if self.engine.dialect.name == "postgresql":
            legacy_link = linked_ids.op("@>")(cast([thread_id], JSONB))
        else:
            items = func.json_each(linked_ids).table_valued("value")
            legacy_link = select(items.c.value).where(items.c.value == thread_id).exists()
        legacy_origin = recent.where(legacy_link)
        named_wait = recent.where(
            tasks.c.is_routine.is_(False), tasks.c.status == "waiting_for_human",
            tasks.c.snapshot["waitingSessionId"].as_string() == thread_id,
        )
        selected = [
            tasks.c.id == func.coalesce(origin.scalar_subquery(), legacy_origin.scalar_subquery()),
            tasks.c.id == named_wait.scalar_subquery(),
        ]
        if active_task_id and not names_no_uuid_row(self.engine, active_task_id):
            selected.append(tasks.c.id == active_task_id)
        if project_id is None or not names_no_uuid_row(self.engine, project_id):
            for title in next_steps:
                choice = recent.where(
                    tasks.c.is_routine.is_(False), tasks.c.project_id == project_id, tasks.c.title == title,
                )
                selected.append(tasks.c.id == choice.scalar_subquery())

        with store_transaction(self.engine) as conn:
            rows = list(conn.execute(select(tasks.c.snapshot, tasks.c.version).where(
                *owned, or_(*selected),
            ).order_by(*newest)).mappings())
            parents = {
                key for row in rows if (key := row["snapshot"].get("sourceRoutineId"))
                and not names_no_uuid_row(self.engine, key)
            } - {row["snapshot"]["id"] for row in rows}
            if parents:
                rows.extend(conn.execute(select(tasks.c.snapshot, tasks.c.version).where(
                    *owned, tasks.c.is_routine.is_(True), tasks.c.id.in_(sorted(parents)),
                ).order_by(*newest)).mappings())
        return [
            compact_task_summary(
                row["snapshot"], event_count=int(row["version"] or 0),
                activity_count=int(row["snapshot"].get("activityCount") or 0),
            ) for row in rows
        ]

    def occurrence_positions(
        self, occurrence_ids: list[str], user_id: str, *,
        limit: int, before: tuple[str, str, str] | None = None,
    ) -> list[tuple[str, str, str]]:
        """Read only the run positions needed for the requested ledger page."""
        ids = [key for key in dict.fromkeys(occurrence_ids) if not names_no_uuid_row(self.engine, key)]
        if not ids:
            return []
        tasks = self.tasks
        snapshot = tasks.c.snapshot
        scheduled = func.coalesce(
            func.nullif(snapshot["scheduledFor"].as_string(), ""), snapshot["dueDate"].as_string(), "",
        )
        created = func.coalesce(snapshot["createdAt"].as_string(), "")
        record_id = cast(tasks.c.id, Text)
        statement = select(scheduled, created, record_id).where(
            tasks.c.deleted_at.is_(None), tasks.c.owner_user_id == user_id,
        )
        if before is not None:
            statement = statement.where(tuple_(scheduled, created, record_id) < before)
        statement = statement.order_by(scheduled.desc(), created.desc(), record_id.desc()).limit(limit)
        rows: list[tuple[str, str, str]] = []
        with store_transaction(self.engine) as conn:
            for start in range(0, len(ids), 500):
                rows.extend((when, started, key) for when, started, key in conn.execute(
                    statement.where(tasks.c.id.in_(ids[start:start + 500])),
                ))
        return sorted(rows, reverse=True)[:limit]

    def thread_list_task_links(
        self, session_ids: list[str], user_id: str,
    ) -> tuple[list[dict[str, Any]], set[str]]:
        if not session_ids:
            return [], set()
        tasks, links = self.tasks, self.task_sessions
        parent = tasks.alias("parent_routine")
        waiting_session = tasks.c.snapshot["waitingSessionId"].as_string()
        source_routine = tasks.c.snapshot["sourceRoutineId"].as_string()
        filters = _live_owned_tasks(tasks, user_id)
        # Rank narrow link rows first so only the winning Tasks need snapshot
        # fields and parent titles. A Thread can have many historical links.
        ranked = (
            select(
                links.c.session_id, tasks.c.id.label("task_id"),
                func.row_number().over(
                    partition_by=links.c.session_id,
                    order_by=(tasks.c.updated_at.desc(), tasks.c.id.desc()),
                ).label("position"),
            )
            .select_from(links.join(tasks, links.c.task_id == tasks.c.id))
            .where(links.c.session_id.in_(session_ids), *filters)
            .subquery()
        )
        linked = (
            select(ranked.c.session_id.label("sessionId"), tasks.c.id, tasks.c.number,
                   tasks.c.title, tasks.c.status, tasks.c.is_routine.label("isRoutine"),
                   source_routine.label("sourceRoutineId"), parent.c.title.label("sourceTitle"),
                   waiting_session.label("waitingSessionId"))
            .select_from(ranked.join(tasks, tasks.c.id == ranked.c.task_id))
            .outerjoin(parent, and_(cast(parent.c.id, Text) == source_routine, *_live_owned_tasks(parent, user_id)))
            .where(ranked.c.position == 1)
        )
        named_waits = select(waiting_session).distinct().where(
            *filters, tasks.c.is_routine.is_(False), tasks.c.status == "waiting_for_human",
            waiting_session.in_(session_ids),
        )
        with store_transaction(self.engine) as conn:
            results = [dict(row) for row in conn.execute(linked).mappings()]
            waiting = {str(session_id) for session_id in conn.scalars(named_waits)}
        return results, waiting

    def count_home_tasks_needing_attention(self, user_id: str, snoozed: dict[str, str]) -> int:
        tasks = self.tasks
        statement = select(func.count()).select_from(tasks).where(
            *_live_owned_tasks(tasks, user_id),
            func.coalesce(tasks.c.assignee_user_id, tasks.c.owner_user_id) == user_id,
            tasks.c.is_routine.is_(False), tasks.c.status.in_(("review", "waiting_for_human")),
        )
        if snoozed:
            stamp = func.coalesce(tasks.c.snapshot["updatedAt"].as_string(), "")
            statement = statement.where(tuple_(cast(tasks.c.id, Text), stamp).not_in(list(snoozed.items())))
        with store_transaction(self.engine) as conn:
            return int(conn.scalar(statement) or 0)

    def home_tasks(self, user_id: str) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any] | None]:
        """Candidates for the Home panels plus each Project's full rollup."""
        tasks = self.tasks
        scope = _live_owned_tasks(tasks, user_id)
        personal = func.coalesce(tasks.c.assignee_user_id, tasks.c.owner_user_id) == user_id
        project_counts = select(
            tasks.c.project_id, tasks.c.status, tasks.c.is_routine,
            func.count().label("total"), func.max(tasks.c.snapshot["updatedAt"].as_string()).label("updated_at"),
        ).where(*scope, tasks.c.project_id.is_not(None)).group_by(
            tasks.c.project_id, tasks.c.status, tasks.c.is_routine,
        ).order_by(tasks.c.project_id, tasks.c.status, tasks.c.is_routine)

        read = select(tasks.c.snapshot).where(*scope, personal)
        created = tasks.c.snapshot["createdAt"].as_string()
        intake = select(
            func.count().label("count"), func.min(created).label("first"), func.max(created).label("last"),
        ).select_from(tasks).where(
            *scope, personal, tasks.c.is_routine.is_(False),
            tasks.c.status.not_in(("done", "cancelled")),
            tasks.c.project_id.is_(None),
            func.coalesce(tasks.c.snapshot["computerId"].as_string(), "") == "",
            func.coalesce(tasks.c.snapshot["sourceRoutineId"].as_string(), "") == "",
        )
        recent = (tasks.c.updated_at.desc(), tasks.c.id.desc())
        upcoming = or_(tasks.c.due_date.is_not(None), tasks.c.snapshot["scheduledFor"].as_string().is_not(None))
        open_issues = or_(
            upcoming,
            tasks.c.snapshot["prerequisiteTaskIds"].as_string().is_not(None),
            tasks.c.status.in_(("assigned", "queued", "waiting_for_human", "review", "blocked")),
            and_(tasks.c.status == "backlog", or_(tasks.c.assigned_agent_id.is_not(None), tasks.c.assigned_team_id.is_not(None))),
        )
        candidates = read.where(tasks.c.status != "done", or_(
            and_(tasks.c.is_routine.is_(False), open_issues),
            and_(tasks.c.is_routine.is_(True), tasks.c.routine_state == "active",
                 tasks.c.routine_next_run_at.is_not(None)),
        )).order_by(*recent)
        finished = read.where(tasks.c.status == "done", tasks.c.is_routine.is_(False)).order_by(
            func.coalesce(tasks.c.snapshot["finishedAt"].as_string(), tasks.c.snapshot["updatedAt"].as_string()).desc(),
            *recent,
        ).limit(5)

        summaries: dict[str, Any] = {}
        with store_transaction(self.engine) as conn:
            rows = [*conn.scalars(candidates), *conn.scalars(finished)]
            untriaged = conn.execute(intake).mappings().one()
            for row in conn.execute(project_counts).mappings():
                summary = summaries.setdefault(row["project_id"], {
                    "total": 0, "progress": dict.fromkeys(("done", "review", "running", "blocked"), 0), "updatedAt": "",
                })
                summary["updatedAt"] = max(summary["updatedAt"], row["updated_at"] or "")
                if not row["is_routine"]:
                    summary["total"] += row["total"]
                    if row["status"] in summary["progress"]:
                        summary["progress"][row["status"]] = row["total"]
        return rows, summaries, ({
            "count": untriaged["count"],
            "firstCreatedAt": untriaged["first"],
            "lastCreatedAt": untriaged["last"],
        } if untriaged["count"] else None)

    def project_dashboard(self, user_id: str, project_id: str, today: date) -> dict[str, Any]:
        tasks = self.tasks
        snapshot = tasks.c.snapshot
        scope = [
            *_live_owned_tasks(tasks, user_id), tasks.c.is_routine.is_(False),
            func.coalesce(snapshot["sourceRoutineId"].as_string(), "") == "",
            false() if names_no_uuid_row(self.engine, project_id) else tasks.c.project_id == project_id,
        ]
        opened = tasks.c.status.not_in(("done", "cancelled"))
        blocked = tasks.c.status == "blocked"
        overdue = and_(opened, tasks.c.due_date < today)
        active = and_(opened, or_(
            func.coalesce(snapshot["startedAt"].as_string(), "") != "",
            tasks.c.status.in_(("running", "review", "waiting_for_human")),
        ))
        done = func.coalesce(snapshot["workflowStage"].as_string(), tasks.c.status) == "done"
        attention = or_(blocked, overdue)
        stats = select(
            func.count().label("total"),
            func.count().filter(active).label("active"),
            func.count().filter(blocked).label("blocked"),
            func.count().filter(overdue).label("overdue"),
            func.count().filter(done).label("done"),
            func.count().filter(attention).label("attention"),
            func.count().filter(tasks.c.status.in_(("assigned", "queued", "running"))).label("live"),
        ).select_from(tasks).where(*scope)
        read = select(tasks.c.id, tasks.c.number, tasks.c.title, tasks.c.status, tasks.c.due_date).where(
            *scope, attention,
        ).order_by(
            case((blocked, 0), else_=1),
            case((~blocked, tasks.c.due_date)),
            tasks.c.updated_at.desc(), tasks.c.id.desc(),
        ).limit(5)
        with store_transaction(self.engine) as conn:
            counts = conn.execute(stats).mappings().one()
            rows = conn.execute(read).mappings().all() if counts["attention"] else []
        return {
            "metrics": {key: counts[key] for key in ("total", "active", "blocked", "overdue", "done")},
            "attentionTotal": counts["attention"],
            "hasQueuedOrRunning": counts["live"] > 0,
            "attention": [
                {"task": {"id": row["id"], "number": row["number"], "title": row["title"], "dueDate": row["due_date"], "isRoutine": False},
                 "reason": "blocked" if row["status"] == "blocked" else "overdue",
                 "overdue": bool(row["due_date"] and row["due_date"] < today)}
                for row in rows
            ],
        }

    def list_task_summaries(
        self, *, user_id: str | None = None, limit: int | None = None,
        task_ids: list[str] | None = None, project_id: str | None = None,
        assigned_agent_id: str | None = None, assigned_team_id: str | None = None,
        statuses: frozenset[str] | None = None, scope: str | None = None, computer_id: str | None = None,
    ) -> list[dict[str, Any]]:
        statement = (
            select(
                self.tasks.c.snapshot.label("summary"),
                self.tasks.c.version,
            )
            .where(self.tasks.c.deleted_at.is_(None))
            # Match the full-list contract, including legacy orphan filtering.
            .where(or_(
                self.tasks.c.project_id.is_(None),
                select(projects.c.id).where(projects.c.id == self.tasks.c.project_id).exists(),
            ))
            # The id tiebreaker keeps a page stable when two tasks share an
            # instant; ``ix_tasks_live_recency`` serves this order directly.
            .order_by(self.tasks.c.updated_at.desc(), self.tasks.c.id.desc())
        )
        if user_id is not None:
            statement = statement.where(self.tasks.c.owner_user_id == user_id)
        if task_ids is not None:
            statement = statement.where(self.tasks.c.id.in_(task_ids))
        if project_id is not None:
            if names_no_uuid_row(self.engine, project_id):
                return []
            statement = statement.where(self.tasks.c.project_id == project_id)
        if computer_id is not None:
            snapshot = self.tasks.c.snapshot
            # The workspace binding wins when it exists. Unbound legacy Tasks
            # are still candidates for the browser's recorded Thread fallback.
            bound = func.coalesce(
                func.nullif(snapshot["workspaceBinding"]["computerId"].as_string(), ""),
                func.nullif(snapshot["computerId"].as_string(), ""),
            )
            statement = statement.where(self.tasks.c.project_id.is_(None), or_(bound == computer_id, bound.is_(None)))
        if assigned_agent_id is not None:
            statement = statement.where(self.tasks.c.assigned_agent_id == assigned_agent_id)
        if assigned_team_id is not None:
            statement = statement.where(self.tasks.c.assigned_team_id == assigned_team_id)
        if statuses is not None:
            statement = statement.where(self.tasks.c.status.in_(statuses))
        if scope == "automations":
            statement = statement.where(or_(
                self.tasks.c.is_routine.is_(True),
                and_(
                    self.tasks.c.status.in_(("assigned", "queued", "running", "waiting_for_human", "review")),
                    func.coalesce(self.tasks.c.snapshot["sourceRoutineId"].as_string(), "") != "",
                ),
            ))
        elif scope in ("board", "issues"):
            statement = statement.where(self.tasks.c.is_routine.is_(False))
            if scope == "board":
                statement = statement.where(func.coalesce(self.tasks.c.snapshot["sourceRoutineId"].as_string(), "") == "")
        if limit is not None:
            statement = statement.limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [
            {
                **compact_task_summary(
                    row["summary"],
                    event_count=int(row["version"] or 0),
                    activity_count=int(row["summary"].get("activityCount") or 0),
                ),
                **(
                    {"lastActivity": row["summary"]["lastActivity"]}
                    if row["summary"].get("lastActivity")
                    else {}
                ),
            }
            for row in rows
        ]

    def find_tasks_by_external_refs(self, refs: list[str]) -> list[dict[str, Any]]:
        """Live tasks imported from any of ``refs`` (``externalSource.ref``)."""
        if not refs:
            return []
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(self.tasks.c.snapshot)
                .where(self.tasks.c.external_ref.in_(refs))
                .where(self.tasks.c.deleted_at.is_(None))
            ).mappings().all()
        return [dict(row["snapshot"]) for row in rows]
