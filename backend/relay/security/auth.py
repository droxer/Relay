from __future__ import annotations

import hashlib
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Literal
from uuid import UUID, uuid5

from fastapi import HTTPException, Request
from loguru import logger
from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    delete,
    insert,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError

from .passwords import (  # noqa: F401  (re-exported: one policy, one module)
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    PasswordRejected,
    validate_password,
)
from ..core import deploy_config
from ..core.ids import new_database_id, now_iso
from ..core.legacy_names import upgrade_legacy_session
from ..core.storage_config import database_url_from_env, use_postgres_storage
from ..persistence.admin_token_store import DatabaseAdminTokenStore
from ..persistence.store_common import (
    _format_iso,
    _parse_iso,
    _read_json,
    _write_json,
    create_all_tables,
    database_id_column,
    entity_uuid_type,
    shared_engine,
    store_transaction,
)
from ..persistence.store_common import metadata as shared_metadata

DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60  # 1 week
USER_COOKIE_NAME = "relay_session"
PW_HASH_ALGORITHM = "pbkdf2_sha256"
PW_HASH_ITERATIONS = 600_000
UserRole = Literal["admin", "user"]
UserTheme = Literal["light", "dark", "system"]
UserLanguage = Literal["en", "zh-CN"]
USER_THEMES: tuple[UserTheme, ...] = ("light", "dark", "system")
USER_LANGUAGES: tuple[UserLanguage, ...] = ("en", "zh-CN")
DEFAULT_USER_THEME: UserTheme = "system"
DEFAULT_USER_LANGUAGE: UserLanguage = "en"
# Traditional Chinese was retired. A preference stored while it existed reads
# back as Simplified Chinese instead of dropping the reader to English.
_RETIRED_USER_LANGUAGES: dict[str, UserLanguage] = {"zh-TW": "zh-CN"}


def normalize_user_language(value: Any) -> UserLanguage:
    """Map any stored language value onto one the product still ships."""
    language = _RETIRED_USER_LANGUAGES.get(value, value) if isinstance(value, str) else value
    return language if language in USER_LANGUAGES else DEFAULT_USER_LANGUAGE
_AUTH_LOCKS: dict[str, RLock] = {}
_AUTH_LOCKS_GUARD = RLock()
_BOOTSTRAP_ADVISORY_LOCK_ID = 7_362_959_917_925_924_673
_RELAY_ENTITY_ID_NAMESPACE = UUID("c8fa2fd5-5eca-4cc6-b763-a5ae1a57ff63")


def _shared_auth_lock(key: str) -> RLock:
    with _AUTH_LOCKS_GUARD:
        return _AUTH_LOCKS.setdefault(key, RLock())


def normalize_database_id(value: str | None) -> str | None:
    """Return a canonical UUID or None for legacy human-readable identifiers."""
    if not value or not value.strip():
        return None
    try:
        return str(UUID(value.strip()))
    except ValueError:
        return None


# Handles hash under the "employee" kind: the name predates "user", and
# changing it would give every handle-derived id a different UUID.
USER_ENTITY_KIND = "employee"


def database_id_for_reference(value: str, entity_kind: str) -> str:
    """Map a UUID or legacy human handle to one stable UUID-backed identity."""
    normalized = normalize_database_id(value)
    if normalized:
        return normalized
    return str(uuid5(_RELAY_ENTITY_ID_NAMESPACE, f"{entity_kind}:{value.strip()}"))


def slugify_handle(value: str | None) -> str:
    """Best-effort handle from free text, matching the admin form's grammar.

    Used only for rows that predate the handle column or were created outside
    the admin form; a real handle is stored verbatim."""
    lowered = (value or "").strip().lower()
    slug = re.sub(r"[^a-z0-9._-]+", "-", lowered).strip("-.")
    slug = re.sub(r"-{2,}", "-", slug)
    if len(slug) < 2:
        return ""
    return slug[:64]


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PW_HASH_ITERATIONS
    ).hex()
    return f"{PW_HASH_ALGORITHM}${PW_HASH_ITERATIONS}${salt}${digest}"


def verify_password(password: str, hashed: str) -> bool:
    try:
        algorithm, iterations, salt, digest = hashed.split("$")
    except ValueError:
        return False
    if algorithm != PW_HASH_ALGORITHM:
        return False
    try:
        iterations = int(iterations)
    except ValueError:
        return False
    expected = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations
    ).hex()
    return secrets.compare_digest(expected, digest)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


_admin_token_store: DatabaseAdminTokenStore | None = None

# Where the token lived before it moved to the database. Read once, imported
# as a hash, and deleted, so a container without a data volume loses nothing.
_LEGACY_ADMIN_TOKEN_FILE = Path("auth") / "admin-token"


def configure_admin_token(root_dir: str | Path, store: DatabaseAdminTokenStore) -> None:
    """Wire the admin-token store and seed it if it is empty.

    Called once from create_app. The stored hash is authoritative; a legacy
    token file is imported ahead of RELAY_ADMIN_TOKEN because it was the
    authoritative value before. With neither, nothing is generated: a token
    that only its hash remembers would be unrecoverable, so an admin issues one
    from the console instead.
    """
    global _admin_token_store
    _admin_token_store = store
    legacy = Path(root_dir) / _LEGACY_ADMIN_TOKEN_FILE
    if legacy.exists():
        persisted = legacy.read_text(encoding="utf-8").strip()
        if persisted and store.seed(persisted):
            logger.info("Admin token imported from the data directory into the database")
        try:
            legacy.unlink()
        except OSError as error:
            # The hash is already authoritative; a leftover file is inert.
            logger.warning("Could not remove the legacy admin token file", path=str(legacy), error=str(error))
    seed = os.environ.get("RELAY_ADMIN_TOKEN", "").strip()
    if seed and store.seed(seed):
        logger.info("Admin token seeded from RELAY_ADMIN_TOKEN")


def admin_token_configured() -> bool:
    return _admin_token_store is not None and _admin_token_store.is_configured()


def verify_admin_token(candidate: str | None) -> bool:
    """Whether ``candidate`` is the bearer token for bootstrap, supervisor,
    and admin API calls."""
    return bool(candidate) and _admin_token_store is not None and _admin_token_store.verify(candidate)


def reissue_admin_token() -> str:
    """Rotate the admin token and return the new plaintext — the only time it
    is ever shown. The old value stops working immediately, including one
    seeded from RELAY_ADMIN_TOKEN."""
    if _admin_token_store is None:
        raise ValueError("Admin token store is not configured.")
    token = _admin_token_store.issue()
    logger.info("Admin token reissued")
    return token


class AccountAuthStore:
    def __init__(
        self,
        root_dir: str | Path,
        *,
        session_ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
    ):
        self.root_dir = Path(root_dir)
        self.auth_dir = self.root_dir / "auth"
        self.auth_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.auth_dir, 0o700)
        self.accounts_path = self.auth_dir / "users.json"
        self.sessions_path = self.auth_dir / "sessions.json"
        self.deleted_users_path = self.auth_dir / "deleted_users.json"
        legacy_deleted_path = self.auth_dir / "deleted_employees.json"
        if legacy_deleted_path.exists() and not self.deleted_users_path.exists():
            legacy_deleted_path.replace(self.deleted_users_path)
        self.session_ttl_seconds = session_ttl_seconds
        self._lock = _shared_auth_lock(f"local:{self.auth_dir.resolve()}")

    def resolve_user_id(self, user_id: str) -> str:
        """The id a `user_id` will actually land on in this store.

        The file store keeps the handle verbatim, so resolution is a trim. The
        database store maps handles onto UUIDs, and callers that need to ask
        "does this user already exist?" before creating one have to compare
        the resolved form or the check silently passes on a live collision."""
        return (user_id or "").strip()

    def deleted_user_ids(self) -> set[str]:
        if not self.deleted_users_path.exists():
            return set()
        raw = _read_json(self.deleted_users_path)
        return {entry["id"] for entry in raw if entry.get("id")}

    def soft_delete_user(self, user_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        if not user_id:
            raise ValueError("userId is required.")
        accounts = self._read_accounts()
        if not any(account.get("userId") == user_id for account in accounts):
            raise KeyError(user_id)
        entries: list[dict[str, Any]] = []
        if self.deleted_users_path.exists():
            entries = _read_json(self.deleted_users_path)
        if any(entry.get("id") == user_id for entry in entries):
            raise ValueError("User is already deleted.")
        record = {"id": user_id, "deletedAt": now_iso()}
        entries.append(record)
        _write_json(self.deleted_users_path, entries, mode=0o600)
        logger.info("User soft-deleted", user_id=user_id)
        return record

    def has_accounts(self) -> bool:
        return len(self._read_accounts()) > 0

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
    ) -> dict[str, Any]:
        accounts = self._read_accounts()
        username = username.strip().lower()
        if not username:
            raise ValueError("username is required.")
        validate_password(
            password, identifiers=(username, user_id, display_name, email)
        )
        if role not in ("admin", "user"):
            raise ValueError("role must be admin or user.")
        if any(account["username"] == username for account in accounts):
            raise ValueError("username already exists.")
        account = {
            "id": new_database_id(),
            "username": username,
            "email": email.strip() if email else None,
            "role": role,
            "userId": user_id.strip() if user_id else None,
            "displayName": display_name.strip() if display_name else None,
            "departmentId": department_id.strip() if department_id else None,
            "departmentName": department_name.strip() if department_name else None,
            "theme": DEFAULT_USER_THEME,
            "language": DEFAULT_USER_LANGUAGE,
            "passwordHash": hash_password(password),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        accounts.append(account)
        self._write_accounts(accounts)
        if account.get("userId") and self.deleted_users_path.exists():
            entries = [
                entry
                for entry in _read_json(self.deleted_users_path)
                if entry.get("id") != account["userId"]
            ]
            _write_json(self.deleted_users_path, entries, mode=0o600)
        logger.info("Account created", account_id=account["id"], username=username, role=role)
        return self._public_account(account)

    def update_user_preferences(
        self,
        account_id: str,
        *,
        theme: UserTheme | None = None,
        language: UserLanguage | None = None,
    ) -> dict[str, Any]:
        _validate_user_preferences(theme=theme, language=language)
        accounts = self._read_accounts()
        account = next((entry for entry in accounts if entry["id"] == account_id), None)
        if not account:
            raise KeyError(account_id)
        if theme is not None:
            account["theme"] = theme
        if language is not None:
            account["language"] = language
        account["updatedAt"] = now_iso()
        self._write_accounts(accounts)
        return self._public_account(account)

    def authenticate(self, username: str, password: str) -> dict[str, Any] | None:
        username = username.strip().lower()
        for account in self._read_accounts():
            if account["username"] == username and verify_password(
                password, account["passwordHash"]
            ):
                if account.get("userId") in self.deleted_user_ids():
                    return None
                return account
        return None

    def bootstrap_with_token(
        self, token: str, username: str, password: str
    ) -> dict[str, Any]:
        if not admin_token_configured():
            raise HTTPException(503, "Admin token is not configured.")
        if not verify_admin_token(token):
            raise HTTPException(401, "Invalid admin token.")
        with self._lock:
            if self.has_accounts():
                raise HTTPException(
                    409, "Bootstrap is only allowed before the first user is created."
                )
            return self.create_account(username, password, role="admin")

    def create_session(self, account_id: str) -> dict[str, Any]:
        token = new_session_token()
        now = datetime.now(timezone.utc)
        expires_at = now.timestamp() + self.session_ttl_seconds
        session = {
            "tokenHash": hash_session_token(token),
            "accountId": account_id,
            "createdAt": _format_iso(now),
            "expiresAt": _format_iso(
                datetime.fromtimestamp(expires_at, tz=timezone.utc)
            ),
        }
        sessions = self._read_sessions()
        sessions.append(session)
        self._write_sessions(sessions)
        return {**session, "token": token}

    def get_session_by_token(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        sessions = self._read_sessions()
        for session in sessions:
            expected_hash = session.get("tokenHash")
            legacy_token = session.get("token")
            matches = bool(
                isinstance(expected_hash, str)
                and secrets.compare_digest(expected_hash, hash_session_token(token))
            ) or bool(
                isinstance(legacy_token, str)
                and len(legacy_token) == len(token)
                and secrets.compare_digest(legacy_token, token)
            )
            if matches:
                if legacy_token:
                    session["tokenHash"] = hash_session_token(token)
                    session.pop("token", None)
                    self._write_sessions(sessions)
                expires_at = _parse_iso(session.get("expiresAt"))
                if expires_at and expires_at <= datetime.now(timezone.utc):
                    self.delete_session(token)
                    return None
                return session
        return None

    def get_account_by_id(self, account_id: str) -> dict[str, Any] | None:
        account = next(
            (account for account in self._read_accounts() if account["id"] == account_id), None
        )
        if account and account.get("userId") in self.deleted_user_ids():
            return None
        return account

    def delete_session(self, token: str) -> bool:
        sessions = self._read_sessions()
        before = len(sessions)
        token_hash = hash_session_token(token)
        sessions = [
            session
            for session in sessions
            if session.get("tokenHash") != token_hash and session.get("token") != token
        ]
        if len(sessions) < before:
            self._write_sessions(sessions)
            return True
        return False

    def cleanup_expired_sessions(self) -> int:
        sessions = self._read_sessions()
        now = datetime.now(timezone.utc)
        kept = [
            s
            for s in sessions
            if not (
                _parse_iso(s.get("expiresAt")) and _parse_iso(s.get("expiresAt")) <= now
            )
        ]
        removed = len(sessions) - len(kept)
        if removed:
            self._write_sessions(kept)
        return removed

    def list_accounts(self) -> list[dict[str, Any]]:
        return [self._public_account(account) for account in self._read_accounts()]

    def _read_accounts(self) -> list[dict[str, Any]]:
        return _read_json(self.accounts_path) if self.accounts_path.exists() else []

    def _write_accounts(self, accounts: list[dict[str, Any]]) -> None:
        _write_json(self.accounts_path, accounts, mode=0o600)

    def _read_sessions(self) -> list[dict[str, Any]]:
        if not self.sessions_path.exists():
            return []
        return [upgrade_legacy_session(session) for session in _read_json(self.sessions_path)]

    def _write_sessions(self, sessions: list[dict[str, Any]]) -> None:
        _write_json(self.sessions_path, sessions, mode=0o600)

    @staticmethod
    def _public_account(account: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": account["id"],
            "username": account["username"],
            "email": account.get("email"),
            "role": account["role"],
            "userId": account.get("userId"),
            "displayName": account.get("displayName"),
            "theme": account.get("theme", DEFAULT_USER_THEME),
            "language": normalize_user_language(account.get("language")),
            "createdAt": account["createdAt"],
        }


class DatabaseAccountAuthStore:
    metadata = shared_metadata

    departments = Table(
        "departments",
        metadata,
        database_id_column(),
        Column("name", Text, nullable=False),
        Column(
            "parent_department_id",
            entity_uuid_type(),
            ForeignKey("departments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Index("ix_departments_parent_department_id", "parent_department_id"),
    )
    users = Table(
        "users",
        metadata,
        database_id_column(),
        # The @handle. `id` is a UUID (uuid5 of the handle for anything created
        # through the admin form), which made the admin lists render `@<uuid>`
        # and left the handle grammar with nothing behind it. The handle is the
        # display and lookup identity; `id` stays the foreign key everywhere.
        Column("handle", Text, nullable=True),
        Column("display_name", Text, nullable=False),
        Column("email", Text, nullable=True),
        Column(
            "department_id",
            entity_uuid_type(),
            ForeignKey("departments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Empty means "inherit the org-wide default" rather than "no
        # computers": a global change has to move every user who was never
        # pinned to a number of their own.
        Column("max_local_computers", Integer, nullable=True),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("deleted_at", DateTime(timezone=True), nullable=True),
        Index("ix_users_department_id", "department_id"),
        Index("uq_users_handle", "handle", unique=True),
    )
    accounts = Table(
        "auth_accounts",
        metadata,
        database_id_column(),
        Column("username", Text, nullable=False, unique=True),
        Column("email", Text, nullable=True),
        Column("role", Text, nullable=False),
        Column(
            "user_id",
            entity_uuid_type(),
            ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        Column("theme", Text, nullable=False, server_default=DEFAULT_USER_THEME),
        Column("language", Text, nullable=False, server_default=DEFAULT_USER_LANGUAGE),
        Column("password_hash", Text, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        CheckConstraint("role in ('admin', 'user')", name="ck_auth_accounts_role"),
        Index("ix_auth_accounts_role", "role"),
        Index("ix_auth_accounts_user_id", "user_id"),
    )
    sessions = Table(
        "auth_sessions",
        metadata,
        database_id_column(),
        Column("token_hash", Text, nullable=False, unique=True),
        Column(
            "account_id",
            entity_uuid_type(),
            ForeignKey("auth_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("expires_at", DateTime(timezone=True), nullable=False),
        Index("ix_auth_sessions_account_id", "account_id"),
        Index("ix_auth_sessions_expires_at", "expires_at"),
    )

    def __init__(
        self,
        database_url: str,
        *,
        session_ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
        create_schema: bool = False,
    ):
        self.engine = shared_engine(database_url)
        self.session_ttl_seconds = session_ttl_seconds
        self._bootstrap_lock = _shared_auth_lock(f"database:{self.engine.url}")
        if create_schema:
            create_all_tables(self.engine)

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

        now = datetime.now(timezone.utc)
        account = {
            "id": new_database_id(),
            "username": username,
            "email": email,
            "role": role,
            "userId": None,
            "theme": DEFAULT_USER_THEME,
            "language": DEFAULT_USER_LANGUAGE,
            "passwordHash": hash_password(password),
            "createdAt": _format_iso(now),
            "updatedAt": _format_iso(now),
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
        return AccountAuthStore._public_account(account)

    def update_user_preferences(
        self,
        account_id: str,
        *,
        theme: UserTheme | None = None,
        language: UserLanguage | None = None,
    ) -> dict[str, Any]:
        _validate_user_preferences(theme=theme, language=language)
        patch: dict[str, Any] = {"updated_at": datetime.now(timezone.utc)}
        if theme is not None:
            patch["theme"] = theme
        if language is not None:
            patch["language"] = language
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                update(self.accounts).where(self.accounts.c.id == account_id).values(**patch)
            )
            if result.rowcount == 0:
                raise KeyError(account_id)
            row = (
                conn.execute(select(self.accounts).where(self.accounts.c.id == account_id))
                .mappings()
                .one()
            )
        return AccountAuthStore._public_account(row_to_database_account(row))

    def ensure_department(
        self,
        department_id: str,
        *,
        name: str | None = None,
        parent_department_id: str | None = None,
    ) -> dict[str, Any]:
        department_id = department_id.strip()
        if not department_id:
            raise ValueError("departmentId is required.")
        with store_transaction(self.engine) as conn:
            return self._ensure_department(
                conn,
                department_id,
                name=name,
                parent_department_id=parent_department_id,
            )

    def list_departments(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(select(self.departments).order_by(self.departments.c.name))
                .mappings()
                .all()
            )
        return [row_to_department(row) for row in rows]

    def resolve_user_id(self, user_id: str) -> str:
        """See UserAuthStore.resolve_user_id — here a handle becomes a UUID.

        The handle column is consulted first: rows backfilled by the migration
        carry a handle whose uuid5 is not their id, so the deterministic mapping
        alone would miss a real collision."""
        requested = (user_id or "").strip()
        if not requested:
            return ""
        if not normalize_database_id(requested):
            with store_transaction(self.engine) as conn:
                row = (
                    conn.execute(
                        select(self.users.c.id).where(
                            self.users.c.handle == requested.lower()
                        )
                    )
                    .mappings()
                    .first()
                )
            if row:
                return str(row["id"])
        return database_id_for_reference(requested, USER_ENTITY_KIND)

    def ensure_user(
        self,
        user_id: str,
        *,
        display_name: str | None = None,
        email: str | None = None,
        department_id: str | None = None,
        department_name: str | None = None,
        max_local_computers: int | None = None,
    ) -> dict[str, Any]:
        requested_user_id = user_id.strip()
        if not requested_user_id:
            raise ValueError("userId is required.")
        with store_transaction(self.engine) as conn:
            return self._ensure_user(
                conn,
                database_id_for_reference(requested_user_id, USER_ENTITY_KIND),
                # The caller's user_id IS the handle when it is not already
                # a UUID — that is the only place the spelling survives.
                handle=None
                if normalize_database_id(requested_user_id)
                else requested_user_id,
                display_name=display_name or requested_user_id,
                email=email,
                department_id=department_id,
                department_name=department_name,
                max_local_computers=max_local_computers,
            )

    def update_user(
        self,
        user_id: str,
        *,
        display_name: str | None = None,
        email: str | None = None,
        max_local_computers: int | None = None,
        clear_max_local_computers: bool = False,
    ) -> dict[str, Any]:
        """Patch a user's profile. Absent arguments leave a field alone.

        `max_local_computers=None` therefore cannot mean "clear the override" —
        that is what `clear_max_local_computers` is for, since clearing is a
        distinct intent ("inherit the org default") from leaving it untouched.
        """
        user_id = (user_id or "").strip()
        if not user_id:
            raise ValueError("userId is required.")
        if clear_max_local_computers and max_local_computers is not None:
            raise ValueError("maxLocalComputers cannot be both cleared and set.")
        now = datetime.now(timezone.utc)
        patch: dict[str, Any] = {}
        if display_name is not None:
            display_name = display_name.strip()
            if not display_name:
                raise ValueError("displayName cannot be empty.")
            patch["display_name"] = display_name
        if email is not None:
            patch["email"] = email.strip() or None
        if clear_max_local_computers:
            patch["max_local_computers"] = None
        elif max_local_computers is not None:
            patch["max_local_computers"] = max_local_computers
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.users).where(self.users.c.id == user_id)
                )
                .mappings()
                .first()
            )
            if not row or row.get("deleted_at"):
                raise KeyError(user_id)
            if not patch:
                return row_to_user(row)
            conn.execute(
                update(self.users)
                .where(self.users.c.id == row["id"])
                .values(**patch, updated_at=now)
            )
            updated = (
                conn.execute(
                    select(self.users).where(self.users.c.id == row["id"])
                )
                .mappings()
                .first()
            )
        logger.info("User updated", user_id=user_id)
        return row_to_user(updated)

    def list_users(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            department_rows = conn.execute(select(self.departments)).mappings().all()
            departments = {
                str(row["id"]): row_to_department(row) for row in department_rows
            }
            rows = (
                conn.execute(
                    select(self.users)
                    .where(self.users.c.deleted_at.is_(None))
                    .order_by(self.users.c.created_at, self.users.c.id)
                )
                .mappings()
                .all()
            )
        return [
            user_with_department(row_to_user(row), departments) for row in rows
        ]

    def soft_delete_user(self, user_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        if not user_id:
            raise ValueError("userId is required.")
        now = datetime.now(timezone.utc)
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.users).where(self.users.c.id == user_id)
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(user_id)
            if row.get("deleted_at"):
                raise ValueError("User is already deleted.")
            conn.execute(
                update(self.users)
                .where(self.users.c.id == row["id"])
                .values(deleted_at=now, updated_at=now)
            )
        logger.info("User soft-deleted", user_id=user_id)
        return {"id": user_id, "deletedAt": _format_iso(now)}

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

    def create_session(self, account_id: str) -> dict[str, Any]:
        token = new_session_token()
        now = datetime.now(timezone.utc)
        expires_at = datetime.fromtimestamp(
            now.timestamp() + self.session_ttl_seconds, tz=timezone.utc
        )
        session = {
            "id": new_database_id(),
            "token": token,
            "accountId": account_id,
            "createdAt": _format_iso(now),
            "expiresAt": _format_iso(expires_at),
        }
        with store_transaction(self.engine) as conn:
            conn.execute(
                insert(self.sessions).values(
                    **database_session_to_row(
                        session, account_pk=self._account_pk(conn, account_id)
                    )
                )
            )
        return session

    def get_session_by_token(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.sessions).where(
                        self.sessions.c.token_hash == hash_session_token(token)
                    )
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            session = row_to_database_session(row, token)
            expires_at = _parse_iso(session.get("expiresAt"))
            if expires_at and expires_at <= datetime.now(timezone.utc):
                conn.execute(
                    delete(self.sessions).where(
                        self.sessions.c.token_hash == hash_session_token(token)
                    )
                )
                return None
        return session

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

    def delete_session(self, token: str) -> bool:
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                delete(self.sessions).where(
                    self.sessions.c.token_hash == hash_session_token(token)
                )
            )
        return result.rowcount > 0

    def cleanup_expired_sessions(self) -> int:
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                delete(self.sessions).where(
                    self.sessions.c.expires_at <= datetime.now(timezone.utc)
                )
            )
        return result.rowcount

    def list_accounts(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(select(self.accounts).order_by(self.accounts.c.created_at))
                .mappings()
                .all()
            )
        return [AccountAuthStore._public_account(row_to_database_account(row)) for row in rows]

    @staticmethod
    def _public_account(account: dict[str, Any]) -> dict[str, Any]:
        return AccountAuthStore._public_account(account)

    def _ensure_department(
        self,
        conn: Any,
        department_id: str,
        *,
        name: str | None = None,
        parent_department_id: str | None = None,
    ) -> dict[str, Any]:
        requested_department_id = department_id.strip()
        department_id = database_id_for_reference(requested_department_id, "department")
        name = name.strip() if name else requested_department_id
        parent_department_id = (
            parent_department_id.strip() if parent_department_id else None
        )
        now = datetime.now(timezone.utc)
        parent = (
            self._ensure_department(conn, parent_department_id)
            if parent_department_id
            else None
        )
        parent_department_pk = parent["id"] if parent else None
        row = (
            conn.execute(
                select(self.departments).where(self.departments.c.id == department_id)
            )
            .mappings()
            .first()
        )
        if row:
            department_pk = row["id"]
            patch: dict[str, Any] = {"updated_at": now}
            if name:
                patch["name"] = name
            if parent_department_pk:
                patch["parent_department_id"] = parent_department_pk
            if len(patch) > 1:
                conn.execute(
                    update(self.departments)
                    .where(self.departments.c.id == department_pk)
                    .values(**patch)
                )
                return {
                    **row_to_department(row),
                    "name": patch.get("name", row["name"]),
                    "parentDepartmentId": patch.get(
                        "parent_department_id",
                        str(row["parent_department_id"])
                        if row["parent_department_id"]
                        else None,
                    ),
                    "updatedAt": _format_iso(now),
                }
            return row_to_department(row)

        department = {
            "id": department_id,
            "name": name,
            "parentDepartmentId": parent_department_pk,
            "createdAt": _format_iso(now),
            "updatedAt": _format_iso(now),
        }
        conn.execute(
            insert(self.departments).values(
                **department_to_row(
                    department, parent_department_pk=parent_department_pk
                )
            )
        )
        return department

    def _ensure_user(
        self,
        conn: Any,
        user_id: str | None,
        *,
        handle: str | None = None,
        display_name: str | None = None,
        email: str | None = None,
        department_id: str | None = None,
        department_name: str | None = None,
        max_local_computers: int | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        department_id = department_id.strip() if department_id else None
        department = (
            self._ensure_department(conn, department_id, name=department_name)
            if department_id
            else None
        )
        department_pk = department["id"] if department else None
        user_id = normalize_database_id(user_id)
        row = None
        if user_id:
            row = (
                conn.execute(
                    select(self.users).where(self.users.c.id == user_id)
                )
                .mappings()
                .first()
            )
        if row:
            user_pk = row["id"]
            patch: dict[str, Any] = {"updated_at": now}
            if row.get("deleted_at"):
                patch["deleted_at"] = None
            # Only ever fills a blank — an existing handle is the user's
            # identity and is not rewritten by a later ensure — and only when
            # the handle is still free, since the column is unique and an
            # ensure has no business failing the whole request over a name.
            if handle and not row.get("handle") and self._handle_is_free(conn, handle):
                patch["handle"] = handle
            if display_name:
                patch["display_name"] = display_name
            if email:
                patch["email"] = email
            if department_pk:
                patch["department_id"] = department_pk
            if max_local_computers is not None:
                patch["max_local_computers"] = max_local_computers
            if len(patch) > 1:
                conn.execute(
                    update(self.users)
                    .where(self.users.c.id == user_pk)
                    .values(**patch)
                )
                return {
                    **row_to_user(row),
                    **({"handle": patch["handle"]} if "handle" in patch else {}),
                    **({"displayName": display_name} if display_name else {}),
                    **({"email": email} if email else {}),
                    **({"departmentId": department_pk} if department_pk else {}),
                    **(
                        {"maxLocalComputers": max_local_computers}
                        if max_local_computers is not None
                        else {}
                    ),
                    "updatedAt": _format_iso(now),
                }
            return row_to_user(row)

        candidate = handle or slugify_handle(display_name) or None
        user = {
            "id": user_id or new_database_id(),
            "handle": candidate if candidate and self._handle_is_free(conn, candidate) else None,
            "displayName": display_name or user_id,
            "email": email,
            "departmentId": department_pk,
            "maxLocalComputers": max_local_computers,
            "createdAt": _format_iso(now),
            "updatedAt": _format_iso(now),
        }
        conn.execute(
            insert(self.users).values(
                **user_to_row(user, department_pk=department_pk)
            )
        )
        return user

    def _handle_is_free(self, conn: Any, handle: str) -> bool:
        return (
            conn.execute(
                select(self.users.c.id).where(self.users.c.handle == handle)
            )
            .mappings()
            .first()
            is None
        )

    def _account_pk(self, conn: Any, account_id: str) -> str:
        account_pk = conn.scalar(select(self.accounts.c.id).where(self.accounts.c.id == account_id))
        if not account_pk:
            raise KeyError(account_id)
        return account_pk


def auth_store_from_env(root_dir: str | Path) -> Any:
    auth_store = os.environ.get("RELAY_AUTH_STORE", "").strip().lower()
    if auth_store != "database" and not use_postgres_storage():
        return AccountAuthStore(root_dir)
    setting = (
        "RELAY_AUTH_STORE=database"
        if auth_store == "database"
        else "RELAY_STORAGE=postgres"
    )
    database_url = database_url_from_env(setting=setting)
    return DatabaseAccountAuthStore(database_url)


def database_account_to_row(
    account: dict[str, Any],
    *,
    user_pk: str | None = None,
    database_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or account["id"],
        "username": account["username"],
        "email": account.get("email"),
        "role": account["role"],
        "user_id": user_pk,
        "theme": account.get("theme", DEFAULT_USER_THEME),
        "language": normalize_user_language(account.get("language")),
        "password_hash": account["passwordHash"],
        "created_at": _parse_iso(account["createdAt"]),
        "updated_at": _parse_iso(account["updatedAt"]),
    }


def user_to_row(
    user: dict[str, Any],
    *,
    department_pk: str | None = None,
    database_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or user["id"],
        "handle": user.get("handle"),
        "display_name": user["displayName"],
        "email": user.get("email"),
        "department_id": department_pk,
        "max_local_computers": user.get("maxLocalComputers"),
        "created_at": _parse_iso(user["createdAt"]),
        "updated_at": _parse_iso(user["updatedAt"]),
    }


def department_to_row(
    department: dict[str, Any],
    *,
    parent_department_pk: str | None = None,
    database_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or department["id"],
        "name": department["name"],
        "parent_department_id": parent_department_pk,
        "created_at": _parse_iso(department["createdAt"]),
        "updated_at": _parse_iso(department["updatedAt"]),
    }


def row_to_department(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "parentDepartmentId": str(row["parent_department_id"])
        if row["parent_department_id"]
        else None,
        "createdAt": _format_iso(row["created_at"]),
        "updatedAt": _format_iso(row["updated_at"]),
    }


def row_to_user(row: Any) -> dict[str, Any]:
    limit = row["max_local_computers"]
    handle = row["handle"]
    return {
        "id": str(row["id"]),
        # Never fall back to the raw UUID: that is the string the @handle
        # grammar exists to keep off the screen. A row with no handle yet
        # (created outside the admin form) borrows its display name.
        "handle": handle or slugify_handle(row["display_name"]) or str(row["id"])[:8],
        "displayName": row["display_name"],
        "email": row["email"],
        "departmentId": str(row["department_id"]) if row["department_id"] else None,
        "maxLocalComputers": int(limit) if limit is not None else None,
        "createdAt": _format_iso(row["created_at"]),
        "updatedAt": _format_iso(row["updated_at"]),
    }


def user_with_department(
    user: dict[str, Any], departments: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    department = departments.get(user.get("departmentId") or "")
    if not department:
        return user
    return {**user, "departmentName": department["name"]}


def row_to_database_account(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "username": row["username"],
        "email": row["email"],
        "role": row["role"],
        "userId": str(row["user_id"]) if row["user_id"] else None,
        "theme": row["theme"],
        "language": normalize_user_language(row["language"]),
        "passwordHash": row["password_hash"],
        "createdAt": _format_iso(row["created_at"]),
        "updatedAt": _format_iso(row["updated_at"]),
    }


def _validate_user_preferences(
    *,
    theme: UserTheme | None,
    language: UserLanguage | None,
) -> None:
    if theme is not None and theme not in USER_THEMES:
        raise ValueError("theme must be light, dark, or system.")
    if language is not None and language not in USER_LANGUAGES:
        raise ValueError("language must be en or zh-CN.")


def database_session_to_row(
    session: dict[str, Any], *, account_pk: str, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or session["id"],
        "token_hash": hash_session_token(session["token"]),
        "account_id": account_pk,
        "created_at": _parse_iso(session["createdAt"]),
        "expires_at": _parse_iso(session["expiresAt"]),
    }


def row_to_database_session(row: Any, token: str) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "token": token,
        "accountId": str(row["account_id"]),
        "createdAt": _format_iso(row["created_at"]),
        "expiresAt": _format_iso(row["expires_at"]),
    }


def user_session_token_from_request(request: Request) -> str | None:
    return request.cookies.get(USER_COOKIE_NAME)


def require_user_session(request: Request, auth_store: AccountAuthStore) -> dict[str, Any]:
    token = user_session_token_from_request(request)
    if not token:
        raise HTTPException(401, "Authentication required.")
    session = auth_store.get_session_by_token(token)
    if not session:
        raise HTTPException(401, "Session expired or invalid.")
    account = auth_store.get_account_by_id(session["accountId"])
    if not account:
        raise HTTPException(401, "User not found.")
    return account


def require_admin_session(
    request: Request, auth_store: AccountAuthStore
) -> dict[str, Any]:
    bearer = _bearer_token(request)
    if verify_admin_token(bearer):
        return {
            "id": "admin-token",
            "username": "admin-token",
            "role": "admin",
            "isAdmin": True,
        }
    account = require_user_session(request, auth_store)
    if account.get("role") != "admin":
        raise HTTPException(403, "Admin access required.")
    return account


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    parts = header.split(" ", 1)
    return parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else None


def user_session_cookie_attrs(
    *, max_age_seconds: int, secure: bool | None = None
) -> dict[str, Any]:
    attrs: dict[str, Any] = {
        "key": USER_COOKIE_NAME,
        "httponly": True,
        "samesite": deploy_config.session_cookie_samesite(),
        "max_age": max_age_seconds,
        "path": "/",
        **user_session_cookie_scope(),
    }
    if secure is not None:
        attrs["secure"] = secure
    # A SameSite=None cookie is dropped by the browser unless it is also
    # Secure, so never let the request scheme downgrade a cross-site cookie
    # into one that silently fails to set.
    if attrs["samesite"] == "none":
        attrs["secure"] = True
    return attrs


def user_session_cookie_scope() -> dict[str, Any]:
    """Cookie attributes shared by ``set_cookie`` and ``delete_cookie``.

    A cookie is only deleted when the delete call repeats the domain and path
    it was written with, so both sides read the scope from one place.
    """
    domain = deploy_config.session_cookie_domain()
    return {"domain": domain} if domain else {}


def user_session_cookie_attrs_for_request(
    request: Request, *, max_age_seconds: int
) -> dict[str, Any]:
    return user_session_cookie_attrs(
        max_age_seconds=max_age_seconds,
        secure=deploy_config.cookie_is_secure(request.url.scheme),
    )
