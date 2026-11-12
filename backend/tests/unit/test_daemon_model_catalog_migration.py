"""Model catalog columns preserve existing nodes across upgrade/downgrade."""
import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_model_catalog_upgrade_and_downgrade() -> None:
    path = Path(__file__).parents[2] / "migrations/versions/20261112_0125_daemon_model_catalog.py"
    spec = importlib.util.spec_from_file_location("daemon_model_catalog_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE daemon_node_agents (node_id TEXT, agent TEXT)"))
            conn.execute(text("INSERT INTO daemon_node_agents VALUES ('existing', 'codex')"))
            with Operations.context(MigrationContext.configure(conn)):
                migration.upgrade()
                assert conn.execute(text(
                    "SELECT node_id, agent, models, custom_model_endpoint, default_model "
                    "FROM daemon_node_agents"
                )).all() == [("existing", "codex", None, None, None)]
                migration.downgrade()
                assert [column["name"] for column in inspect(conn).get_columns("daemon_node_agents")] == [
                    "node_id", "agent",
                ]
                assert conn.execute(text("SELECT * FROM daemon_node_agents")).all() == [("existing", "codex")]
    finally:
        engine.dispose()
