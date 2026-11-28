"""Standalone scope upgrades preserve old definitions and refuse lossy rollback."""
import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError


MIGRATION = Path(__file__).parents[2] / 'migrations/versions/20261128_0135_standalone_workflows.py'


def test_standalone_scope_migration_is_additive_and_repeatable():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == '20261125_0134'
    engine = create_engine('sqlite:///:memory:')
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE workflows (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, '
                          'project_id TEXT, owner_team_id TEXT, snapshot TEXT NOT NULL, '
                          'CONSTRAINT ck_workflow_owner_scope CHECK '
                          '((project_id IS NOT NULL AND owner_team_id IS NULL) OR '
                          '(project_id IS NULL AND owner_team_id IS NOT NULL)))'))
        conn.execute(text("INSERT INTO workflows VALUES ('old', 'owner', 'project', NULL, 'frozen')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()
            assert conn.execute(text('SELECT snapshot, computer_id FROM workflows WHERE id=\'old\'')).one() == ('frozen', None)
            conn.execute(text("INSERT INTO workflows VALUES ('new', 'owner', NULL, NULL, 'standalone', 'computer')"))
            with pytest.raises(RuntimeError, match='forward fix'):
                module.downgrade()
            with conn.begin_nested(), pytest.raises(IntegrityError):
                conn.execute(text("INSERT INTO workflows VALUES ('invalid', 'owner', 'project', NULL, 'invalid', 'computer')"))
            conn.execute(text("DELETE FROM workflows WHERE id='new'"))
            module.downgrade()
            assert 'computer_id' not in {column['name'] for column in inspect(conn).get_columns('workflows')}
            assert conn.scalar(text("SELECT snapshot FROM workflows WHERE id='old'")) == 'frozen'
