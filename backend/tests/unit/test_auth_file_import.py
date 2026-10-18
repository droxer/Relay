"""The retired file accounts store imports into the database once, safely."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from relay.app import create_app
from relay.persistence.file_store_import import migrate_local_file_stores
from relay.persistence.tables import auth as auth_tables
from relay.security.auth import hash_password
from relay.security.auth_file_import import (
    accounts_imported,
    legacy_accounts_present,
    migrate_legacy_accounts,
)
from store_fixtures import make_auth_store, sqlite_url

ADMIN_ID = "0b6c6f8e-1c4b-4c49-9b8e-6f0d3f0b6a11"
ALICE_ID = "1c7d7f9f-2d5c-4d5a-8c9f-7a1e4a1c7b22"
ORPHAN_ID = "2d8e8a0a-3e6d-4e6b-9daa-8b2f5b2d8c33"
AGENT_ID = "33333333-3333-4333-8333-333333333333"
T0 = "2026-06-13T00:00:00.000Z"
T1 = "2026-06-14T00:00:00.000Z"
PASSWORD = "kestrel-vault-7719"
PASSWORD_HASH = hash_password(PASSWORD)


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def write_legacy_auth(root: Path, *, alice_email: str = "alice@example.com") -> None:
    """Accounts as the file store wrote them, pre-rename keys included."""
    auth = root / "auth"
    _write(auth / "users.json", [
        {
            "id": ADMIN_ID,
            "username": "admin",
            "email": None,
            "role": "admin",
            "employeeId": "admin",  # pre-rename key, upgraded on read
            "displayName": "Admin",
            "departmentId": "administration",
            "departmentName": "Administration",
            "theme": "dark",
            "language": "zh-TW",  # retired; reads back as zh-CN
            "passwordHash": PASSWORD_HASH,
            "createdAt": T0,
            "updatedAt": T1,
        },
        {
            "id": ALICE_ID,
            "username": "alice",
            "email": alice_email,
            "role": "user",
            "userId": "alice",
            "displayName": "Alice",
            "onboarding": {"introSeenAt": T1, "closedCards": ["teams"]},
            "passwordHash": PASSWORD_HASH,
            "createdAt": T0,
            "updatedAt": T0,
        },
        {
            "id": ORPHAN_ID,
            "username": "service",
            "role": "user",
            "passwordHash": PASSWORD_HASH,
            "createdAt": T0,
        },
    ])
    # Only the pre-rename file name exists; it is read, never renamed.
    _write(auth / "deleted_employees.json", [
        {"id": "alice", "deletedAt": T1},
        {"id": "ghost", "deletedAt": T1},
    ])
    _write(auth / "sessions.json", [
        {"tokenHash": "h1", "accountId": ADMIN_ID, "createdAt": T0, "expiresAt": T1},
        {"token": "legacy", "userId": ALICE_ID, "createdAt": T0, "expiresAt": T1},
    ])
    _write(auth / "password-resets.json", [
        {"id": "r1", "accountId": ALICE_ID, "tokenHash": "t", "createdAt": T0, "expiresAt": T1},
    ])


def _users(store: Any) -> dict[str, dict[str, Any]]:
    with store.engine.begin() as conn:
        rows = conn.execute(select(auth_tables.users)).mappings().all()
    return {str(row["id"]): dict(row) for row in rows}


def test_imports_accounts_users_and_departments(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_auth(source)
    assert legacy_accounts_present(source)

    report = migrate_legacy_accounts(source, sqlite_url(tmp_path / "db"))

    assert report["accounts"] == 3
    assert report["users"] == 2
    assert report["departments"] == 1
    assert report["skipped"] == {
        "deletedUsersWithoutAccount": 1,
        "loginSessions": 2,
        "passwordResetLinks": 1,
    }
    store = make_auth_store(tmp_path / "db")
    admin = store.authenticate("admin", PASSWORD)
    assert admin is not None
    assert admin["id"] == ADMIN_ID
    assert admin["role"] == "admin"
    # Ids are kept verbatim so every row that references them still matches.
    assert admin["userId"] == "admin"
    assert admin["theme"] == "dark"
    assert admin["language"] == "zh-CN"
    users = _users(store)
    assert users["admin"]["handle"] == "admin"
    assert users["admin"]["display_name"] == "Admin"
    department = store.list_departments()[0]
    assert department["name"] == "Administration"
    assert str(users["admin"]["department_id"]) == department["id"]
    # A soft-deleted user is imported deleted, and cannot sign in.
    assert users["alice"]["deleted_at"] is not None
    assert store.authenticate("alice", PASSWORD) is None
    assert [user["id"] for user in store.list_users()] == ["admin"]
    # An account without a user keeps none.
    service = store.authenticate("service", PASSWORD)
    assert service is not None and service["userId"] is None
    # Sessions were skipped: nobody is signed in.
    assert store.get_session_by_token("legacy") is None
    # Source files are never modified or renamed.
    assert (source / "auth" / "deleted_employees.json").exists()
    assert not (source / "auth" / "deleted_users.json").exists()


def test_imported_preferences_and_handles_resolve(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_auth(source)
    _write(source / "auth" / "deleted_employees.json", [])
    migrate_legacy_accounts(source, sqlite_url(tmp_path / "db"))
    store = make_auth_store(tmp_path / "db")

    alice = store.authenticate("alice", PASSWORD)
    assert alice is not None
    assert alice["onboarding"] == {"introSeenAt": T1, "closedCards": ["teams"]}
    assert store.resolve_user_id("alice") == "alice"
    # ensure_user finds the imported row instead of minting a uuid5 twin.
    assert store.ensure_user("alice", display_name="Alice B.")["id"] == "alice"
    assert [user["id"] for user in store.list_users()] == ["admin", "alice"]


def test_second_import_is_a_no_op(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_auth(source)
    url = sqlite_url(tmp_path / "db")
    migrate_legacy_accounts(source, url)
    assert accounts_imported(source, url)

    again = migrate_legacy_accounts(source, url)

    assert again["alreadyImported"] is True
    assert again["accounts"] == 0


def test_identical_rows_from_another_root_are_accepted(tmp_path: Path) -> None:
    url = sqlite_url(tmp_path / "db")
    write_legacy_auth(tmp_path / "first")
    write_legacy_auth(tmp_path / "copy")
    migrate_legacy_accounts(tmp_path / "first", url)

    report = migrate_legacy_accounts(tmp_path / "copy", url)

    assert report["alreadyImported"] is False
    assert report["accounts"] == 0 and report["users"] == 0
    assert len(make_auth_store(tmp_path / "db").list_accounts()) == 3


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_auth(source)
    url = sqlite_url(tmp_path / "db")

    report = migrate_legacy_accounts(source, url, dry_run=True)

    assert report["dryRun"] is True
    assert report["accounts"] == 3
    assert make_auth_store(tmp_path / "db").list_accounts() == []
    assert not accounts_imported(source, url)
    assert migrate_legacy_accounts(source, url)["accounts"] == 3


def test_conflicting_account_raises_and_writes_nothing(tmp_path: Path) -> None:
    url = sqlite_url(tmp_path / "db")
    write_legacy_auth(tmp_path / "first")
    migrate_legacy_accounts(tmp_path / "first", url)
    write_legacy_auth(tmp_path / "second", alice_email="someone-else@example.com")

    with pytest.raises(ValueError, match="Conflicting user alice.*email differs"):
        migrate_legacy_accounts(tmp_path / "second", url)

    assert not accounts_imported(tmp_path / "second", url)


def test_a_username_already_taken_in_the_database_is_a_conflict(tmp_path: Path) -> None:
    store = make_auth_store(tmp_path / "db")
    store.create_account("admin", PASSWORD, role="admin")
    write_legacy_auth(tmp_path / "data")

    with pytest.raises(ValueError, match="account admin.*username"):
        migrate_legacy_accounts(tmp_path / "data", sqlite_url(tmp_path / "db"))

    assert [account["username"] for account in store.list_accounts()] == ["admin"]


def test_a_handle_already_taken_in_the_database_is_a_conflict(tmp_path: Path) -> None:
    store = make_auth_store(tmp_path / "db")
    store.create_account("alice2", PASSWORD, user_id="alice")
    write_legacy_auth(tmp_path / "data")

    with pytest.raises(ValueError, match="user alice.*@alice"):
        migrate_legacy_accounts(tmp_path / "data", sqlite_url(tmp_path / "db"))


def test_leftover_files_beside_database_accounts_are_not_imported(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_auth(source)
    store = make_auth_store(tmp_path / "db")
    store.create_account("admin", PASSWORD, role="admin")
    url = sqlite_url(tmp_path / "db")

    report = migrate_legacy_accounts(source, url, accounts_already_in_database=True)

    assert report["accountsAlreadyInDatabase"] is True
    assert report["accounts"] == 0
    assert accounts_imported(source, url)
    # The marker holds even once the retired setting is gone.
    assert migrate_legacy_accounts(source, url)["alreadyImported"] is True
    assert [account["username"] for account in store.list_accounts()] == ["admin"]


def test_boot_imports_accounts_through_create_app(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_auth(source)

    client = TestClient(create_app(source))
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": PASSWORD}
    )

    assert response.status_code == 200
    assert response.json()["user"]["userId"] == "admin"
    # A restart finds the marker and imports nothing twice.
    restarted = create_app(source)
    assert len(restarted.state.auth_store.list_accounts()) == 3


def test_boot_imports_accounts_before_the_other_stores(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_auth(source)
    _write(source / "agents" / AGENT_ID / "snapshot.json", {
        "id": AGENT_ID,
        "supervisorUserId": "admin",
        "displayName": "Builder",
        "executorKind": "claude",
        "enabled": True,
        "version": 1,
        "createdAt": T0,
        "updatedAt": T0,
    })

    app = create_app(source)

    agent = app.state.agent_store.get_agent(AGENT_ID)
    assert agent["supervisorUserId"] == "admin"
    assert app.state.auth_store.resolve_user_id("admin") == agent["supervisorUserId"]


def test_accounts_import_after_the_other_stores_were_imported(tmp_path: Path) -> None:
    """An install upgraded through the previous release has the other stores'
    marker already; its accounts must still be imported."""
    source = tmp_path / "data"
    _write(source / "agents" / AGENT_ID / "snapshot.json", {
        "id": AGENT_ID,
        "supervisorUserId": "admin",
        "displayName": "Builder",
        "executorKind": "claude",
        "enabled": True,
        "version": 1,
        "createdAt": T0,
        "updatedAt": T0,
    })
    migrate_local_file_stores(source, os.environ["RELAY_DATABASE_URL"])
    write_legacy_auth(source)

    app = create_app(source)

    assert app.state.auth_store.authenticate("admin", PASSWORD) is not None
    assert app.state.agent_store.get_agent(AGENT_ID)["displayName"] == "Builder"


def test_boot_fails_on_conflict_naming_the_cli(tmp_path: Path) -> None:
    write_legacy_auth(tmp_path / "first")
    migrate_legacy_accounts(tmp_path / "first", os.environ["RELAY_DATABASE_URL"])
    write_legacy_auth(tmp_path / "second", alice_email="someone-else@example.com")

    with pytest.raises(RuntimeError, match="relay migrate-local-file-stores"):
        create_app(tmp_path / "second")


def test_boot_with_repairs_off_refuses_a_pending_import(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("RELAY_STARTUP_REPAIRS", "0")
    write_legacy_auth(tmp_path / "data")

    with pytest.raises(RuntimeError, match="have not been imported"):
        create_app(tmp_path / "data")


def test_boot_skips_leftover_files_while_the_retired_switch_is_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("RELAY_STORAGE", "postgres")
    write_legacy_auth(tmp_path / "data")

    app = create_app(tmp_path / "data")

    assert app.state.auth_store.list_accounts() == []


def test_empty_data_dir_has_no_accounts_to_import(tmp_path: Path) -> None:
    assert not legacy_accounts_present(tmp_path)


def test_cli_imports_accounts_with_the_other_stores(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from relay import cli

    monkeypatch.setattr(cli, "setup_logging", lambda: None)
    source = tmp_path / "data"
    write_legacy_auth(source)

    cli.main(["migrate-local-file-stores", "--data-dir", str(source), "--dry-run"])
    preview = json.loads(capsys.readouterr().out)
    cli.main(["migrate-local-file-stores", "--data-dir", str(source)])
    report = json.loads(capsys.readouterr().out)

    assert preview["dryRun"] is True and preview["accounts"]["accounts"] == 3
    assert report["accounts"]["accounts"] == 3
    assert report["accounts"]["skipped"]["loginSessions"] == 2
    assert report["nodes"] == 0
    assert accounts_imported(source, os.environ["RELAY_DATABASE_URL"])
