"""The GitHub connection schema migrates and account deletion removes secrets."""

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_connection_migration_and_account_cascade():
    path = Path(__file__).parents[2] / "migrations/versions/20261103_0108_github_connections.py"
    spec = importlib.util.spec_from_file_location("github_connection_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with create_engine("sqlite:///:memory:").begin() as connection:
        connection.execute(text("PRAGMA foreign_keys=ON"))
        connection.execute(text("CREATE TABLE auth_accounts (id TEXT PRIMARY KEY)"))
        module.op = Operations(MigrationContext.configure(connection))
        module.upgrade()
        assert {index["name"] for index in inspect(connection).get_indexes("account_github_states")} == {
            "ix_account_github_states_account_id", "ix_account_github_states_expires_at"}
        connection.execute(text("INSERT INTO auth_accounts VALUES ('a1')"))
        connection.execute(text("INSERT INTO account_github_connections VALUES ('a1', 'sealed')"))
        connection.execute(text("INSERT INTO account_github_states VALUES ('hash', 'a1', 'sealed', 123)"))
        connection.execute(text("DELETE FROM auth_accounts WHERE id='a1'"))
        assert connection.scalar(text("SELECT count(*) FROM account_github_connections")) == 0
        assert connection.scalar(text("SELECT count(*) FROM account_github_states")) == 0
        module.downgrade()
        assert not any(name.startswith("account_github_") for name in inspect(connection).get_table_names())
