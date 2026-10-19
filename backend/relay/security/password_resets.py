"""Password reset links, kept in ``auth_password_resets`` beside the accounts.

A link is a random token whose SHA-256 is stored with the Account it resets.
Issuing one spends every older open link for that Account, and redeeming one
spends the rest, so at most one link per Account works at a time. Redeeming
sets the password and drops every session in one transaction.

Which Accounts a request reaches, how often, and what gets emailed is decided
by ``relay.accounts.password_reset``; this module only keeps the records.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, UTC
from typing import Any

from sqlalchemy import delete, func, insert, or_, select, update

from ..core.ids import new_database_id
from ..persistence.engine import store_transaction
from .auth import DatabaseAccountAuthStore
from .credentials import hash_password
from .passwords import validate_password

# Spent and expired rows stay this long so the hourly request cap can count them.
RETENTION = timedelta(days=1)
RECENT_WINDOW = timedelta(hours=1)


@dataclass(frozen=True)
class ResetAccount:
    """The Account a link resets, and where its email goes (None: nowhere)."""

    account_id: str
    username: str
    email: str | None
    language: str | None


@dataclass(frozen=True)
class LiveReset:
    account: ResetAccount
    expires_at: datetime


@dataclass(frozen=True)
class ResetThrottle:
    """How often one Account may be sent a link: a minimum gap plus an hourly cap."""

    min_interval: timedelta
    max_per_hour: int


class ResetNotLiveError(Exception):
    """The token is unknown, spent, expired, or its Account is gone."""


def new_reset_token() -> str:
    return secrets.token_urlsafe(32)


def hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _recipient(*addresses: str | None) -> str | None:
    """The Account's own address, else its User's."""
    for address in addresses:
        if address and address.strip():
            return address.strip()
    return None


def _utc(value: datetime) -> datetime:
    # SQLite hands back naive datetimes; Relay writes every timestamp as UTC.
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _throttled(created: list[datetime], now: datetime, throttle: ResetThrottle | None) -> bool:
    if throttle is None:
        return False
    recent = [stamp for stamp in created if stamp > now - RECENT_WINDOW]
    if len(recent) >= throttle.max_per_hour:
        return True
    return any(stamp > now - throttle.min_interval for stamp in recent)


def _matches(identifier: str, account: ResetAccount) -> bool:
    if "@" in identifier:
        if not account.email:
            return False
        return account.email.lower() == identifier
    return account.username == identifier


class DatabasePasswordResetStore:
    """Reset records in ``auth_password_resets``, beside the accounts they reset."""

    def __init__(self, auth_store: DatabaseAccountAuthStore):
        self._auth = auth_store
        self.engine = auth_store.engine
        self.resets = auth_store.password_resets
        self.accounts = auth_store.accounts
        self.users = auth_store.users
        self.sessions = auth_store.sessions

    def accounts_for(self, identifier: str) -> list[ResetAccount]:
        if "@" in identifier:
            condition = or_(
                func.lower(self.accounts.c.email) == identifier,
                func.lower(self.users.c.email) == identifier,
            )
        else:
            condition = self.accounts.c.username == identifier
        with store_transaction(self.engine) as conn:
            rows = conn.execute(self._account_query().where(condition)).mappings().all()
        # The SQL match is loose (either column); the resolved address decides.
        return [
            account
            for account in (self._reset_account(row) for row in rows)
            if _matches(identifier, account)
        ]

    def account_for_user(self, user_id: str) -> ResetAccount | None:
        resolved = self._auth.resolve_user_id(user_id)
        if not resolved:
            return None
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    self._account_query()
                    .where(self.accounts.c.user_id == resolved)
                    .order_by(self.accounts.c.created_at)
                )
                .mappings()
                .first()
            )
        return self._reset_account(row) if row else None

    def issue(
        self,
        account_id: str,
        token_hash: str,
        *,
        now: datetime,
        expires_at: datetime,
        throttle: ResetThrottle | None,
    ) -> bool:
        resets = self.resets
        with store_transaction(self.engine) as conn:
            # Serialize issues for one Account: without the row lock, two
            # concurrent requests each miss the other's insert, both pass the
            # throttle, and both links stay live.
            conn.execute(
                select(self.accounts.c.id)
                .where(self.accounts.c.id == account_id)
                .with_for_update()
            )
            conn.execute(delete(resets).where(resets.c.expires_at <= now - RETENTION))
            created = conn.execute(
                select(resets.c.created_at).where(
                    resets.c.account_id == account_id,
                    resets.c.created_at > now - RECENT_WINDOW,
                )
            ).scalars()
            if _throttled([_utc(stamp) for stamp in created], now, throttle):
                return False
            conn.execute(
                update(resets)
                .where(resets.c.account_id == account_id, resets.c.used_at.is_(None))
                .values(used_at=now)
            )
            conn.execute(
                insert(resets).values(
                    id=new_database_id(),
                    account_id=account_id,
                    token_hash=token_hash,
                    created_at=now,
                    expires_at=expires_at,
                )
            )
        return True

    def peek(self, token_hash: str, *, now: datetime) -> LiveReset | None:
        with store_transaction(self.engine) as conn:
            row = conn.execute(self._live_query(token_hash, now)).mappings().first()
        if row is None:
            return None
        return LiveReset(self._reset_account(row), _utc(row["reset_expires_at"]))

    def complete(self, token_hash: str, password: str, *, now: datetime) -> ResetAccount:
        resets = self.resets
        with store_transaction(self.engine) as conn:
            row = conn.execute(self._live_query(token_hash, now)).mappings().first()
            if row is None:
                raise ResetNotLiveError
            # Issuance locks the Account before touching reset rows. Use the
            # same order here, then recheck: a reissue may have retired this
            # link while we were waiting for that Account lock.
            conn.execute(
                select(self.accounts.c.id)
                .where(self.accounts.c.id == row["id"])
                .with_for_update()
            )
            row = conn.execute(self._live_query(token_hash, now)).mappings().first()
            if row is None:
                raise ResetNotLiveError
            claimed = conn.execute(
                update(resets)
                .where(resets.c.id == row["reset_id"], resets.c.used_at.is_(None))
                .values(used_at=now)
            )
            if claimed.rowcount == 0:
                raise ResetNotLiveError  # A concurrent redemption won.
            # Raising here rolls the claim back, so a refused password leaves
            # the link usable for another try.
            validate_password(
                password,
                identifiers=(
                    row["username"],
                    row["handle"],
                    row["display_name"],
                    _recipient(row["account_email"], row["user_email"]),
                ),
            )
            account_id = row["id"]
            conn.execute(
                update(self.accounts)
                .where(self.accounts.c.id == account_id)
                .values(password_hash=hash_password(password), updated_at=now)
            )
            conn.execute(
                update(resets)
                .where(resets.c.account_id == account_id, resets.c.used_at.is_(None))
                .values(used_at=now)
            )
            conn.execute(delete(self.sessions).where(self.sessions.c.account_id == account_id))
        return self._reset_account(row)

    def _account_query(self, *extra: Any) -> Any:
        """Accounts whose User (if any) is not soft-deleted, with both addresses."""
        accounts, users = self.accounts, self.users
        return (
            select(
                accounts.c.id,
                accounts.c.username,
                accounts.c.email.label("account_email"),
                accounts.c.language,
                users.c.email.label("user_email"),
                users.c.handle,
                users.c.display_name,
                *extra,
            )
            .select_from(accounts.outerjoin(users, accounts.c.user_id == users.c.id))
            .where(users.c.deleted_at.is_(None))
        )

    def _live_query(self, token_hash: str, now: datetime) -> Any:
        resets = self.resets
        return (
            self._account_query(
                resets.c.id.label("reset_id"), resets.c.expires_at.label("reset_expires_at")
            )
            .join(resets, resets.c.account_id == self.accounts.c.id)
            .where(
                resets.c.token_hash == token_hash,
                resets.c.used_at.is_(None),
                resets.c.expires_at > now,
            )
        )

    @staticmethod
    def _reset_account(row: Any) -> ResetAccount:
        return ResetAccount(
            account_id=str(row["id"]),
            username=row["username"],
            email=_recipient(row["account_email"], row["user_email"]),
            language=row["language"],
        )


def password_reset_store_for(auth_store: DatabaseAccountAuthStore) -> DatabasePasswordResetStore:
    return DatabasePasswordResetStore(auth_store)
