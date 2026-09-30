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
from ..core.storage_config import database_url_from_env, use_postgres_storage
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


_admin_token_path: Path | None = None


def configure_admin_token(root_dir: str | Path) -> None:
    """Point the admin-token store at this app's data dir and make sure a
    token exists.

    Called once from create_app. On first boot the token is seeded from
    RELAY_ADMIN_TOKEN when set, otherwise generated; either way it lands next
    to the auth data so the console can show and reissue it.
    """
    global _admin_token_path
    _admin_token_path = Path(root_dir) / "auth" / "admin-token"
    get_admin_token()


def get_admin_token() -> str | None:
    """The bearer token for bootstrap, supervisor, and admin API calls.

    The persisted token is authoritative once written; RELAY_ADMIN_TOKEN only
    seeds the very first boot. That keeps the value the console displays the
    one that actually authenticates, including after a console reissue.
    """
    if _admin_token_path is None:
        return os.environ.get("RELAY_ADMIN_TOKEN", "").strip() or None
    if _admin_token_path.exists():
        persisted = _admin_token_path.read_text(encoding="utf-8").strip()
        if persisted:
            return persisted
    seed = os.environ.get("RELAY_ADMIN_TOKEN", "").strip()
    return _persist_admin_token(seed or secrets.token_urlsafe(32))


def reissue_admin_token() -> str:
    """Rotate the persisted admin token; the old value stops working
    immediately, including one seeded from RELAY_ADMIN_TOKEN."""
    if _admin_token_path is None:
        raise ValueError("Admin token store is not configured.")
    return _persist_admin_token(secrets.token_urlsafe(32))


def _persist_admin_token(token: str) -> str:
    assert _admin_token_path is not None
    _admin_token_path.parent.mkdir(parents=True, exist_ok=True)
    _admin_token_path.write_text(token, encoding="utf-8")
    os.chmod(_admin_token_path, 0o600)
    logger.info("Admin token persisted", path=str(_admin_token_path))
    return token


class UserAuthStore:
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
        self.users_path = self.auth_dir / "users.json"
        self.sessions_path = self.auth_dir / "sessions.json"
        self.deleted_employees_path = self.auth_dir / "deleted_employees.json"
        self.session_ttl_seconds = session_ttl_seconds
        self._lock = _shared_auth_lock(f"local:{self.auth_dir.resolve()}")

    def resolve_employee_id(self, employee_id: str) -> str:
        """The id an `employee_id` will actually land on in this store.

        The file store keeps the handle verbatim, so resolution is a trim. The
        database store maps handles onto UUIDs, and callers that need to ask
        "does this employee already exist?" before creating one have to compare
        the resolved form or the check silently passes on a live collision."""
        return (employee_id or "").strip()

    def deleted_employee_ids(self) -> set[str]:
        if not self.deleted_employees_path.exists():
            return set()
        raw = _read_json(self.deleted_employees_path)
        return {entry["id"] for entry in raw if entry.get("id")}

    def soft_delete_employee(self, employee_id: str) -> dict[str, Any]:
        employee_id = (employee_id or "").strip()
        if not employee_id:
            raise ValueError("employeeId is required.")
        users = self._read_users()
        if not any(user.get("employeeId") == employee_id for user in users):
            raise KeyError(employee_id)
        entries: list[dict[str, Any]] = []
        if self.deleted_employees_path.exists():
            entries = _read_json(self.deleted_employees_path)
        if any(entry.get("id") == employee_id for entry in entries):
            raise ValueError("Employee is already deleted.")
        record = {"id": employee_id, "deletedAt": now_iso()}
        entries.append(record)
        _write_json(self.deleted_employees_path, entries, mode=0o600)
        logger.info("Employee soft-deleted", employee_id=employee_id)
        return record

    def has_users(self) -> bool:
        return len(self._read_users()) > 0

    def create_user(
        self,
        username: str,
        password: str,
        role: UserRole = "user",
        email: str | None = None,
        employee_id: str | None = None,
        display_name: str | None = None,
        department_id: str | None = None,
        department_name: str | None = None,
    ) -> dict[str, Any]:
        users = self._read_users()
        username = username.strip().lower()
        if not username:
            raise ValueError("username is required.")
        validate_password(
            password, identifiers=(username, employee_id, display_name, email)
        )
        if role not in ("admin", "user"):
            raise ValueError("role must be admin or user.")
        if any(user["username"] == username for user in users):
            raise ValueError("username already exists.")
        user = {
            "id": new_database_id(),
            "username": username,
            "email": email.strip() if email else None,
            "role": role,
            "employeeId": employee_id.strip() if employee_id else None,
            "displayName": display_name.strip() if display_name else None,
            "departmentId": department_id.strip() if department_id else None,
            "departmentName": department_name.strip() if department_name else None,
            "theme": DEFAULT_USER_THEME,
            "language": DEFAULT_USER_LANGUAGE,
            "passwordHash": hash_password(password),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        users.append(user)
        self._write_users(users)
        if user.get("employeeId") and self.deleted_employees_path.exists():
            entries = [
                entry
                for entry in _read_json(self.deleted_employees_path)
                if entry.get("id") != user["employeeId"]
            ]
            _write_json(self.deleted_employees_path, entries, mode=0o600)
        logger.info("User created", user_id=user["id"], username=username, role=role)
        return self._public_user(user)

    def update_user_preferences(
        self,
        user_id: str,
        *,
        theme: UserTheme | None = None,
        language: UserLanguage | None = None,
    ) -> dict[str, Any]:
        _validate_user_preferences(theme=theme, language=language)
        users = self._read_users()
        user = next((entry for entry in users if entry["id"] == user_id), None)
        if not user:
            raise KeyError(user_id)
        if theme is not None:
            user["theme"] = theme
        if language is not None:
            user["language"] = language
        user["updatedAt"] = now_iso()
        self._write_users(users)
        return self._public_user(user)

    def authenticate(self, username: str, password: str) -> dict[str, Any] | None:
        username = username.strip().lower()
        for user in self._read_users():
            if user["username"] == username and verify_password(
                password, user["passwordHash"]
            ):
                if user.get("employeeId") in self.deleted_employee_ids():
                    return None
                return user
        return None

    def bootstrap_with_token(
        self, token: str, username: str, password: str
    ) -> dict[str, Any]:
        expected = get_admin_token()
        if not expected:
            raise HTTPException(503, "Admin token is not configured.")
        if (
            not token
            or len(token) != len(expected)
            or not secrets.compare_digest(token, expected)
        ):
            raise HTTPException(401, "Invalid admin token.")
        with self._lock:
            if self.has_users():
                raise HTTPException(
                    409, "Bootstrap is only allowed before the first user is created."
                )
            return self.create_user(username, password, role="admin")

    def create_session(self, user_id: str) -> dict[str, Any]:
        token = new_session_token()
        now = datetime.now(timezone.utc)
        expires_at = now.timestamp() + self.session_ttl_seconds
        session = {
            "tokenHash": hash_session_token(token),
            "userId": user_id,
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

    def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        user = next(
            (user for user in self._read_users() if user["id"] == user_id), None
        )
        if user and user.get("employeeId") in self.deleted_employee_ids():
            return None
        return user

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

    def list_users(self) -> list[dict[str, Any]]:
        return [self._public_user(user) for user in self._read_users()]

    def _read_users(self) -> list[dict[str, Any]]:
        return _read_json(self.users_path) if self.users_path.exists() else []

    def _write_users(self, users: list[dict[str, Any]]) -> None:
        _write_json(self.users_path, users, mode=0o600)

    def _read_sessions(self) -> list[dict[str, Any]]:
        return _read_json(self.sessions_path) if self.sessions_path.exists() else []

    def _write_sessions(self, sessions: list[dict[str, Any]]) -> None:
        _write_json(self.sessions_path, sessions, mode=0o600)

    @staticmethod
    def _public_user(user: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": user["id"],
            "username": user["username"],
            "email": user.get("email"),
            "role": user["role"],
            "employeeId": user.get("employeeId"),
            "displayName": user.get("displayName"),
            "theme": user.get("theme", DEFAULT_USER_THEME),
            "language": normalize_user_language(user.get("language")),
            "createdAt": user["createdAt"],
        }


class DatabaseUserAuthStore:
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
    employees = Table(
        "employees",
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
        # computers": a global change has to move every employee who was never
        # pinned to a number of their own.
        Column("max_local_computers", Integer, nullable=True),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("deleted_at", DateTime(timezone=True), nullable=True),
        Index("ix_employees_department_id", "department_id"),
        Index("uq_employees_handle", "handle", unique=True),
    )
    users = Table(
        "auth_users",
        metadata,
        database_id_column(),
        Column("username", Text, nullable=False, unique=True),
        Column("email", Text, nullable=True),
        Column("role", Text, nullable=False),
        Column(
            "employee_id",
            entity_uuid_type(),
            ForeignKey("employees.id", ondelete="SET NULL"),
            nullable=True,
        ),
        Column("theme", Text, nullable=False, server_default=DEFAULT_USER_THEME),
        Column("language", Text, nullable=False, server_default=DEFAULT_USER_LANGUAGE),
        Column("password_hash", Text, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        CheckConstraint("role in ('admin', 'user')", name="ck_auth_users_role"),
        Index("ix_auth_users_role", "role"),
        Index("ix_auth_users_employee_id", "employee_id"),
    )
    sessions = Table(
        "auth_sessions",
        metadata,
        database_id_column(),
        Column("token_hash", Text, nullable=False, unique=True),
        Column(
            "user_id",
            entity_uuid_type(),
            ForeignKey("auth_users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("expires_at", DateTime(timezone=True), nullable=False),
        Index("ix_auth_sessions_user_id", "user_id"),
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

    def has_users(self) -> bool:
        with store_transaction(self.engine) as conn:
            return conn.execute(select(self.users.c.id).limit(1)).first() is not None

    def create_user(
        self,
        username: str,
        password: str,
        role: UserRole = "user",
        email: str | None = None,
        employee_id: str | None = None,
        display_name: str | None = None,
        department_id: str | None = None,
        department_name: str | None = None,
        max_local_computers: int | None = None,
    ) -> dict[str, Any]:
        username = username.strip().lower()
        if not username:
            raise ValueError("username is required.")
        validate_password(
            password, identifiers=(username, employee_id, display_name, email)
        )
        if role not in ("admin", "user"):
            raise ValueError("role must be admin or user.")
        requested_handle = (
            None
            if not employee_id or normalize_database_id(employee_id)
            else employee_id.strip()
        )
        employee_id = (
            database_id_for_reference(employee_id, "employee")
            if employee_id
            else new_database_id()
        )
        display_name = display_name.strip() if display_name else username
        department_id = department_id.strip() if department_id else None
        department_name = department_name.strip() if department_name else None
        email = email.strip() if email else None

        now = datetime.now(timezone.utc)
        user = {
            "id": new_database_id(),
            "username": username,
            "email": email,
            "role": role,
            "employeeId": None,
            "theme": DEFAULT_USER_THEME,
            "language": DEFAULT_USER_LANGUAGE,
            "passwordHash": hash_password(password),
            "createdAt": _format_iso(now),
            "updatedAt": _format_iso(now),
        }
        try:
            with store_transaction(self.engine) as conn:
                employee = self._ensure_employee(
                    conn,
                    employee_id,
                    handle=requested_handle,
                    display_name=display_name,
                    email=email,
                    department_id=department_id,
                    department_name=department_name,
                    max_local_computers=max_local_computers,
                )
                user["employeeId"] = employee["id"]
                conn.execute(
                    insert(self.users).values(
                        **database_user_to_row(user, employee_pk=employee["id"])
                    )
                )
        except IntegrityError as error:
            raise ValueError("username already exists.") from error
        logger.info("User created", user_id=user["id"], username=username, role=role)
        return UserAuthStore._public_user(user)

    def update_user_preferences(
        self,
        user_id: str,
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
                update(self.users).where(self.users.c.id == user_id).values(**patch)
            )
            if result.rowcount == 0:
                raise KeyError(user_id)
            row = (
                conn.execute(select(self.users).where(self.users.c.id == user_id))
                .mappings()
                .one()
            )
        return UserAuthStore._public_user(row_to_database_user(row))

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

    def resolve_employee_id(self, employee_id: str) -> str:
        """See UserAuthStore.resolve_employee_id — here a handle becomes a UUID.

        The handle column is consulted first: rows backfilled by the migration
        carry a handle whose uuid5 is not their id, so the deterministic mapping
        alone would miss a real collision."""
        requested = (employee_id or "").strip()
        if not requested:
            return ""
        if not normalize_database_id(requested):
            with store_transaction(self.engine) as conn:
                row = (
                    conn.execute(
                        select(self.employees.c.id).where(
                            self.employees.c.handle == requested.lower()
                        )
                    )
                    .mappings()
                    .first()
                )
            if row:
                return str(row["id"])
        return database_id_for_reference(requested, "employee")

    def ensure_employee(
        self,
        employee_id: str,
        *,
        display_name: str | None = None,
        email: str | None = None,
        department_id: str | None = None,
        department_name: str | None = None,
        max_local_computers: int | None = None,
    ) -> dict[str, Any]:
        requested_employee_id = employee_id.strip()
        if not requested_employee_id:
            raise ValueError("employeeId is required.")
        with store_transaction(self.engine) as conn:
            return self._ensure_employee(
                conn,
                database_id_for_reference(requested_employee_id, "employee"),
                # The caller's employee_id IS the handle when it is not already
                # a UUID — that is the only place the spelling survives.
                handle=None
                if normalize_database_id(requested_employee_id)
                else requested_employee_id,
                display_name=display_name or requested_employee_id,
                email=email,
                department_id=department_id,
                department_name=department_name,
                max_local_computers=max_local_computers,
            )

    def update_employee(
        self,
        employee_id: str,
        *,
        display_name: str | None = None,
        email: str | None = None,
        max_local_computers: int | None = None,
        clear_max_local_computers: bool = False,
    ) -> dict[str, Any]:
        """Patch an employee's profile. Absent arguments leave a field alone.

        `max_local_computers=None` therefore cannot mean "clear the override" —
        that is what `clear_max_local_computers` is for, since clearing is a
        distinct intent ("inherit the org default") from leaving it untouched.
        """
        employee_id = (employee_id or "").strip()
        if not employee_id:
            raise ValueError("employeeId is required.")
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
                    select(self.employees).where(self.employees.c.id == employee_id)
                )
                .mappings()
                .first()
            )
            if not row or row.get("deleted_at"):
                raise KeyError(employee_id)
            if not patch:
                return row_to_employee(row)
            conn.execute(
                update(self.employees)
                .where(self.employees.c.id == row["id"])
                .values(**patch, updated_at=now)
            )
            updated = (
                conn.execute(
                    select(self.employees).where(self.employees.c.id == row["id"])
                )
                .mappings()
                .first()
            )
        logger.info("Employee updated", employee_id=employee_id)
        return row_to_employee(updated)

    def list_employees(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            department_rows = conn.execute(select(self.departments)).mappings().all()
            departments = {
                str(row["id"]): row_to_department(row) for row in department_rows
            }
            rows = (
                conn.execute(
                    select(self.employees)
                    .where(self.employees.c.deleted_at.is_(None))
                    .order_by(self.employees.c.created_at, self.employees.c.id)
                )
                .mappings()
                .all()
            )
        return [
            employee_with_department(row_to_employee(row), departments) for row in rows
        ]

    def soft_delete_employee(self, employee_id: str) -> dict[str, Any]:
        employee_id = (employee_id or "").strip()
        if not employee_id:
            raise ValueError("employeeId is required.")
        now = datetime.now(timezone.utc)
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.employees).where(self.employees.c.id == employee_id)
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(employee_id)
            if row.get("deleted_at"):
                raise ValueError("Employee is already deleted.")
            conn.execute(
                update(self.employees)
                .where(self.employees.c.id == row["id"])
                .values(deleted_at=now, updated_at=now)
            )
        logger.info("Employee soft-deleted", employee_id=employee_id)
        return {"id": employee_id, "deletedAt": _format_iso(now)}

    def authenticate(self, username: str, password: str) -> dict[str, Any] | None:
        username = username.strip().lower()
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.users).where(self.users.c.username == username)
                )
                .mappings()
                .first()
            )
            user = row_to_database_user(row) if row else None
            if user and verify_password(password, user["passwordHash"]):
                employee_id = user.get("employeeId")
                employee = (
                    conn.execute(
                        select(self.employees).where(self.employees.c.id == employee_id)
                    )
                    .mappings()
                    .first()
                    if employee_id
                    else None
                )
                if not employee_id or (employee and not employee.get("deleted_at")):
                    return user
        return None

    def bootstrap_with_token(
        self, token: str, username: str, password: str
    ) -> dict[str, Any]:
        expected = get_admin_token()
        if not expected:
            raise HTTPException(503, "Admin token is not configured.")
        if (
            not token
            or len(token) != len(expected)
            or not secrets.compare_digest(token, expected)
        ):
            raise HTTPException(401, "Invalid admin token.")
        with self._bootstrap_lock, store_transaction(self.engine) as conn:
            if self.engine.dialect.name == "postgresql":
                conn.execute(
                    text("SELECT pg_advisory_xact_lock(:lock_id)"),
                    {"lock_id": _BOOTSTRAP_ADVISORY_LOCK_ID},
                )
            if conn.execute(select(self.users.c.id).limit(1)).first() is not None:
                raise HTTPException(
                    409, "Bootstrap is only allowed before the first user is created."
                )
            return self.create_user(username, password, role="admin")

    def create_session(self, user_id: str) -> dict[str, Any]:
        token = new_session_token()
        now = datetime.now(timezone.utc)
        expires_at = datetime.fromtimestamp(
            now.timestamp() + self.session_ttl_seconds, tz=timezone.utc
        )
        session = {
            "id": new_database_id(),
            "token": token,
            "userId": user_id,
            "createdAt": _format_iso(now),
            "expiresAt": _format_iso(expires_at),
        }
        with store_transaction(self.engine) as conn:
            conn.execute(
                insert(self.sessions).values(
                    **database_session_to_row(
                        session, user_pk=self._user_pk(conn, user_id)
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

    def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(select(self.users).where(self.users.c.id == user_id))
                .mappings()
                .first()
            )
            user = row_to_database_user(row) if row else None
            if not user or not user.get("employeeId"):
                return user
            employee = (
                conn.execute(
                    select(self.employees).where(
                        self.employees.c.id == user["employeeId"]
                    )
                )
                .mappings()
                .first()
            )
            return user if employee and not employee.get("deleted_at") else None

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

    def list_users(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(select(self.users).order_by(self.users.c.created_at))
                .mappings()
                .all()
            )
        return [UserAuthStore._public_user(row_to_database_user(row)) for row in rows]

    @staticmethod
    def _public_user(user: dict[str, Any]) -> dict[str, Any]:
        return UserAuthStore._public_user(user)

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

    def _ensure_employee(
        self,
        conn: Any,
        employee_id: str | None,
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
        employee_id = normalize_database_id(employee_id)
        row = None
        if employee_id:
            row = (
                conn.execute(
                    select(self.employees).where(self.employees.c.id == employee_id)
                )
                .mappings()
                .first()
            )
        if row:
            employee_pk = row["id"]
            patch: dict[str, Any] = {"updated_at": now}
            if row.get("deleted_at"):
                patch["deleted_at"] = None
            # Only ever fills a blank — an existing handle is the employee's
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
                    update(self.employees)
                    .where(self.employees.c.id == employee_pk)
                    .values(**patch)
                )
                return {
                    **row_to_employee(row),
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
            return row_to_employee(row)

        candidate = handle or slugify_handle(display_name) or None
        employee = {
            "id": employee_id or new_database_id(),
            "handle": candidate if candidate and self._handle_is_free(conn, candidate) else None,
            "displayName": display_name or employee_id,
            "email": email,
            "departmentId": department_pk,
            "maxLocalComputers": max_local_computers,
            "createdAt": _format_iso(now),
            "updatedAt": _format_iso(now),
        }
        conn.execute(
            insert(self.employees).values(
                **employee_to_row(employee, department_pk=department_pk)
            )
        )
        return employee

    def _handle_is_free(self, conn: Any, handle: str) -> bool:
        return (
            conn.execute(
                select(self.employees.c.id).where(self.employees.c.handle == handle)
            )
            .mappings()
            .first()
            is None
        )

    def _user_pk(self, conn: Any, user_id: str) -> str:
        user_pk = conn.scalar(select(self.users.c.id).where(self.users.c.id == user_id))
        if not user_pk:
            raise KeyError(user_id)
        return user_pk


def auth_store_from_env(root_dir: str | Path) -> Any:
    auth_store = os.environ.get("RELAY_AUTH_STORE", "").strip().lower()
    if auth_store != "database" and not use_postgres_storage():
        return UserAuthStore(root_dir)
    setting = (
        "RELAY_AUTH_STORE=database"
        if auth_store == "database"
        else "RELAY_STORAGE=postgres"
    )
    database_url = database_url_from_env(setting=setting)
    return DatabaseUserAuthStore(database_url)


def database_user_to_row(
    user: dict[str, Any],
    *,
    employee_pk: str | None = None,
    database_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or user["id"],
        "username": user["username"],
        "email": user.get("email"),
        "role": user["role"],
        "employee_id": employee_pk,
        "theme": user.get("theme", DEFAULT_USER_THEME),
        "language": normalize_user_language(user.get("language")),
        "password_hash": user["passwordHash"],
        "created_at": _parse_iso(user["createdAt"]),
        "updated_at": _parse_iso(user["updatedAt"]),
    }


def employee_to_row(
    employee: dict[str, Any],
    *,
    department_pk: str | None = None,
    database_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or employee["id"],
        "handle": employee.get("handle"),
        "display_name": employee["displayName"],
        "email": employee.get("email"),
        "department_id": department_pk,
        "max_local_computers": employee.get("maxLocalComputers"),
        "created_at": _parse_iso(employee["createdAt"]),
        "updated_at": _parse_iso(employee["updatedAt"]),
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


def row_to_employee(row: Any) -> dict[str, Any]:
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


def employee_with_department(
    employee: dict[str, Any], departments: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    department = departments.get(employee.get("departmentId") or "")
    if not department:
        return employee
    return {**employee, "departmentName": department["name"]}


def row_to_database_user(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "username": row["username"],
        "email": row["email"],
        "role": row["role"],
        "employeeId": str(row["employee_id"]) if row["employee_id"] else None,
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
    session: dict[str, Any], *, user_pk: str, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or session["id"],
        "token_hash": hash_session_token(session["token"]),
        "user_id": user_pk,
        "created_at": _parse_iso(session["createdAt"]),
        "expires_at": _parse_iso(session["expiresAt"]),
    }


def row_to_database_session(row: Any, token: str) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "token": token,
        "userId": str(row["user_id"]),
        "createdAt": _format_iso(row["created_at"]),
        "expiresAt": _format_iso(row["expires_at"]),
    }


def user_session_token_from_request(request: Request) -> str | None:
    return request.cookies.get(USER_COOKIE_NAME)


def require_user_session(request: Request, auth_store: UserAuthStore) -> dict[str, Any]:
    token = user_session_token_from_request(request)
    if not token:
        raise HTTPException(401, "Authentication required.")
    session = auth_store.get_session_by_token(token)
    if not session:
        raise HTTPException(401, "Session expired or invalid.")
    user = auth_store.get_user_by_id(session["userId"])
    if not user:
        raise HTTPException(401, "User not found.")
    return user


def require_admin_session(
    request: Request, auth_store: UserAuthStore
) -> dict[str, Any]:
    bearer = _bearer_token(request)
    expected = get_admin_token()
    if (
        bearer
        and expected
        and len(bearer) == len(expected)
        and secrets.compare_digest(bearer, expected)
    ):
        return {
            "id": "admin-token",
            "username": "admin-token",
            "role": "admin",
            "isAdmin": True,
        }
    user = require_user_session(request, auth_store)
    if user.get("role") != "admin":
        raise HTTPException(403, "Admin access required.")
    return user


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
