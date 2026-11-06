"""Existing nodes have unknown release identity until their next registration."""
import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_client_version_upgrade_and_downgrade_preserve_nodes():
    path = Path(__file__).parents[2] / "migrations/versions/20261106_0120_daemon_client_version.py"
    spec = importlib.util.spec_from_file_location("daemon_client_version_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE daemon_nodes (id TEXT PRIMARY KEY)"))
            conn.execute(text("INSERT INTO daemon_nodes VALUES ('existing')"))
            with Operations.context(MigrationContext.configure(conn)):
                migration.upgrade()
                assert conn.execute(text("SELECT id, client_version FROM daemon_nodes")).all() == [
                    ("existing", None),
                ]
                conn.execute(text("UPDATE daemon_nodes SET client_version = '1.2.3'"))
                migration.downgrade()
                assert [column["name"] for column in inspect(conn).get_columns("daemon_nodes")] == ["id"]
                assert conn.execute(text("SELECT id FROM daemon_nodes")).all() == [("existing",)]
    finally:
        engine.dispose()
