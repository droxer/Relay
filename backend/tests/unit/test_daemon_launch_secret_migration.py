import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text


def test_launch_secret_migration_erases_plaintext_and_keeps_authentication_hashes():
    path = Path(__file__).parents[2] / 'migrations/versions/20261010_0089_clear_daemon_launch_secrets.py'
    spec = importlib.util.spec_from_file_location('launch_secret_migration', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_engine('sqlite:///:memory:')
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE daemon_nodes (node_token_secret TEXT, node_token_hash TEXT)'))
        conn.execute(text("INSERT INTO daemon_nodes VALUES ('old-secret', 'hash'), (NULL, 'cloud-hash')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.downgrade()
        assert conn.execute(text('SELECT node_token_secret, node_token_hash FROM daemon_nodes')).all() == [
            (None, 'hash'), (None, 'cloud-hash'),
        ]
