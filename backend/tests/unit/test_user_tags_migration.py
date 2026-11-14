"""Migration 0127 adds the saved-tag catalog and drops only that on downgrade."""

from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def _migration():
    path = Path(__file__).parents[2] / "migrations/versions/20261114_0127_user_tags.py"
    spec = importlib.util.spec_from_file_location("user_tags_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_is_resumable_and_downgrade_keeps_work_tags() -> None:
    module = _migration()
    assert (module.revision, module.down_revision) == ("20261114_0127", "20261113_0126")
    with create_engine("sqlite:///:memory:").begin() as connection:
        connection.execute(text("PRAGMA foreign_keys = ON"))
        connection.execute(text("CREATE TABLE users (id TEXT PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE tasks (id TEXT PRIMARY KEY, snapshot TEXT)"))
        connection.execute(text("INSERT INTO users VALUES ('u1')"))
        connection.execute(text("""INSERT INTO tasks VALUES ('t1', '{"tags": ["Bug"]}')"""))
        module.op = Operations(MigrationContext.configure(connection))

        module.upgrade()
        module.upgrade()
        columns = {column["name"] for column in inspect(connection).get_columns("user_tags")}
        assert columns == {"user_id", "name_key", "name", "created_at"}
        assert inspect(connection).get_pk_constraint("user_tags")["constrained_columns"] == [
            "user_id", "name_key",
        ]
        connection.execute(text(
            "INSERT INTO user_tags VALUES ('u1', 'roadmap', 'Roadmap', '2026-11-14T00:00:00Z')"
        ))
        connection.execute(text("DELETE FROM users WHERE id = 'u1'"))
        assert connection.scalar(text("SELECT count(*) FROM user_tags")) == 0

        module.downgrade()
        module.downgrade()
        assert not inspect(connection).has_table("user_tags")
        assert connection.scalar(text("SELECT snapshot FROM tasks")) == '{"tags": ["Bug"]}'
