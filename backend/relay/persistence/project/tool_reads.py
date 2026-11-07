"""Owner/Project-scoped tool queries; counts and pagination precede hydration."""

from datetime import datetime
from typing import Any

from sqlalchemy import Text, cast, func, literal, select, tuple_, union_all

from ..engine import store_transaction
from ..tables.tasks import tasks, events as task_events
from ..tables.sessions import sessions, events as session_events
from ..tables.projects import events_table as project_events, projects
from ..task.rows import compact_task_summary
from ..sql import names_no_uuid_row


class ProjectToolReads:
    engine: Any

    def project_task_page(
        self, project_id: str, owner: str, *, limit: int = 50, cursor: str = "",
        status: str = "", query: str = "", recent: bool = False,
    ) -> dict[str, Any]:
        filters = [tasks.c.project_id == project_id, tasks.c.owner_user_id == owner, tasks.c.deleted_at.is_(None)]
        if status:
            filters.append(tasks.c.status == status)
        if query:
            # A persisted Python casefold preserves Unicode substring search
            # identically on SQLite and PostgreSQL (including Straße/STRASSE).
            filters.append(tasks.c.title_casefold.contains(query.casefold(), autoescape=True))
        statement = select(tasks.c.snapshot, tasks.c.version).where(*filters)
        if recent:
            statement = statement.where(tasks.c.is_routine.is_(False)).order_by(tasks.c.updated_at.desc(), tasks.c.id.desc())
        else:
            if cursor:
                column = cast(tasks.c.id, Text) if names_no_uuid_row(self.engine, cursor) else tasks.c.id
                statement = statement.where(column > cursor)
            statement = statement.order_by(tasks.c.id)
        with store_transaction(self.engine) as conn:
            total = int(conn.scalar(select(func.count()).select_from(tasks).where(*filters)) or 0)
            rows = conn.execute(statement.limit(limit + 1)).mappings().all()
        page = [compact_task_summary(row["snapshot"], event_count=int(row["version"])) for row in rows[:limit]]
        return {"tasks": page, "total": total, "nextCursor": page[-1]["id"] if len(rows) > limit else None}

    def project_task_counts(self, project_id: str, owner: str) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(tasks.c.status, tasks.c.is_routine, func.count().label("n")).where(
                tasks.c.project_id == project_id, tasks.c.owner_user_id == owner, tasks.c.deleted_at.is_(None),
            ).group_by(tasks.c.status, tasks.c.is_routine)).mappings().all()
        return {"counts": {row["status"]: int(row["n"]) for row in rows if not row["is_routine"]},
                "automationCount": sum(int(row["n"]) for row in rows if row["is_routine"])}

    def project_activity_page(
        self, project_id: str, owner: str, *, since: datetime | None, cutoff: datetime,
        cursor: int, limit: int,
    ) -> dict[str, Any]:
        sources = []
        for kind, entity, events, foreign_key, filters in (
            ("task", tasks, task_events, task_events.c.task_id, [tasks.c.deleted_at.is_(None)]),
            ("thread", sessions, session_events, session_events.c.session_id, [session_events.c.type == "agent.completed"]),
        ):
            statement = select(
                literal(kind).label("kind"), entity.c.id.label("entity_id"),
                events.c.sequence, events.c.timestamp,
            ).select_from(events.join(entity, foreign_key == entity.c.id)).where(
                entity.c.project_id == project_id, entity.c.owner_user_id == owner,
                events.c.timestamp <= cutoff, *filters,
            )
            if since is not None:
                statement = statement.where(events.c.timestamp >= since)
            sources.append(statement)
        project_source = select(
            literal("project").label("kind"), project_events.c.project_id.label("entity_id"),
            project_events.c.sequence, project_events.c.timestamp,
        ).select_from(project_events.join(projects, projects.c.id == project_events.c.project_id)).where(
            project_events.c.project_id == project_id, projects.c.owner_user_id == owner,
            project_events.c.timestamp <= cutoff,
        )
        if since is not None:
            project_source = project_source.where(project_events.c.timestamp >= since)
        sources.append(project_source)
        # Count and sort only scalar columns. Fetch payloads for the selected
        # page, never full event histories or thread snapshots.
        combined = union_all(*sources).subquery()
        with store_transaction(self.engine) as conn:
            total = int(conn.scalar(select(func.count()).select_from(combined)) or 0)
            page = conn.execute(select(combined).order_by(
                combined.c.timestamp, combined.c.entity_id, combined.c.sequence, combined.c.kind,
            ).offset(cursor).limit(limit)).mappings().all()
            payloads = {}
            for kind, table, foreign_key in (
                ("task", task_events, task_events.c.task_id),
                ("thread", session_events, session_events.c.session_id),
                ("project", project_events, project_events.c.project_id),
            ):
                keys = [(row["entity_id"], row["sequence"]) for row in page if row["kind"] == kind]
                if keys:
                    for event in conn.execute(select(foreign_key, table.c.sequence, table.c.payload).where(
                        tuple_(foreign_key, table.c.sequence).in_(keys),
                    )):
                        payloads[(kind, str(event[0]), event.sequence)] = event.payload
            result = [{"kind": row["kind"], "entityId": str(row["entity_id"]), "sequence": row["sequence"],
                       "event": payloads[(row["kind"], str(row["entity_id"]), row["sequence"])]} for row in page
                      if (row["kind"], str(row["entity_id"]), row["sequence"]) in payloads]
        return {"events": result, "total": total, "nextCursor": cursor + limit if total > cursor + limit else None}
