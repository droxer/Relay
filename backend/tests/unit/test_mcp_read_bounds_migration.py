"""Search projection backfill and query indexes preserve existing records."""
import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_mcp_read_bounds_upgrade_retry_and_downgrade():
    path = Path(__file__).parents[2] / 'migrations/versions/20261107_0121_mcp_read_bounds.py'
    spec = importlib.util.spec_from_file_location('mcp_read_bounds', path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine('sqlite:///:memory:')
    try:
        with engine.begin() as conn:
            conn.execute(text('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, project_id TEXT, owner_user_id TEXT, deleted_at DATETIME)'))
            conn.execute(text('INSERT INTO tasks (id, title) VALUES (:id, :title)'),
                         [{'id': f'{i:04}', 'title': 'Straße 中文'} for i in range(501)])
            for table, key in [('task_events', 'task_id'), ('session_events', 'session_id'), ('project_events', 'project_id')]:
                conn.execute(text(f'CREATE TABLE {table} ({key} TEXT, type TEXT, timestamp DATETIME, sequence INTEGER)'))
            with Operations.context(MigrationContext.configure(conn)):
                migration.upgrade()
                migration.upgrade()  # A cancelled concurrent index build may require a retry.
                assert conn.scalar(text("SELECT count(*) FROM tasks WHERE title_casefold = 'strasse 中文'")) == 501
                assert 'ix_tasks_project_live_id' in {index['name'] for index in inspect(conn).get_indexes('tasks')}
                migration.downgrade()
                assert 'title_casefold' not in {column['name'] for column in inspect(conn).get_columns('tasks')}
                assert conn.scalar(text('SELECT count(*) FROM tasks')) == 501
    finally:
        engine.dispose()
