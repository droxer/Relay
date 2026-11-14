"""A person's tags: the names they saved and the tags on their own work.

A mixin of ``DatabaseTaskStore``. Saved names live in ``user_tags``; tags on
work stay in each Task and Automation snapshot, so ``tag_usage_rows`` reads
them from there and a catalog operation changes them only through a
``task.updated`` event (``rewrite_task_tags``), never by editing a snapshot
or an earlier event. ``relay/tags/catalog.py`` is the one caller; it wraps
reads and writes in ``resource_transaction`` so they commit together.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, insert, or_, select
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..engine import store_transaction
from ..events import relay_task_event
from ..tables.projects import projects
from ..tables.tags import user_tags
from .state import TaskStoreState


class TaskTagRows(TaskStoreState):
    def tag_usage_rows(
        self, owner: str, *, lock_ids: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """Every live, listed Task and Automation ``owner`` owns that carries a
        tag, with the version a preview pins. ``lock_ids`` narrows the read to
        those rows and holds them for update until the transaction ends."""
        tasks = self.tasks
        statement = (
            select(
                tasks.c.id, tasks.c.title, tasks.c.number, tasks.c.is_routine,
                tasks.c.project_id, tasks.c.version, tasks.c.snapshot["tags"].label("tags"),
            )
            .where(tasks.c.owner_user_id == owner, tasks.c.deleted_at.is_(None))
            # The same orphan rule as the task list, so counts match what it shows.
            .where(or_(
                tasks.c.project_id.is_(None),
                select(projects.c.id).where(projects.c.id == tasks.c.project_id).exists(),
            ))
            .order_by(tasks.c.id)
        )
        if lock_ids is not None:
            if not lock_ids:
                return []
            statement = statement.where(tasks.c.id.in_(lock_ids)).with_for_update(of=tasks)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [
            {
                "id": str(row["id"]),
                "title": row["title"],
                "number": row["number"],
                "isRoutine": bool(row["is_routine"]),
                "projectId": str(row["project_id"]) if row["project_id"] else None,
                "version": int(row["version"] or 0),
                "tags": [tag for tag in row["tags"] if isinstance(tag, str)],
            }
            for row in rows
            if isinstance(row["tags"], list) and row["tags"]
        ]

    def saved_tags(self, owner: str) -> list[dict[str, str]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(user_tags.c.name_key, user_tags.c.name)
                .where(user_tags.c.user_id == owner)
                .order_by(user_tags.c.name_key)
            ).mappings().all()
        return [{"key": row["name_key"], "name": row["name"]} for row in rows]

    def save_tag(self, owner: str, name: str) -> bool:
        """Save ``name``; False when ``owner`` already saved that tag."""
        with store_transaction(self.engine) as conn:
            dialect_insert = postgresql_insert if conn.dialect.name == "postgresql" else sqlite_insert
            inserted = conn.execute(
                dialect_insert(user_tags)
                .values(user_id=owner, name_key=name.casefold(), name=name,
                        created_at=datetime.now(UTC))
                .on_conflict_do_nothing(index_elements=[user_tags.c.user_id, user_tags.c.name_key])
                # rowcount is unreliable for a skipped conflict on psycopg.
                .returning(user_tags.c.name_key)
            ).first()
        return inserted is not None

    def replace_saved_tags(self, owner: str, remove_keys: list[str], name: str | None) -> None:
        """Forget ``remove_keys`` and, when given, save ``name`` in their place."""
        with store_transaction(self.engine) as conn:
            keys = [*remove_keys, *([name.casefold()] if name else [])]
            conn.execute(
                delete(user_tags).where(user_tags.c.user_id == owner, user_tags.c.name_key.in_(keys))
            )
            if name:
                conn.execute(insert(user_tags).values(
                    user_id=owner, name_key=name.casefold(), name=name,
                    created_at=datetime.now(UTC),
                ))

    def rewrite_task_tags(
        self, task_id: str, tags: list[str], *, actor_user_id: str, operation: str
    ) -> dict[str, Any]:
        """Record ``tags`` on the task as a person's edit, naming the catalog
        operation that made it; status, assignment, and schedule are untouched."""
        event = relay_task_event("task.updated", task_id, {
            "tags": list(tags), "actorUserId": actor_user_id, "tagOperation": operation,
        })
        return self.append_events(task_id, [event])
