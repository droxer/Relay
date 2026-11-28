"""Workflow queue membership is indexed without changing Task events."""
import importlib.util
from pathlib import Path
from uuid import uuid4

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select, text

from store_fixtures import make_task_store


def test_workflow_dispatch_index_round_trip(tmp_path):
    store = make_task_store(tmp_path)
    task = store.create_task({'title': 'Workflow Ready', 'status': 'assigned', 'assignedWorkflowId': str(uuid4()),
                              'computerId': 'device:local'})
    path = Path(__file__).parents[2] / 'migrations/versions/20261128_0136_standalone_workflow_dispatch.py'
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == '20261128_0135'
    with store.engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            before = conn.execute(select(store.events)).all()
            module.downgrade()
            old = conn.scalar(text("SELECT sql FROM sqlite_master WHERE name='ix_tasks_dispatch_order'"))
            assert 'assignedWorkflowId' not in old
            module.upgrade()
            module.upgrade()
            current = conn.scalar(text("SELECT sql FROM sqlite_master WHERE name='ix_tasks_dispatch_order'"))
            assert 'assignedWorkflowId' in current
            assert conn.execute(select(store.events)).all() == before
    assert [value['id'] for value in store.list_dispatchable_tasks()] == [task['id']]
