"""A person's notification inbox, plus the watch state that feeds it.

Rows are plain records, not an event log: a notification is written once and
only its ``read_at`` and ``cleared_at`` change. Clearing hides a notice rather
than deleting it, so replaying a deduplicated notice cannot resurrect it. Task notifications are inserted inside the task
store's own transaction (``insert_notification_rows``), so a completed task and
its notice commit together. Computer notices come from the watcher, which
claims each observed transition through ``notification_watch_state`` with a
compare-and-set, so two backend replicas never announce the same change.

``user_id`` is text without a foreign key on purpose: a notice is written in
the middle of a task write, and an owner id the users table does not hold (a
file-store handle) must never fail that write.
"""

from __future__ import annotations

import uuid
from datetime import datetime, UTC
from typing import Any

from sqlalchemy import and_, delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..engine import create_all_tables, shared_engine, store_transaction
from ...core.ids import new_database_id
from ..tables.notifications import notifications, notification_watch_state, notification_preferences

# The inbox shows recent notices; older ones are pruned by the watcher.
MAX_LIST_LIMIT = 100





def insert_notification_rows(conn: Any, rows: list[dict[str, Any]]) -> None:
    """Insert notices; a dedupeKey identifies one notice per recipient/kind.

    Replaying that notice preserves its original read state and creation time.
    """
    now = datetime.now(UTC)
    for row in rows:
        dedupe_key = row.get("dedupeKey")
        notice_id = (
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"relay.notification/{row['user_id']}/{row['kind']}/{dedupe_key}"))
            if dedupe_key else new_database_id()
        )
        dialect_insert = postgresql_insert if conn.dialect.name == "postgresql" else sqlite_insert
        statement = dialect_insert(notifications).values(
            id=notice_id, user_id=row["user_id"], kind=row["kind"],
            data=row["data"], created_at=now, read_at=None,
        )
        if dedupe_key:
            statement = statement.on_conflict_do_nothing(index_elements=[notifications.c.id])
        conn.execute(statement)


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat().replace("+00:00", "Z")


def _public(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "kind": row["kind"],
        "data": row["data"] or {},
        "createdAt": _iso(row["created_at"]),
        "readAt": _iso(row["read_at"]),
    }


class DatabaseNotificationStore:
    def __init__(self, database_url: str, *, create_schema: bool = False) -> None:
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def add(self, rows: list[dict[str, Any]]) -> None:
        if rows:
            with store_transaction(self.engine) as conn:
                insert_notification_rows(conn, rows)

    @staticmethod
    def _visible(user_id: str, muted: list[str]) -> Any:
        clause = and_(notifications.c.user_id == user_id, notifications.c.cleared_at.is_(None))
        return and_(clause, notifications.c.kind.not_in(muted)) if muted else clause

    @staticmethod
    def _owned(user_id: str, ids: list[str] | None) -> list[Any] | None:
        """The caller's uncleared notices named by ``ids`` (all when None), or
        None when no id can name one. Ids belonging to someone else are
        ignored rather than reported."""
        where = [notifications.c.user_id == user_id, notifications.c.cleared_at.is_(None)]
        if ids is None:
            return where
        # Not a uuid cannot name a notice; Postgres would reject the bind.
        ids = [item for item in ids if _is_uuid(item)]
        return [*where, notifications.c.id.in_(ids)] if ids else None

    def list_for_user(self, user_id: str, *, limit: int = 50) -> dict[str, Any]:
        """Recent notices and the unread count, both without muted kinds —
        muting hides, so unmuting a kind brings its notices back."""
        limit = max(1, min(limit, MAX_LIST_LIMIT))
        with store_transaction(self.engine) as conn:
            visible = self._visible(user_id, self._muted_kinds(conn, user_id))
            rows = conn.execute(
                select(notifications).where(visible)
                .order_by(notifications.c.created_at.desc(), notifications.c.id.desc())
                .limit(limit)
            ).mappings().all()
            unread = conn.execute(
                select(func.count()).select_from(notifications)
                .where(visible, notifications.c.read_at.is_(None))
            ).scalar_one()
        return {"notifications": [_public(row) for row in rows], "unreadCount": int(unread)}

    def mark_read(self, user_id: str, ids: list[str] | None) -> None:
        """Mark the given notices read, or every unread one when ``ids`` is None."""
        where = self._owned(user_id, ids)
        if where is None:
            return
        with store_transaction(self.engine) as conn:
            conn.execute(
                update(notifications).where(*where, notifications.c.read_at.is_(None))
                .values(read_at=datetime.now(UTC))
            )

    def clear(self, user_id: str, ids: list[str] | None) -> None:
        """Remove the given notices from the inbox, or all of them when ``ids``
        is None. Muted notices are cleared too: clearing all means all."""
        where = self._owned(user_id, ids)
        if where is None:
            return
        with store_transaction(self.engine) as conn:
            conn.execute(update(notifications).where(*where).values(cleared_at=datetime.now(UTC)))

    def prune(self, before: datetime) -> int:
        with store_transaction(self.engine) as conn:
            return conn.execute(delete(notifications).where(notifications.c.created_at < before)).rowcount

    def muted_kinds(self, user_id: str) -> list[str]:
        with store_transaction(self.engine) as conn:
            return self._muted_kinds(conn, user_id)

    @staticmethod
    def _muted_kinds(conn: Any, user_id: str) -> list[str]:
        value = conn.execute(
            select(notification_preferences.c.muted_kinds)
            .where(notification_preferences.c.user_id == user_id)
        ).scalar_one_or_none()
        return [kind for kind in value if isinstance(kind, str)] if isinstance(value, list) else []

    def set_muted_kinds(self, user_id: str, kinds: list[str]) -> list[str]:
        now = datetime.now(UTC)
        with store_transaction(self.engine) as conn:
            dialect_insert = postgresql_insert if conn.dialect.name == "postgresql" else sqlite_insert
            statement = dialect_insert(notification_preferences).values(
                user_id=user_id, muted_kinds=kinds, updated_at=now,
            )
            conn.execute(statement.on_conflict_do_update(
                index_elements=[notification_preferences.c.user_id],
                set_={"muted_kinds": statement.excluded.muted_kinds, "updated_at": statement.excluded.updated_at},
            ))
        return kinds

    def watch_states(self, prefix: str) -> dict[str, str]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(notification_watch_state.c.subject_key, notification_watch_state.c.state)
                .where(notification_watch_state.c.subject_key.startswith(prefix, autoescape=True))
            ).all()
        return {key: state for key, state in rows}

    def claim_transition(
        self, subject_key: str, previous: str | None, state: str, rows: list[dict[str, Any]],
    ) -> bool:
        """Move ``subject_key`` from ``previous`` (None: never observed) to
        ``state`` and insert ``rows`` in the same transaction. Returns False,
        writing nothing, when another writer moved it first."""
        try:
            return self._claim_transition(subject_key, previous, state, rows)
        except IntegrityError:
            return False  # Another replica recorded the first sighting.

    def _claim_transition(
        self, subject_key: str, previous: str | None, state: str, rows: list[dict[str, Any]],
    ) -> bool:
        now = datetime.now(UTC)
        with store_transaction(self.engine) as conn:
            if previous is None:
                exists = conn.execute(
                    select(notification_watch_state.c.subject_key)
                    .where(notification_watch_state.c.subject_key == subject_key)
                ).first()
                if exists:
                    return False
                conn.execute(insert(notification_watch_state).values(
                    subject_key=subject_key, state=state, updated_at=now,
                ))
            else:
                won = conn.execute(
                    update(notification_watch_state)
                    .where(notification_watch_state.c.subject_key == subject_key,
                           notification_watch_state.c.state == previous)
                    .values(state=state, updated_at=now)
                ).rowcount == 1
                if not won:
                    return False
            insert_notification_rows(conn, rows)
        return True

    def forget_watch_states(self, keys: list[str]) -> None:
        if keys:
            with store_transaction(self.engine) as conn:
                conn.execute(delete(notification_watch_state).where(notification_watch_state.c.subject_key.in_(keys)))
