"""The database account store, assembled from one mixin per concern."""

from __future__ import annotations

from threading import RLock

from .auth_accounts import AuthAccounts
from .auth_departments import AuthDepartments
from .auth_sessions import AuthLoginSessions
from .auth_users import AuthUsers
from ..core.storage_config import database_url_from_env
from ..persistence.engine import create_all_tables, shared_engine
from ..persistence.sql import metadata as shared_metadata
from ..persistence.tables import auth as auth_tables

DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60  # 1 week
_AUTH_LOCKS: dict[str, RLock] = {}
_AUTH_LOCKS_GUARD = RLock()


def _shared_auth_lock(key: str) -> RLock:
    with _AUTH_LOCKS_GUARD:
        return _AUTH_LOCKS.setdefault(key, RLock())


class DatabaseAccountAuthStore(
    AuthAccounts,
    AuthUsers,
    AuthDepartments,
    AuthLoginSessions,
):
    metadata = shared_metadata

    departments = auth_tables.departments
    users = auth_tables.users
    accounts = auth_tables.accounts
    sessions = auth_tables.sessions
    password_resets = auth_tables.password_resets

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


def auth_store_from_env() -> DatabaseAccountAuthStore:
    database_url = database_url_from_env(setting="database-only account storage")
    return DatabaseAccountAuthStore(
        database_url, create_schema=database_url.startswith("sqlite")
    )
