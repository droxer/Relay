from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError


def migration(connection):
    path = Path(__file__).parents[2] / "migrations/versions/20260913_0068_reserve_active_task_runs.py"
    spec = importlib.util.spec_from_file_location("active_task_reservation_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = Operations(MigrationContext.configure(connection))
    return module


@pytest.mark.parametrize("status", ["prepared", "running", "dispatching", "finalizing"])
def test_task_reservation_migration_refuses_duplicates_without_mutation(status):
    with create_engine("sqlite:///:memory:").begin() as connection:
        connection.execute(text("CREATE TABLE daemon_run_requests (id TEXT PRIMARY KEY, task_id TEXT, status TEXT)"))
        connection.execute(text("INSERT INTO daemon_run_requests VALUES ('first', 'task', :status), ('second', 'task', 'prepared')"), {"status": status})
        before = connection.execute(text("SELECT * FROM daemon_run_requests ORDER BY id")).all()
        with pytest.raises(RuntimeError, match="Active task ownership conflicts"):
            migration(connection).upgrade()
        assert connection.execute(text("SELECT * FROM daemon_run_requests ORDER BY id")).all() == before
        assert inspect(connection).get_indexes("daemon_run_requests") == []


def test_task_reservation_migration_filters_active_scoped_work_and_downgrades():
    with create_engine("sqlite:///:memory:").begin() as connection:
        connection.execute(text("CREATE TABLE daemon_run_requests (id TEXT PRIMARY KEY, task_id TEXT, status TEXT)"))
        connection.execute(text("INSERT INTO daemon_run_requests VALUES ('old', 'task', 'completed'), ('owner', 'task', 'prepared'), ('ref1', NULL, 'running'), ('ref2', NULL, 'running')"))
        module = migration(connection)
        module.upgrade()
        for index, status in enumerate(("prepared", "running", "dispatching", "finalizing")):
            with pytest.raises(IntegrityError):
                connection.execute(text("INSERT INTO daemon_run_requests VALUES (:id, 'task', :status)"), {"id": str(index), "status": status})
        assert connection.execute(text("SELECT COUNT(*) FROM daemon_run_requests")).scalar_one() == 4
        module.downgrade()
        connection.execute(text("INSERT INTO daemon_run_requests VALUES ('replacement', 'task', 'running')"))
        assert connection.execute(text("SELECT COUNT(*) FROM daemon_run_requests")).scalar_one() == 5
