from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID

import pytest
from relay.init_users import main
from relay.security.auth import DatabaseAccountAuthStore, AccountAuthStore


def test_init_users_script_creates_default_admin(capsys, monkeypatch) -> None:
    monkeypatch.setenv("RELAY_STORAGE", "")
    monkeypatch.setenv("RELAY_AUTH_STORE", "")
    with TemporaryDirectory() as root:
        result = main(["--data-dir", root, "--password", "kestrel-vault-7719"])

        assert result == 0
        assert "Created admin user admin." in capsys.readouterr().out
        store = AccountAuthStore(root)
        account = store.authenticate("admin", "kestrel-vault-7719")
        assert account is not None
        assert account["role"] == "admin"
        assert account["userId"] == "admin"
        assert account["departmentId"] == "administration"


def test_init_users_script_creates_database_admin(capsys, monkeypatch) -> None:
    monkeypatch.setenv("RELAY_AUTH_STORE", "database")
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/auth.db"
        monkeypatch.setenv("RELAY_DATABASE_URL", database_url)
        DatabaseAccountAuthStore(database_url, create_schema=True)

        result = main(["--data-dir", root, "--password", "kestrel-vault-7719"])

        assert result == 0
        assert "Created admin user admin." in capsys.readouterr().out
        store = DatabaseAccountAuthStore(database_url)
        account = store.authenticate("admin", "kestrel-vault-7719")
        assert account is not None
        assert account["role"] == "admin"
        departments = store.list_departments()
        assert departments[0]["name"] == "Administration"
        UUID(departments[0]["id"])
        users = store.list_users()
        UUID(users[0]["id"])
        assert users[0]["id"] == account["userId"]
        assert users[0]["displayName"] == "admin"
        assert users[0]["departmentId"] == departments[0]["id"]


def test_init_users_script_can_skip_when_users_exist(capsys, monkeypatch) -> None:
    monkeypatch.setenv("RELAY_STORAGE", "")
    monkeypatch.setenv("RELAY_AUTH_STORE", "")
    with TemporaryDirectory() as root:
        args = ["--data-dir", root, "--password", "kestrel-vault-7719"]
        assert main(args) == 0
        assert main([*args, "--only-if-empty"]) == 0
        assert "Users already exist; skipped." in capsys.readouterr().out


def test_init_users_requires_an_explicit_password(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_STORAGE", "")
    monkeypatch.setenv("RELAY_AUTH_STORE", "")
    with TemporaryDirectory() as root, pytest.raises(SystemExit):
        main(["--data-dir", root])


def test_shell_initializer_targets_the_backend_project_and_module() -> None:
    script = (
        Path(__file__).resolve().parents[3] / "script" / "init_users.sh"
    ).read_text(encoding="utf-8")

    assert 'uv run --project "$ROOT_DIR/backend"' in script
    assert "python -m relay.init_users" in script


def test_init_users_script_accepts_the_pre_rename_employee_id_flag(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_STORAGE", "")
    monkeypatch.setenv("RELAY_AUTH_STORE", "")
    with TemporaryDirectory() as root:
        result = main(
            ["--data-dir", root, "--password", "kestrel-vault-7719", "--employee-id", "ops"]
        )

        assert result == 0
        account = AccountAuthStore(root).authenticate("admin", "kestrel-vault-7719")
        assert account is not None
        assert account["userId"] == "ops"
