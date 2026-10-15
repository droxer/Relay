"""Waitlist entries: people who asked to try Relay.

Database-only, like org settings. An entry is not a session or a task, so it is
a plain row rather than an event log. The store applies conditional updates —
"only while still invited", "only while unclaimed" — so concurrent requests
cannot both win; which transitions are allowed is decided by
``relay.services.waitlist``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Index,
    Table,
    Text,
    delete,
    func,
    insert,
    or_,
    select,
    update,
)

from ..core.ids import new_database_id
from .resource_lock import resource_transaction
from .store_common import (
    _format_iso,
    create_all_tables,
    database_id_column,
    shared_engine,
    store_transaction,
)
from .store_common import metadata as shared_metadata

WAITLIST_STATUSES = ("waiting", "invited", "joined", "declined")


class WaitlistConflictError(ValueError):
    """The entry is not in a state that allows the requested change."""


class WaitlistFullError(RuntimeError):
    """The waiting queue reached its cap (answered 503)."""


class DatabaseWaitlistStore:
    metadata = shared_metadata

    entries = Table(
        "waitlist_entries",
        metadata,
        database_id_column(),
        Column("email", Text, nullable=False, unique=True),
        Column("name", Text, nullable=True),
        Column("company", Text, nullable=True),
        Column("role", Text, nullable=True),
        Column("use_case", Text, nullable=True),
        Column("source", Text, nullable=True),
        Column("locale", Text, nullable=True),
        Column("status", Text, nullable=False),
        Column("invite_token_hash", Text, nullable=True, unique=True),
        Column("invite_expires_at", DateTime(timezone=True), nullable=True),
        Column("invited_at", DateTime(timezone=True), nullable=True),
        # Plain text, not foreign keys: under the file auth store these ids
        # name accounts and users that have no database row.
        Column("invited_by_user_id", Text, nullable=True),
        Column("account_id", Text, nullable=True),
        Column("admin_note", Text, nullable=True),
        Column("last_delivery_status", Text, nullable=True),
        Column("last_delivery_error", Text, nullable=True),
        Column("last_delivered_at", DateTime(timezone=True), nullable=True),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        CheckConstraint(
            "status IN ('waiting', 'invited', 'joined', 'declined')",
            name="ck_waitlist_entries_status",
        ),
        Index("ix_waitlist_entries_status_created_at", "status", "created_at"),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def join(
        self, fields: dict[str, Any], now: datetime, *, max_waiting: int
    ) -> tuple[dict[str, Any], bool]:
        """Admit an entry while holding the cross-replica capacity lock.

        Count and insert share one transaction. Resubmissions retain their
        original details and place; all joins answer unavailable at capacity.
        """
        with resource_transaction(self.engine, "waitlist-admission") as conn:
            if self.count("waiting") >= max_waiting:
                raise WaitlistFullError("The waitlist is not accepting new entries right now.")
            row = conn.execute(
                select(self.entries).where(self.entries.c.email == fields["email"])
            ).mappings().first()
            if row is not None:
                entry_id = str(row["id"])
                conn.execute(
                    update(self.entries).where(self.entries.c.id == entry_id).values(updated_at=now)
                )
                return self._get(conn, entry_id), False
            entry_id = new_database_id()
            conn.execute(
                insert(self.entries).values(
                    id=entry_id, status="waiting", created_at=now, updated_at=now, **fields
                )
            )
            return self._get(conn, entry_id), True

    def count(self, status: str) -> int:
        with store_transaction(self.engine) as conn:
            return int(
                conn.scalar(
                    select(func.count()).select_from(self.entries).where(self.entries.c.status == status)
                )
                or 0
            )

    def counts(self) -> dict[str, int]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(self.entries.c.status, func.count()).group_by(self.entries.c.status)
            ).all()
        found = {status: int(total) for status, total in rows}
        return {status: found.get(status, 0) for status in WAITLIST_STATUSES}

    def list(
        self,
        *,
        status: str | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        conditions = []
        if status:
            conditions.append(self.entries.c.status == status)
        if query:
            pattern = f"%{_escape_like(query.lower())}%"
            conditions.append(
                or_(
                    self.entries.c.email.like(pattern, escape="\\"),
                    func.lower(self.entries.c.name).like(pattern, escape="\\"),
                    func.lower(self.entries.c.company).like(pattern, escape="\\"),
                )
            )
        with store_transaction(self.engine) as conn:
            total = conn.scalar(select(func.count()).select_from(self.entries).where(*conditions))
            rows = conn.execute(
                select(self.entries)
                .where(*conditions)
                .order_by(self.entries.c.created_at, self.entries.c.id)
                .limit(limit)
                .offset(offset)
            ).mappings().all()
        return [_row_to_entry(row) for row in rows], int(total or 0)

    def oldest_waiting_ids(self, limit: int) -> list[str]:
        with store_transaction(self.engine) as conn:
            return [
                str(entry_id)
                for entry_id in conn.scalars(
                    select(self.entries.c.id)
                    .where(self.entries.c.status == "waiting")
                    .order_by(self.entries.c.created_at, self.entries.c.id)
                    .limit(limit)
                )
            ]

    def get(self, entry_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            return self._get(conn, entry_id)

    def find_by_token_hash(self, token_hash: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = conn.execute(
                select(self.entries).where(self.entries.c.invite_token_hash == token_hash)
            ).mappings().first()
        return _row_to_entry(row) if row else None

    def set_invite(
        self,
        entry_id: str,
        *,
        token_hash: str,
        expires_at: datetime,
        invited_by_user_id: str | None,
        now: datetime,
    ) -> dict[str, Any]:
        """Move an entry to invited; a claimed entry stays closed.

        A joined row without an account link may still be creating its account.
        It cannot safely be treated as an abandoned claim.
        """
        return self._conditional_update(
            entry_id,
            self.entries.c.status.in_(("waiting", "invited", "declined")),
            status="invited",
            invite_token_hash=token_hash,
            invite_expires_at=expires_at,
            invited_at=now,
            invited_by_user_id=invited_by_user_id,
            updated_at=now,
        )

    def decline(self, entry_id: str, now: datetime) -> dict[str, Any]:
        return self._conditional_update(
            entry_id,
            self.entries.c.status.in_(("waiting", "invited", "declined")),
            status="declined",
            invite_token_hash=None,
            invite_expires_at=None,
            updated_at=now,
        )

    def set_note(self, entry_id: str, note: str | None, now: datetime) -> dict[str, Any]:
        return self._conditional_update(entry_id, None, admin_note=note, updated_at=now)

    def record_delivery(
        self, entry_id: str, *, status: str, error: str | None, now: datetime
    ) -> dict[str, Any]:
        return self._conditional_update(
            entry_id,
            None,
            last_delivery_status=status,
            last_delivery_error=error,
            last_delivered_at=now if status == "sent" else None,
            updated_at=now,
        )

    def delete(self, entry_id: str) -> bool:
        with store_transaction(self.engine) as conn:
            result = conn.execute(delete(self.entries).where(self.entries.c.id == entry_id))
        return result.rowcount > 0

    def claim_invite(self, token_hash: str, now: datetime) -> dict[str, Any] | None:
        """Consume a live invite, or return None.

        One conditional UPDATE, so two concurrent accepts of the same token
        cannot both get an entry back. The token hash is cleared here; the
        caller restores it with ``release_claim`` if creating the account
        fails."""
        with store_transaction(self.engine) as conn:
            claimed = conn.execute(
                update(self.entries)
                .where(
                    self.entries.c.invite_token_hash == token_hash,
                    self.entries.c.status == "invited",
                    self.entries.c.invite_expires_at > now,
                )
                .values(status="joined", invite_token_hash=None, updated_at=now)
                .returning(self.entries.c.id)
            ).scalar()
            return self._get(conn, claimed) if claimed else None

    def release_claim(self, entry_id: str, token_hash: str, now: datetime) -> None:
        """Undo ``claim_invite`` when no account was created."""
        with store_transaction(self.engine) as conn:
            conn.execute(
                update(self.entries)
                .where(
                    self.entries.c.id == entry_id,
                    self.entries.c.status == "joined",
                    self.entries.c.account_id.is_(None),
                )
                .values(status="invited", invite_token_hash=token_hash, updated_at=now)
            )

    def link_account(self, entry_id: str, account_id: str, now: datetime) -> dict[str, Any]:
        return self._conditional_update(
            entry_id,
            self.entries.c.status == "joined",
            account_id=account_id,
            updated_at=now,
        )

    def _conditional_update(self, entry_id: str, condition: Any, **values: Any) -> dict[str, Any]:
        where = [self.entries.c.id == entry_id]
        if condition is not None:
            where.append(condition)
        with store_transaction(self.engine) as conn:
            result = conn.execute(update(self.entries).where(*where).values(**values))
            if result.rowcount == 0:
                if self._get(conn, entry_id) is None:
                    raise KeyError(entry_id)
                raise WaitlistConflictError("This waitlist entry has already joined.")
            entry = self._get(conn, entry_id)
        if entry is None:
            raise KeyError(entry_id)
        return entry

    def _get(self, conn: Any, entry_id: str) -> dict[str, Any] | None:
        row = conn.execute(
            select(self.entries).where(self.entries.c.id == entry_id)
        ).mappings().first()
        return _row_to_entry(row) if row else None


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _row_to_entry(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["name"],
        "company": row["company"],
        "role": row["role"],
        "useCase": row["use_case"],
        "source": row["source"],
        "locale": row["locale"],
        "status": row["status"],
        "inviteTokenHash": row["invite_token_hash"],
        "inviteExpiresAt": _format_iso(row["invite_expires_at"]),
        "invitedAt": _format_iso(row["invited_at"]),
        "invitedByUserId": row["invited_by_user_id"],
        "accountId": row["account_id"],
        "adminNote": row["admin_note"],
        "lastDeliveryStatus": row["last_delivery_status"],
        "lastDeliveryError": row["last_delivery_error"],
        "lastDeliveredAt": _format_iso(row["last_delivered_at"]),
        "createdAt": _format_iso(row["created_at"]),
        "updatedAt": _format_iso(row["updated_at"]),
    }
