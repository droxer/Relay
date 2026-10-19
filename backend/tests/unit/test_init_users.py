from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

import pytest
from relay.init_users import main
from relay.security.auth import DatabaseAccountAuthStore


def _store() -> DatabaseAccountAuthStore:
    return DatabaseAccountAuthStore(os.environ["RELAY_DATABASE_URL"], create_schema=True)


def test_init_users_script_creates_database_admin(capsys) -> None:
    result = main(["--password", "kestrel-vault-7719"])

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


def test_init_users_script_can_skip_when_users_exist(capsys) -> None:
    args = ["--password", "kestrel-vault-7719"]
    assert main(args) == 0
    assert main([*args, "--only-if-empty"]) == 0
    assert "Users already exist; skipped." in capsys.readouterr().out


def test_init_users_requires_an_explicit_password() -> None:
    with pytest.raises(SystemExit):
        main([])


def test_shell_initializer_targets_the_backend_project_and_module() -> None:
    script = (
        Path(__file__).resolve().parents[3] / "script" / "init_users.sh"
    ).read_text(encoding="utf-8")

    assert 'uv run --project "$ROOT_DIR/backend"' in script
    assert "python -m relay.init_users" in script


def test_init_users_script_accepts_the_pre_rename_employee_id_flag() -> None:
    result = main(
        ["--password", "kestrel-vault-7719", "--employee-id", "ops"]
    )

    assert result == 0
    store = _store()
    account = store.authenticate("admin", "kestrel-vault-7719")
    assert account is not None
    assert account["userId"] == store.resolve_user_id("ops")
    assert [user["handle"] for user in store.list_users()] == ["ops"]
