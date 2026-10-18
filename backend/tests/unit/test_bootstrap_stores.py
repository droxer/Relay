from __future__ import annotations

from pathlib import Path

import pytest
from relay.bootstrap.stores import _require_database_accounts_on_postgres
from relay.security.auth import AccountAuthStore, DatabaseAccountAuthStore


def test_postgres_refuses_file_backed_accounts(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="RELAY_AUTH_STORE=database"):
        _require_database_accounts_on_postgres("postgresql", AccountAuthStore(tmp_path))


def test_sqlite_keeps_file_backed_accounts(tmp_path: Path) -> None:
    _require_database_accounts_on_postgres("sqlite", AccountAuthStore(tmp_path))


def test_postgres_accepts_database_accounts(tmp_path: Path) -> None:
    accounts = DatabaseAccountAuthStore(f"sqlite:///{tmp_path}/auth.db")
    _require_database_accounts_on_postgres("postgresql", accounts)
