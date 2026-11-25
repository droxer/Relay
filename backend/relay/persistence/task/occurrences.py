"""Read Automation occurrences and their events without replaying Tasks individually."""

from collections import defaultdict
from datetime import UTC, datetime
from heapq import nlargest
from itertools import batched
from typing import Any

from sqlalchemy import Text, case, func, literal_column, or_, select, tuple_

from ...core.task_runs import RUN_TERMINAL_STATUSES
from ..db_time import parse_db_time
from ..engine import store_transaction
from ..sql import names_no_uuid_row
from ..tables.tasks import AUTOMATION_RUN_CREATED, AUTOMATION_RUN_SCHEDULE, LIVE_AUTOMATION_RUN
from .reducer import materialize_task_events
from .state import TaskStoreState

_RUN_FIELDS = (
    "id", "ownerUserId", "projectId", "sourceRoutineId", "workspaceBinding", "status",
    "linkedSessionIds", "scheduledFor", "dueDate", "createdAt", "routineTriggerKind", "routineTriggerSummary",
)
EventPosition = tuple[datetime, str, int]


class TaskOccurrenceReads(TaskStoreState):
    def task_run_records(
        self, owner: str, ids: list[str], *, with_timing: bool = True,
    ) -> list[dict[str, Any]]:
        """Run and file metadata for the requested Tasks, in the caller's order."""
        ids = list(dict.fromkeys(key for key in ids if not names_no_uuid_row(self.engine, key)))
        if not ids:
            return []
        tasks, events = self.tasks, self.events
        records: dict[str, dict[str, Any]] = {}
        fields = _RUN_FIELDS if with_timing else ("id", "linkedSessionIds", "workspaceBinding")
        snapshot = tasks.c.snapshot
        stale_snapshot = case((func.coalesce(snapshot["eventCount"].as_integer(), -1) != tasks.c.version, snapshot))
        statement = select(
            *(snapshot[key].label(key) for key in fields), stale_snapshot.label("stale_snapshot"),
        ).where(
            tasks.c.owner_user_id == owner, tasks.c.deleted_at.is_(None),
        )
        if with_timing:
            status = events.c.payload["status"].as_string()
            status_events = select(events.c.payload).where(
                events.c.task_id == tasks.c.id, events.c.type == "task.status",
            ).correlate(tasks).limit(1)
            statement = statement.add_columns(
                status_events.where(status == "running").order_by(events.c.sequence).scalar_subquery().label("first_running"),
                status_events.where(status.in_(RUN_TERMINAL_STATUSES)).order_by(events.c.sequence.desc()).scalar_subquery().label("last_terminal"),
                self._inline_history().label("inline_events"),
            )
        with store_transaction(self.engine) as conn:
            for batch in batched(ids, 500, strict=False):
                stale = {}
                for row in conn.execute(statement.where(tasks.c.id.in_(batch))).mappings():
                    if row["stale_snapshot"] is not None:
                        stale[row["id"]] = row["stale_snapshot"]
                        continue
                    record = {key: row[key] for key in fields if row[key] is not None}
                    if with_timing:
                        record["events"] = row["inline_events"] or [
                            item for item in (row["first_running"], row["last_terminal"]) if item is not None
                        ]
                    records[record["id"]] = record
                if stale:
                    histories: dict[str, list[dict[str, Any]]] = defaultdict(list)
                    for key, payload in conn.execute(
                        select(events.c.task_id, events.c.payload).where(events.c.task_id.in_(stale))
                        .order_by(events.c.task_id, events.c.sequence)
                    ):
                        histories[key].append(payload)
                    for key, old_snapshot in stale.items():
                        current = materialize_task_events(histories[key]) if histories[key] else old_snapshot
                        records[key] = {field: current[field] for field in fields if field in current and current[field] is not None}
                        if with_timing:
                            records[key]["events"] = current.get("events") or []
        return [records[key] for key in ids if key in records]

    def occurrence_positions(
        self, automation_id: str, owner: str, *, limit: int,
        before: tuple[str, str, str] | None = None,
    ) -> list[tuple[str, str, str]]:
        """Seek directly into the Automation ledger's ordered index."""
        tasks = self.tasks.c
        position = (
            literal_column(AUTOMATION_RUN_SCHEDULE, Text),
            literal_column(AUTOMATION_RUN_CREATED, Text),
            tasks.id,
        )
        statement = select(*position).where(
            literal_column(LIVE_AUTOMATION_RUN), tasks.automation_id == automation_id, tasks.owner_user_id == owner,
        )
        if before is not None:
            statement = statement.where(tuple_(*position) < before)
        with store_transaction(self.engine) as conn:
            return [
                (scheduled, created, str(key)) for scheduled, created, key in conn.execute(
                    statement.order_by(*(column.desc() for column in position)).limit(limit),
                )
            ]

    def task_rollup_event_page(
        self, owner: str, task_id: str, *, include_occurrences: bool, limit: int, before: EventPosition | None,
    ) -> tuple[list[dict[str, Any]], EventPosition | None]:
        """One chronological window over the Task and its recorded occurrences."""
        tasks, events = self.tasks, self.events
        selected = tasks.c.id == task_id
        if include_occurrences:
            selected = or_(selected, tasks.c.automation_id == task_id)
        position = (events.c.timestamp, events.c.task_id, events.c.sequence)
        record_scope = (tasks.c.owner_user_id == owner, tasks.c.deleted_at.is_(None), selected)
        statement = select(*position, events.c.payload).select_from(
            events.join(tasks, tasks.c.id == events.c.task_id),
        ).where(*record_scope)
        if before:
            statement = statement.where(tuple_(*position) < before)
        statement = statement.order_by(*(column.desc() for column in position)).limit(limit + 1)

        inline = self._inline_history()
        fallback = select(tasks.c.id, inline).where(*record_scope, tasks.c.snapshot["events"].as_string().is_not(None))
        with store_transaction(self.engine) as conn:
            window = [
                ((_utc(timestamp), key, sequence), payload)
                for timestamp, key, sequence, payload in conn.execute(statement)
            ]
            for key, history in conn.execute(fallback):
                def entries(window=window, history=history, key=key):
                    yield from window
                    for sequence, payload in enumerate(history or ()):
                        timestamp = parse_db_time(payload.get("timestamp")) or datetime.min
                        anchor = (_utc(timestamp), key, sequence)
                        if before is None or anchor < before:
                            yield anchor, payload

                window = nlargest(limit + 1, entries(), key=lambda entry: entry[0])
        next_position = window[limit - 1][0] if len(window) > limit else None
        return [payload for _, payload in reversed(window[:limit])], next_position

    def _inline_history(self) -> Any:
        tasks, events = self.tasks, self.events
        has_event_rows = select(events.c.task_id).where(events.c.task_id == tasks.c.id).correlate(tasks).exists()
        return case((~has_event_rows, tasks.c.snapshot["events"]))


def _utc(value: datetime) -> datetime:
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
