"""The import migration can resume after its column has been committed."""

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


@pytest.mark.parametrize("column_exists", [True, False])
def test_upgrade_resumes_after_column_was_committed(column_exists):
    path = Path(__file__).parents[2] / "migrations/versions/20261103_0107_task_external_ref.py"
    spec = importlib.util.spec_from_file_location("task_external_ref_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with create_engine("sqlite:///:memory:").begin() as connection:
        columns = "id TEXT PRIMARY KEY, external_ref TEXT" if column_exists else "id TEXT PRIMARY KEY"
        connection.execute(text(f"CREATE TABLE tasks ({columns})"))
        if column_exists:
            connection.execute(text("INSERT INTO tasks VALUES ('existing', 'github:octo/hello#1')"))
        module.op = Operations(MigrationContext.configure(connection))
        module.upgrade()
        module.upgrade()
        assert "ix_tasks_external_ref" in {index["name"] for index in inspect(connection).get_indexes("tasks")}
        if column_exists:
            assert connection.scalar(text("SELECT external_ref FROM tasks")) == "github:octo/hello#1"
        module.downgrade()
        assert "external_ref" not in {column["name"] for column in inspect(connection).get_columns("tasks")}
