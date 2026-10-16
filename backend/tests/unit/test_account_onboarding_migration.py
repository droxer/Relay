from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def migration(connection):
    path = Path(__file__).parents[2] / "migrations/versions/20261016_0098_account_onboarding.py"
    spec = importlib.util.spec_from_file_location("account_onboarding_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = Operations(MigrationContext.configure(connection))
    return module


def test_existing_accounts_start_with_the_wizard_dismissed() -> None:
    with create_engine("sqlite:///:memory:").begin() as connection:
        connection.execute(text("CREATE TABLE auth_accounts (id TEXT PRIMARY KEY, username TEXT)"))
        connection.execute(text("INSERT INTO auth_accounts VALUES ('a1', 'alice'), ('a2', 'bob')"))

        migration(connection).upgrade()

        rows = connection.execute(text("SELECT onboarding FROM auth_accounts ORDER BY id")).all()
        for (raw,) in rows:
            record = json.loads(raw)
            assert record["dismissedAt"].endswith("Z")
            assert record["introSeenAt"] == record["dismissedAt"]


def test_downgrade_drops_the_column() -> None:
    with create_engine("sqlite:///:memory:").begin() as connection:
        connection.execute(text("CREATE TABLE auth_accounts (id TEXT PRIMARY KEY, username TEXT)"))
        module = migration(connection)
        module.upgrade()
        module.downgrade()

        columns = {column["name"] for column in inspect(connection).get_columns("auth_accounts")}
        assert "onboarding" not in columns
