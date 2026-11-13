"""What an Account answers to at sign-in: its username, and its email.

New Accounts always carry a normalized, unique email; legacy Accounts may
carry none and keep signing in by username. Because one identifier field takes
either, an identifier must name at most one Account: an email may not equal
another Account's username (legacy usernames could contain ``@``) and a
username may not equal another Account's email. The database enforces email
uniqueness (``uq_auth_accounts_email_lower``); the cross-column rule is
checked here under ``lock_account_identities``.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Literal

from sqlalchemy import Table, func, or_, select, text

from ..core.email_address import email_lookup_key

IdentityField = Literal["username", "email"]
EMAIL_TAKEN = "An account with this email already exists."
USERNAME_TAKEN = "username already exists."
_IDENTITY_ADVISORY_LOCK_ID = 7_362_959_917_925_924_674


class AccountIdentityConflict(ValueError):
    """Another Account already answers to this username or email."""

    def __init__(self, field: IdentityField):
        self.field: IdentityField = field
        super().__init__(EMAIL_TAKEN if field == "email" else USERNAME_TAKEN)


def lock_account_identities(conn: Any) -> None:
    """Serialize identity writes so two cannot both pass the collision check.

    SQLite transactions already begin IMMEDIATE (one writer at a time)."""
    if conn.engine.dialect.name == "postgresql":
        conn.execute(
            text("SELECT pg_advisory_xact_lock(:lock_id)"),
            {"lock_id": _IDENTITY_ADVISORY_LOCK_ID},
        )


def identity_conflict(
    conn: Any,
    accounts: Table,
    *,
    username: str | None = None,
    email: str | None = None,
    exclude_account_ids: Iterable[str] = (),
) -> IdentityField | None:
    """Which of ``username``/``email`` another Account already answers to."""
    excluded = [str(account_id) for account_id in exclude_account_ids]

    def taken(condition: Any) -> bool:
        statement = select(accounts.c.id).where(condition)
        if excluded:
            statement = statement.where(accounts.c.id.not_in(excluded))
        return conn.execute(statement.limit(1)).first() is not None

    stored_email = func.lower(func.trim(accounts.c.email))
    if username and taken(or_(accounts.c.username == username, stored_email == username)):
        return "username"
    if email and taken(or_(stored_email == email, accounts.c.username == email)):
        return "email"
    return None


def conflict_from_integrity_error(error: Exception) -> AccountIdentityConflict:
    """Name the identity a unique-index violation was about.

    Reads the driver's message only: the statement text names every column."""
    message = str(getattr(error, "orig", error)).lower()
    return AccountIdentityConflict("email" if "email" in message else "username")


def accounts_answering_to(conn: Any, accounts: Table, identifier: str) -> list[Any]:
    """Every Account row ``identifier`` could mean at sign-in (at most two).

    An identifier without ``@`` is only ever a username, so a malformed
    legacy email can never shadow one."""
    key = email_lookup_key(identifier)
    if not key:
        return []
    condition: Any = accounts.c.username == key
    if "@" in key:
        condition = or_(condition, func.lower(accounts.c.email) == key)
    return list(conn.execute(select(accounts).where(condition).limit(2)).mappings().all())
