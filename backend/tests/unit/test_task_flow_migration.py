import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select, update
from relay.persistence.task_store import DatabaseTaskStore


def test_flow_migration_replays_existing_tasks_without_changing_history(tmp_path):
    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/migration.db", create_schema=True)
    task = store.create_task(
        {"title": "Existing task", "acceptancePolicy": "automatic"}
    )
    store.update_task(task["id"], {"status": "running"})
    store.update_task(task["id"], {"status": "review"})
    blocked = store.update_task(
        task["id"], {"status": "blocked", "blockerReason": "Approval"}
    )
    path = (
        Path(__file__).parents[2]
        / "migrations/versions/20260913_0069_task_flow_projections.py"
    )
    spec = importlib.util.spec_from_file_location("task_flow_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with store.engine.begin() as conn:
        row = (
            conn.execute(select(store.tasks).where(store.tasks.c.id == task["id"]))
            .mappings()
            .one()
        )
        legacy = {
            key: value
            for key, value in row["snapshot"].items()
            if key not in module.FLOW_FIELDS
        }
        conn.execute(
            update(store.tasks)
            .where(store.tasks.c.id == task["id"])
            .values(snapshot=legacy)
        )
        before = conn.execute(select(store.events)).all()
        module.op = Operations(MigrationContext.configure(conn))
        module.upgrade()
        after = conn.execute(select(store.tasks.c.snapshot)).scalar_one()
        assert after["workflowStage"] == "review"
        assert after["acceptancePolicy"] == "automatic"
        assert after["startedAt"] == blocked["startedAt"]
        assert after["blockerReason"] == "Approval"
        assert conn.execute(select(store.events)).all() == before
        module.downgrade()
        assert conn.execute(select(store.tasks.c.snapshot)).scalar_one() == legacy
