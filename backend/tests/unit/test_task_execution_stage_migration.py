import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select, update

from relay.persistence.store_common import relay_task_event
from relay.persistence.task_store import DatabaseTaskStore


def test_execution_stage_migration_replays_claimed_tasks_without_changing_history(
    tmp_path,
):
    store = DatabaseTaskStore(
        f"sqlite:///{tmp_path}/execution-stage.db", create_schema=True
    )
    task = store.create_task({"title": "Queued", "status": "assigned"})
    task = store.append_event(
        task["id"],
        relay_task_event(
            "task.execution.claimed",
            task["id"],
            {"requestId": "request", "expectedRevision": 0},
        ),
    )
    path = (
        Path(__file__).parents[2]
        / "migrations/versions/20260916_0074_align_task_execution_stage.py"
    )
    spec = importlib.util.spec_from_file_location("task_execution_stage_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with store.engine.begin() as conn:
        snapshot = conn.execute(select(store.tasks.c.snapshot)).scalar_one()
        conn.execute(
            update(store.tasks).values(snapshot={**snapshot, "workflowStage": "running"})
        )
        before = conn.execute(select(store.events)).all()

        module.op = Operations(MigrationContext.configure(conn))
        module.upgrade()
        assert conn.execute(select(store.tasks.c.snapshot)).scalar_one()[
            "workflowStage"
        ] == "assigned"
        assert conn.execute(select(store.events)).all() == before

        module.downgrade()
        assert conn.execute(select(store.tasks.c.snapshot)).scalar_one()[
            "workflowStage"
        ] == "running"
        assert conn.execute(select(store.events)).all() == before
