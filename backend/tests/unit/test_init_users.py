from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import UUID

import pytest
from relay.init_users import main
from relay.security.auth import DatabaseAccountAuthStore
from relay.security.credentials import hash_password


def _store() -> DatabaseAccountAuthStore:
    return DatabaseAccountAuthStore(os.environ["RELAY_DATABASE_URL"], create_schema=True)


def test_init_users_script_creates_database_admin(capsys, tmp_path: Path) -> None:
    result = main(["--data-dir", str(tmp_path), "--password", "kestrel-vault-7719"])

    assert result == 0
    assert "Created admin user admin." in capsys.readouterr().out
    store = _store()
    account = store.authenticate("admin", "kestrel-vault-7719")
    assert account is not None
    assert account["role"] == "admin"
    departments = store.list_departments()
    assert departments[0]["name"] == "Administration"
    UUID(departments[0]["id"])
    users = store.list_users()
    UUID(users[0]["id"])
    assert users[0]["id"] == account["userId"]
    assert users[0]["handle"] == "admin"
    assert users[0]["displayName"] == "admin"
    assert users[0]["departmentId"] == departments[0]["id"]


def test_init_users_script_can_skip_when_users_exist(capsys, tmp_path: Path) -> None:
    args = ["--data-dir", str(tmp_path), "--password", "kestrel-vault-7719"]
    assert main(args) == 0
    assert main([*args, "--only-if-empty"]) == 0
    assert "Users already exist; skipped." in capsys.readouterr().out


def test_init_users_imports_retired_account_files_first(capsys, tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "users.json").write_text(json.dumps([{
        "id": "0b6c6f8e-1c4b-4c49-9b8e-6f0d3f0b6a11",
        "username": "admin",
        "role": "admin",
        "employeeId": "admin",
        "passwordHash": hash_password("kestrel-vault-7719"),
        "createdAt": "2026-06-13T00:00:00.000Z",
        "updatedAt": "2026-06-13T00:00:00.000Z",
    }]), encoding="utf-8")

    result = main([
        "--data-dir", str(tmp_path), "--password", "another-vault-8820", "--only-if-empty",
    ])

    assert result == 0
    assert "Users already exist; skipped." in capsys.readouterr().out
    assert _store().authenticate("admin", "kestrel-vault-7719") is not None


def test_init_users_requires_an_explicit_password(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        main(["--data-dir", str(tmp_path)])


def test_shell_initializer_targets_the_backend_project_and_module() -> None:
    script = (
        Path(__file__).resolve().parents[3] / "script" / "init_users.sh"
    ).read_text(encoding="utf-8")

    assert 'uv run --project "$ROOT_DIR/backend"' in script
    assert "python -m relay.init_users" in script


def test_init_users_script_accepts_the_pre_rename_employee_id_flag(tmp_path: Path) -> None:
    result = main(
        ["--data-dir", str(tmp_path), "--password", "kestrel-vault-7719", "--employee-id", "ops"]
    )

    assert result == 0
    store = _store()
    account = store.authenticate("admin", "kestrel-vault-7719")
    assert account is not None
    assert account["userId"] == store.resolve_user_id("ops")
    assert [user["handle"] for user in store.list_users()] == ["ops"]
