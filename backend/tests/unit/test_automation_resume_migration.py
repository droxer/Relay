"""The resume cutoff is additive and reversible on an existing state table."""

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


MIGRATION = Path(__file__).parents[2] / "migrations/versions/20261104_0110_automation_resume_cutoff.py"


def test_resume_cutoff_migration_preserves_existing_state():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "20261103_0109"
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE automation_state (routine_id TEXT PRIMARY KEY, fired_count INTEGER NOT NULL)"))
        conn.execute(text("INSERT INTO automation_state VALUES ('routine', 4)"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            assert conn.execute(text("SELECT fired_count, events_after FROM automation_state")).one() == (4, None)
            conn.execute(text("UPDATE automation_state SET events_after = '2026-11-04 12:00:00'"))
            module.downgrade()
            assert "events_after" not in {column["name"] for column in inspect(conn).get_columns("automation_state")}
            assert conn.scalar(text("SELECT fired_count FROM automation_state")) == 4
