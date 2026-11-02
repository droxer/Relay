"""Adding host identity keeps pending authorizations issued before deployment."""
from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_authorization_identity_migration_round_trip():
    path = Path(__file__).parents[2] / "migrations/versions/20261102_0106_computer_authorization_identity.py"
    spec = importlib.util.spec_from_file_location("authorization_identity_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE computer_authorizations (device_hash TEXT PRIMARY KEY, status TEXT NOT NULL)"))
        conn.execute(text("INSERT INTO computer_authorizations VALUES ('existing-grant', 'pending')"))
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
            assert conn.execute(text("SELECT workspace_id FROM computer_authorizations")).scalar() is None
            conn.execute(text("UPDATE computer_authorizations SET workspace_id = 'laptop-id'"))
            assert conn.execute(text("SELECT status FROM computer_authorizations")).scalar() == "pending"
            migration.downgrade()
        assert "workspace_id" not in {column["name"] for column in inspect(conn).get_columns("computer_authorizations")}
        assert conn.execute(text("SELECT status FROM computer_authorizations")).scalar() == "pending"
