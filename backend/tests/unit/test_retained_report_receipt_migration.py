"""Receipt acknowledgements survive command pruning in an upgraded database."""
import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_upgrade_retains_receipts_and_downgrade_restores_cascade():
    path = Path(__file__).parents[2] / "migrations/versions/20261110_0123_retained_report_receipts.py"
    spec = importlib.util.spec_from_file_location("retained_receipts", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
        conn.execute(text("CREATE TABLE daemon_commands (id TEXT PRIMARY KEY)"))
        conn.execute(text("""CREATE TABLE daemon_report_receipts (
            command_id TEXT REFERENCES daemon_commands(id) ON DELETE CASCADE,
            report_id TEXT, node_id TEXT NOT NULL, digest TEXT NOT NULL,
            PRIMARY KEY (command_id, report_id))"""))
        conn.execute(text("INSERT INTO daemon_commands VALUES ('command')"))
        conn.execute(text("INSERT INTO daemon_report_receipts VALUES ('command', 'report', 'node', 'digest')"))
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        migration.upgrade()  # Safe if retried after removing the constraint.
        assert inspect(conn).get_foreign_keys("daemon_report_receipts") == []
        conn.execute(text("DELETE FROM daemon_commands"))
        assert conn.scalar(text("SELECT count(*) FROM daemon_report_receipts")) == 1
        migration.downgrade()
        assert conn.scalar(text("SELECT count(*) FROM daemon_report_receipts")) == 0
        constraints = inspect(conn).get_foreign_keys("daemon_report_receipts")
        assert constraints[0]["options"]["ondelete"] == "CASCADE"
        conn.execute(text("INSERT INTO daemon_commands VALUES ('new-command')"))
        conn.execute(text("INSERT INTO daemon_report_receipts VALUES ('new-command', 'new-report', 'node', 'digest')"))
        conn.execute(text("DELETE FROM daemon_commands"))
        assert conn.scalar(text("SELECT count(*) FROM daemon_report_receipts")) == 0
    engine.dispose()
