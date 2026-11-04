"""Only historical WIP refusal blocks become queued again."""

import pytest
from store_fixtures import make_task_store


@pytest.mark.parametrize("changed", [{}, {"startedAt": "2026-01-01T00:00:00Z"}, {"manual": True}])
def test_repair_only_unadmitted_capacity_blocks(tmp_path, changed):
    from relay.migrations_runtime.task_capacity import requeue_capacity_waits
    from relay.persistence.events import relay_task_event

    store = make_task_store(tmp_path)
    task = store.create_task({"title": "Capacity wait", "status": "assigned"})
    if changed.get("startedAt"):
        store.append_event(task["id"], relay_task_event("task.status", task["id"], {"status": "running"}))
    store.update_task(
        task["id"],
        {
            "status": "blocked",
            "blockerReason": "Capacity full",
            "attention": {"code": "manual_block" if changed.get("manual") else "task_wip_limit", "source": "dispatch"},
        },
    )
    store.record_dispatch_outcome(task["id"], "rejected", code="task_wip_limit")
    requeue_capacity_waits(task_store=store)
    repaired = store.get_task(task["id"])
    assert repaired["status"] == ("blocked" if changed else "queued")
    version = len(repaired["events"])
    requeue_capacity_waits(task_store=store)
    assert len(store.get_task(task["id"])["events"]) == version


def test_queued_index_migration_keeps_history_and_round_trips(tmp_path):
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import text, select

    store = make_task_store(tmp_path)
    task = store.create_task({"title": "Waiting", "status": "queued"})
    path = Path(__file__).parents[2] / "migrations/versions/20261104_0111_task_queued_index.py"
    spec = importlib.util.spec_from_file_location("task_queue_index", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with store.engine.begin() as conn:
        module.op = Operations(MigrationContext.configure(conn))
        before = conn.execute(select(store.events)).all()
        module.downgrade()
        sql = conn.scalar(text("SELECT sql FROM sqlite_master WHERE name='ix_tasks_dispatch_queue'"))
        assert "queued" not in sql
        module.upgrade()
        sql = conn.scalar(text("SELECT sql FROM sqlite_master WHERE name='ix_tasks_dispatch_queue'"))
        assert "queued" in sql
        assert conn.execute(select(store.events)).all() == before
    assert store.get_task(task["id"])["status"] == "queued"


def test_user_capacity_migration_round_trip(tmp_path):
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import text

    store = make_task_store(tmp_path)
    path = Path(__file__).parents[2] / "migrations/versions/20261104_0112_user_task_capacity.py"
    spec = importlib.util.spec_from_file_location("user_task_capacity", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with store.engine.begin() as conn:
        module.op = Operations(MigrationContext.configure(conn))
        module.downgrade()
        assert "max_concurrent_tasks" not in [r[1] for r in conn.execute(text("PRAGMA table_info(users)"))]
        module.upgrade()
        assert "max_concurrent_tasks" in [r[1] for r in conn.execute(text("PRAGMA table_info(users)"))]
