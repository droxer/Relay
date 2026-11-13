"""Migration 0126 adds case-insensitive Account email uniqueness without
touching legacy rows, and refuses (with a report) when old data would break it."""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from relay.ops.account_email_audit import audit_account_emails
from relay.persistence.tables.auth import accounts
from sqlalchemy import Connection, create_engine, text
from sqlalchemy.exc import IntegrityError

MIGRATION = Path(__file__).parents[2] / "migrations/versions/20261113_0126_account_email_identity.py"
INDEX = "uq_auth_accounts_email_lower"


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("account_email_identity_migration", MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def conn() -> Iterator[Connection]:
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)"))
        connection.execute(text(
            "CREATE TABLE auth_accounts (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, "
            "email TEXT, user_id TEXT)"
        ))
        yield connection
    engine.dispose()


def _rows(conn: Connection, *accounts_rows: tuple, users_rows: tuple = ()) -> None:
    for row in users_rows:
        conn.execute(text("INSERT INTO users VALUES (:id, :email)"), dict(zip(("id", "email"), row, strict=True)))
    for row in accounts_rows:
        conn.execute(
            text("INSERT INTO auth_accounts VALUES (:id, :username, :email, :user_id)"),
            dict(zip(("id", "username", "email", "user_id"), row, strict=True)),
        )


def _indexes(conn: Connection) -> set[str]:
    # The inspector skips expression indexes on SQLite, so read the catalog.
    return set(conn.execute(text(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'auth_accounts'"
    )).scalars())


def test_upgrade_keeps_legacy_rows_and_enforces_uniqueness_then_downgrades(conn) -> None:
    _rows(conn, ("a1", "legacy", None, None), ("a2", "alice", "Alice@Example.com", "u2"),
          users_rows=(("u2", "alice@example.com"),))
    migration = _migration()
    with Operations.context(MigrationContext.configure(conn)):
        migration.upgrade()
        assert INDEX in _indexes(conn)
        assert conn.execute(text("SELECT id, username, email FROM auth_accounts ORDER BY id")).all() == [
            ("a1", "legacy", None), ("a2", "alice", "Alice@Example.com"),
        ]
        # A second legacy row without email is still valid.
        _rows(conn, ("a3", "legacy2", None, None))
        with pytest.raises(IntegrityError):
            with conn.begin_nested():
                _rows(conn, ("a4", "alice2", "ALICE@example.com", None))
        migration.downgrade()
        assert INDEX not in _indexes(conn)
        _rows(conn, ("a5", "alice3", "alice@EXAMPLE.com", None))
    assert conn.execute(text("SELECT count(*) FROM auth_accounts")).scalar() == 4


def test_upgrade_refuses_duplicate_emails_and_names_them(conn) -> None:
    _rows(conn, ("a1", "one", "dup@example.com", None), ("a2", "two", " DUP@example.com", None))
    with Operations.context(MigrationContext.configure(conn)):
        with pytest.raises(RuntimeError) as raised:
            _migration().upgrade()
    message = str(raised.value)
    assert "a1" in message and "a2" in message
    assert "audit-account-emails" in message
    assert INDEX not in _indexes(conn)
    assert conn.execute(text("SELECT count(*) FROM auth_accounts")).scalar() == 2


def test_audit_reports_ambiguity_without_blocking_the_upgrade(conn) -> None:
    _rows(
        conn,
        ("a1", "jay@example.com", None, None),
        ("a2", "jay", "Jay@Example.com", "u2"),
        ("a3", "kay", "kay@example.com", "u3"),
        ("a4", "nomail", "not-an-email", None),
        users_rows=(("u2", "jay@example.com"), ("u3", "kay.other@example.com")),
    )
    audit = audit_account_emails(conn)
    assert audit.duplicate_emails == {}
    assert audit.ambiguous_identifiers == {"jay@example.com": ["a1", "a2"]}
    assert audit.invalid_emails == ["a4"]
    assert audit.unnormalized_emails == ["a2"]
    assert audit.user_email_mismatches == ["a3"]
    assert audit.accounts_without_email == ["a1"]
    with Operations.context(MigrationContext.configure(conn)):
        _migration().upgrade()
    assert INDEX in _indexes(conn)


def test_metadata_declares_the_same_index() -> None:
    declared = {index.name: index for index in accounts.indexes}
    assert INDEX in declared
    index = declared[INDEX]
    assert index.unique
    assert [str(expression) for expression in index.expressions] == ["lower(auth_accounts.email)"]
