"""Accounts: creating, authenticating, bootstrapping, and their preferences."""

from __future__ import annotations

from datetime import datetime, UTC
from typing import Any, Literal

from fastapi import HTTPException
from loguru import logger
from sqlalchemy import (
    insert,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError

from .admin_token import admin_token_configured, verify_admin_token
from .auth_cache import SESSION_ACCOUNTS
from .auth_rows import database_account_to_row, public_account, row_to_database_account
from .auth_state import AuthStoreState
from .credentials import hash_password, verify_password
from .entity_ids import USER_ENTITY_KIND, database_id_for_reference, normalize_database_id
from .home_snoozes import apply_home_snoozes_patch
from .onboarding import apply_onboarding_patch
from .passwords import validate_password
from ..core.ids import new_database_id
from ..persistence.db_time import format_db_time
from ..persistence.engine import store_transaction
from ..core.user_preferences import (
    DEFAULT_USER_LANGUAGE,
    DEFAULT_USER_THEME,
    USER_LANGUAGES,
    USER_THEMES,
    UserLanguage,
    UserTheme,
)

UserRole = Literal["admin", "user"]
_BOOTSTRAP_ADVISORY_LOCK_ID = 7_362_959_917_925_924_673


class AuthAccounts(AuthStoreState):
    def has_accounts(self) -> bool:
        with store_transaction(self.engine) as conn:
            return conn.execute(select(self.accounts.c.id).limit(1)).first() is not None

    def create_account(
        self,
        username: str,
        password: str,
        role: UserRole = "user",
        email: str | None = None,
        user_id: str | None = None,
        display_name: str | None = None,
        department_id: str | None = None,
        department_name: str | None = None,
        max_local_computers: int | None = None,
    ) -> dict[str, Any]:
        username = username.strip().lower()
        if not username:
            raise ValueError("username is required.")
        validate_password(
            password, identifiers=(username, user_id, display_name, email)
        )
        if role not in ("admin", "user"):
            raise ValueError("role must be admin or user.")
        requested_handle = (
            None
            if not user_id or normalize_database_id(user_id)
            else user_id.strip()
        )
        user_id = (
            database_id_for_reference(user_id, USER_ENTITY_KIND)
            if user_id
            else new_database_id()
        )
        display_name = display_name.strip() if display_name else username
        department_id = department_id.strip() if department_id else None
        department_name = department_name.strip() if department_name else None
        email = email.strip() if email else None

        now = datetime.now(UTC)
        account = {
            "id": new_database_id(),
            "username": username,
            "email": email,
            "role": role,
            "userId": None,
            "theme": DEFAULT_USER_THEME,
            "language": DEFAULT_USER_LANGUAGE,
            "passwordHash": hash_password(password),
            "createdAt": format_db_time(now),
            "updatedAt": format_db_time(now),
        }
        try:
            with store_transaction(self.engine) as conn:
                user = self._ensure_user(
                    conn,
                    user_id,
                    handle=requested_handle,
                    display_name=display_name,
                    email=email,
                    department_id=department_id,
                    department_name=department_name,
                    max_local_computers=max_local_computers,
                )
                account["userId"] = user["id"]
                conn.execute(
                    insert(self.accounts).values(
                        **database_account_to_row(account, user_pk=user["id"])
                    )
                )
        except IntegrityError as error:
            raise ValueError("username already exists.") from error
        logger.info("Account created", account_id=account["id"], username=username, role=role)
        return public_account(account)

    def update_user_preferences(
        self,
        account_id: str,
        *,
        theme: UserTheme | None = None,
        language: UserLanguage | None = None,
        onboarding: dict[str, Any] | None = None,
        home_snoozes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _validate_user_preferences(theme=theme, language=language)
        now = datetime.now(UTC)
        patch: dict[str, Any] = {"updated_at": now}
        if theme is not None:
            patch["theme"] = theme
        if language is not None:
            patch["language"] = language
        with store_transaction(self.engine) as conn:
            # Write the scalar preferences first to acquire the account's row
            # lock (or SQLite's writer lock) before reading its onboarding JSON.
            # Invalid onboarding still rolls the entire transaction back.
            result = conn.execute(
                update(self.accounts).where(self.accounts.c.id == account_id).values(**patch)
            )
            if result.rowcount == 0:
                raise KeyError(account_id)
            if onboarding is not None:
                current = conn.execute(
                    select(self.accounts.c.onboarding).where(self.accounts.c.id == account_id)
                ).scalar_one()
                merged = apply_onboarding_patch(current, onboarding, format_db_time(now))
                conn.execute(
                    update(self.accounts)
                    .where(self.accounts.c.id == account_id)
                    .values(onboarding=merged)
                )
            if home_snoozes is not None:
                stored = conn.execute(
                    select(self.accounts.c.home_snoozes).where(self.accounts.c.id == account_id)
                ).scalar_one()
                conn.execute(
                    update(self.accounts)
                    .where(self.accounts.c.id == account_id)
                    .values(home_snoozes=apply_home_snoozes_patch(stored, home_snoozes) or None)
                )
            row = (
                conn.execute(select(self.accounts).where(self.accounts.c.id == account_id))
                .mappings()
                .one()
            )
        SESSION_ACCOUNTS.invalidate_all()
        return public_account(row_to_database_account(row))

    def authenticate(self, username: str, password: str) -> dict[str, Any] | None:
        username = username.strip().lower()
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.accounts).where(self.accounts.c.username == username)
                )
                .mappings()
                .first()
            )
            account = row_to_database_account(row) if row else None
            if account and verify_password(password, account["passwordHash"]):
                user_id = account.get("userId")
                user = (
                    conn.execute(
                        select(self.users).where(self.users.c.id == user_id)
                    )
                    .mappings()
                    .first()
                    if user_id
                    else None
                )
                if not user_id or (user and not user.get("deleted_at")):
                    return account
        return None

    def bootstrap_with_token(
        self, token: str, username: str, password: str
    ) -> dict[str, Any]:
        if not admin_token_configured():
            raise HTTPException(503, "Admin token is not configured.")
        if not verify_admin_token(token):
            raise HTTPException(401, "Invalid admin token.")
        with self._bootstrap_lock, store_transaction(self.engine) as conn:
            if self.engine.dialect.name == "postgresql":
                conn.execute(
                    text("SELECT pg_advisory_xact_lock(:lock_id)"),
                    {"lock_id": _BOOTSTRAP_ADVISORY_LOCK_ID},
                )
            if conn.execute(select(self.accounts.c.id).limit(1)).first() is not None:
                raise HTTPException(
                    409, "Bootstrap is only allowed before the first user is created."
                )
            return self.create_account(username, password, role="admin")

    def get_account_by_id(self, account_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(select(self.accounts).where(self.accounts.c.id == account_id))
                .mappings()
                .first()
            )
            account = row_to_database_account(row) if row else None
            if not account or not account.get("userId"):
                return account
            user = (
                conn.execute(
                    select(self.users).where(
                        self.users.c.id == account["userId"]
                    )
                )
                .mappings()
                .first()
            )
            return account if user and not user.get("deleted_at") else None

    def list_accounts(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(select(self.accounts).order_by(self.accounts.c.created_at))
                .mappings()
                .all()
            )
        return [public_account(row_to_database_account(row)) for row in rows]

    def _account_pk(self, conn: Any, account_id: str) -> str:
        account_pk = conn.scalar(select(self.accounts.c.id).where(self.accounts.c.id == account_id))
        if not account_pk:
            raise KeyError(account_id)
        return account_pk


def _validate_user_preferences(
    *,
    theme: UserTheme | None,
    language: UserLanguage | None,
) -> None:
    if theme is not None and theme not in USER_THEMES:
        raise ValueError("theme must be light, dark, or system.")
    if language is not None and language not in USER_LANGUAGES:
        raise ValueError("language must be en or zh-CN.")
