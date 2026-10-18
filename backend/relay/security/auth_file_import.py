"""One-time, non-destructive import of the retired file-backed accounts store.

Accounts used to live in JSON under ``<data dir>/auth/`` unless
``RELAY_AUTH_STORE=database`` or ``RELAY_STORAGE=postgres`` chose the
database. Accounts are database-only now; this module moves an existing
install's files into the configured database once, at boot (before the other
retired stores, so their rows find the users they reference) or by hand
(``relay migrate-local-file-stores --data-dir <dir> [--dry-run]``).

Legacy layout read (relative to the data directory)::

    auth/users.json                 accounts, each carrying its user inline
    auth/deleted_users.json         soft-deleted user ids (or the pre-rename
                                    deleted_employees.json)
    auth/sessions.json              login sessions            -- skipped
    auth/password-resets.json       password reset links      -- skipped

Every file is read with ``_read_json``, which upgrades the pre-rename
``employee*`` keys on read, exactly as the file store did.

Imported: every account (username, password hash, role, email, theme,
language, onboarding choices, timestamps) and the user and department each one
names. A user keeps the id the file store gave it -- other tables reference it
-- so a handle-shaped id stays as written; PostgreSQL keeps user ids as UUIDs,
so there it must already be one. The handle is the id when it fits the handle
grammar, else one derived from the display name.

Skipped and counted: login sessions (people sign in again) and password reset
links (people ask for a new one). Both are short-lived, and a session's token
hash would have to outlive the store that issued it.

When ``RELAY_STORAGE=postgres`` or ``RELAY_AUTH_STORE=database`` is still set,
the database already held the accounts and any files are leftovers the backend
never read: the import records that and imports nothing.

Idempotent and atomic like ``persistence/file_store_import.py``: a marker
keyed by the source root (kind ``auth-file-imports``) makes a second run a
no-op, separate from the other stores' marker so an install that imported
those first still gets its accounts. Without a marker, a row already in the
database must match exactly or the whole import rolls back with a
``ValueError`` naming the record. Source files are never modified or deleted.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import select

from ..persistence.file_store_import import (
    RowImporter,
    import_marker,
    import_transaction,
    source_id,
    write_import_marker,
)
from ..persistence.store_common import (
    _parse_iso,
    _read_json,
    create_all_tables,
    shared_engine,
    store_transaction,
)
from ..persistence.tables import auth as auth_tables
from .auth import (
    database_account_to_row,
    database_id_for_reference,
    normalize_database_id,
    slugify_handle,
)
from .user_handles import user_handle_or_none

ACCOUNT_IMPORT_MARKER_KIND = "auth-file-imports"
_COUNT_KEYS = ("accounts", "users", "departments")
_AUTH_FILES = (
    "users.json",
    "deleted_users.json",
    "deleted_employees.json",
    "sessions.json",
    "password-resets.json",
)
_IGNORED_TIMESTAMPS = frozenset({"updated_at"})


def legacy_accounts_present(root: str | Path) -> bool:
    """Whether the data directory still holds any file-store account record."""
    auth = Path(root) / "auth"
    return any((auth / name).exists() for name in _AUTH_FILES)


def accounts_imported(root: str | Path, database_url: str) -> bool:
    engine = shared_engine(database_url)
    if engine.dialect.name == "sqlite":
        create_all_tables(engine)
    with store_transaction(engine) as conn:
        marker = import_marker(conn, ACCOUNT_IMPORT_MARKER_KIND, source_id(Path(root)))
    return marker is not None


def _read_list(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    value = _read_json(path)
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


class _AccountImporter(RowImporter):
    """Writes one data directory's accounts into one open transaction."""

    def __init__(self, conn: Any, root: Path, *, dry_run: bool, dialect: str) -> None:
        super().__init__(conn, dry_run=dry_run, count_keys=_COUNT_KEYS)
        self.auth = root / "auth"
        self.dialect = dialect
        self.user_ids: set[str] = set()
        self.department_ids: set[str] = set()

    def _require_uuid(self, value: str, label: str) -> None:
        # SQLite stores ids as text; PostgreSQL's uuid column refuses anything
        # else, and would abort the transaction with a far vaguer error.
        if self.dialect != "sqlite" and not normalize_database_id(value):
            raise ValueError(
                f"Cannot import {label}: its id {value!r} is not a UUID, which "
                "PostgreSQL requires."
            )

    def _deleted_users(self) -> dict[str, Any]:
        path = self.auth / "deleted_users.json"
        if not path.exists():
            path = self.auth / "deleted_employees.json"
        return {
            str(entry["id"]).strip(): entry.get("deletedAt")
            for entry in _read_list(path)
            if entry.get("id")
        }

    def _import_department(self, account: dict[str, Any]) -> str | None:
        requested = (account.get("departmentId") or "").strip()
        if not requested:
            return None
        department_id = database_id_for_reference(requested, "department")
        if department_id in self.department_ids:
            return department_id
        self.department_ids.add(department_id)
        # A department is a shared label: one the database already has (the
        # same name hashes to the same id) is simply reused.
        if self._existing(auth_tables.departments, department_id) is None:
            stamp = _parse_iso(account["createdAt"])
            name = (account.get("departmentName") or "").strip() or requested
            self._execute(
                f"department {requested}",
                auth_tables.departments.insert().values(
                    id=department_id,
                    name=name,
                    parent_department_id=None,
                    created_at=stamp,
                    updated_at=stamp,
                ),
            )
            self.counts["departments"] += 1
        return department_id

    def _handle(self, user_id: str, display_name: str) -> str | None:
        return user_handle_or_none(user_id) or slugify_handle(display_name) or None

    def _import_user(self, account: dict[str, Any], deleted: dict[str, Any]) -> str | None:
        user_id = (account.get("userId") or "").strip()
        if not user_id:
            return None
        if user_id in self.user_ids:
            return user_id
        label = f"user {user_id}"
        self._require_uuid(user_id, label)
        department_id = self._import_department(account)
        display_name = (account.get("displayName") or "").strip() or account["username"]
        handle = self._handle(user_id, display_name)
        if handle:
            owner = self.conn.scalar(
                select(auth_tables.users.c.id).where(auth_tables.users.c.handle == handle)
            )
            if owner is not None and str(owner) != user_id:
                raise ValueError(
                    f"Conflicting {label}: the database already holds a "
                    f"different user with the handle @{handle}."
                )
        deleted_at = deleted.get(user_id)
        row = {
            "id": user_id,
            "handle": handle,
            "display_name": display_name,
            "email": account.get("email"),
            "department_id": department_id,
            "max_local_computers": None,
            "created_at": _parse_iso(account["createdAt"]),
            "updated_at": _parse_iso(account.get("updatedAt") or account["createdAt"]),
            "deleted_at": _parse_iso(deleted_at) if deleted_at else None,
        }
        if self._put(auth_tables.users, row, label, ignore=_IGNORED_TIMESTAMPS):
            self.counts["users"] += 1
        self.user_ids.add(user_id)
        return user_id

    def _import_account(self, account: dict[str, Any], deleted: dict[str, Any]) -> None:
        missing = [
            key for key in ("id", "username", "passwordHash", "role", "createdAt")
            if not account.get(key)
        ]
        username = str(account.get("username") or "").strip().lower()
        label = f"account {username or account.get('id') or '(unnamed)'}"
        if missing:
            raise ValueError(f"Cannot import {label}: it has no {', '.join(missing)}.")
        account = {
            **account,
            "username": username,
            "updatedAt": account.get("updatedAt") or account["createdAt"],
        }
        self._require_uuid(str(account["id"]), label)
        holder = self.conn.scalar(
            select(auth_tables.accounts.c.id).where(auth_tables.accounts.c.username == username)
        )
        if holder is not None and str(holder) != str(account["id"]):
            raise ValueError(
                f"Conflicting {label}: the database already holds a different "
                "account with this username."
            )
        user_id = self._import_user(account, deleted)
        row = database_account_to_row(account, user_pk=user_id)
        if self._put(auth_tables.accounts, row, label, ignore=_IGNORED_TIMESTAMPS):
            self.counts["accounts"] += 1

    def run(self) -> None:
        deleted = self._deleted_users()
        for account in _read_list(self.auth / "users.json"):
            self._import_account(account, deleted)
        self._skip(
            "deletedUsersWithoutAccount",
            sum(1 for user_id in deleted if user_id not in self.user_ids),
        )
        self._skip("loginSessions", len(_read_list(self.auth / "sessions.json")))
        self._skip("passwordResetLinks", len(_read_list(self.auth / "password-resets.json")))


def migrate_legacy_accounts(
    root_dir: str | Path,
    database_url: str,
    *,
    dry_run: bool = False,
    accounts_already_in_database: bool = False,
) -> dict[str, Any]:
    """Import the retired file accounts under ``root_dir`` into the database.

    ``accounts_already_in_database`` records that the database was already
    the account store, so the files are leftovers: nothing is imported. Raises
    ``ValueError`` on a conflicting record; nothing is written in that case.
    """
    root = Path(root_dir)
    marker_id = source_id(root)
    engine = shared_engine(database_url)
    if engine.dialect.name == "sqlite":
        create_all_tables(engine)
    report: dict[str, Any] = {
        "alreadyImported": False,
        "dryRun": dry_run,
        "accountsAlreadyInDatabase": accounts_already_in_database,
        **dict.fromkeys(_COUNT_KEYS, 0),
        "skipped": {},
    }
    with import_transaction(engine) as conn:
        if import_marker(conn, ACCOUNT_IMPORT_MARKER_KIND, marker_id) is not None:
            return {**report, "alreadyImported": True}
        if accounts_already_in_database:
            if not dry_run:
                write_import_marker(
                    conn,
                    ACCOUNT_IMPORT_MARKER_KIND,
                    marker_id,
                    root,
                    {"skippedReason": "accounts were already kept in the database"},
                )
            return report
        importer = _AccountImporter(
            conn, root, dry_run=dry_run, dialect=engine.dialect.name
        )
        importer.run()
        if not dry_run:
            write_import_marker(
                conn,
                ACCOUNT_IMPORT_MARKER_KIND,
                marker_id,
                root,
                {"counts": importer.counts, "skipped": importer.skipped},
            )
    return {**report, **importer.counts, "skipped": importer.skipped}
