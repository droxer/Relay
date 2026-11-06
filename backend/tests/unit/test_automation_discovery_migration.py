"""Progress survives migration; rollback cannot replay partial broadcasts."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from relay.persistence.automation.store import DatabaseAutomationStore
from test_schema_drift import migrated_schema as _migrated_schema

migrated_schema = _migrated_schema
pytestmark = pytest.mark.postgres


def config():
    root = Path(__file__).resolve().parents[2]
    value = Config(str(root / "alembic.ini"))
    value.set_main_option("script_location", str(root / "migrations"))
    return value


def test_routing_upgrade_and_downgrade_preserve_outbox_and_fence_partial_work(migrated_schema):
    url, _ = migrated_schema
    engine = create_engine(url)
    try:
        command.downgrade(config(), "20261106_0117")
        with pytest.raises(RuntimeError, match="Automation discovery requires"):
            DatabaseAutomationStore(url).verify_schema()
        with engine.begin() as conn:
            conn.execute(
                text("""INSERT INTO automation_outbox
                (id, kind, event_type, payload, depth, created_at)
                VALUES (gen_random_uuid(), 'task_event', 'task.created', '{"extension":[1,2]}', 0, CURRENT_TIMESTAMP)
            """)
            )
        command.upgrade(config(), "head")
        DatabaseAutomationStore(url).verify_schema()
        with engine.begin() as conn:
            assert conn.scalar(text("SELECT payload FROM automation_outbox")) == {"extension": [1, 2]}
            conn.execute(
                text("""UPDATE automation_outbox SET routing_after_id = 'progress',
                routing_after_created_at = :now, routing_before = :now, routed_at = :now"""),
                {"now": datetime.now(UTC)},
            )
        with pytest.raises(RuntimeError, match="Finish partial"):
            command.downgrade(config(), "20261106_0117")
        with engine.begin() as conn:
            assert conn.scalar(text("SELECT version_num FROM alembic_version")) == "20261106_0119"
            assert conn.scalar(text("SELECT routing_after_id FROM automation_outbox")) == "progress"
            conn.execute(text("UPDATE automation_outbox SET routing_after_id = NULL"))
        command.downgrade(config(), "20261106_0117")
        assert "automation_scan_cursors" not in inspect(engine).get_table_names()
        with engine.begin() as conn:
            assert conn.scalar(text("SELECT payload FROM automation_outbox")) == {"extension": [1, 2]}
        command.upgrade(config(), "head")
        DatabaseAutomationStore(url).verify_schema()
    finally:
        engine.dispose()


def test_concurrent_index_upgrade_repairs_invalid_leftover(migrated_schema):
    from sqlalchemy.exc import IntegrityError
    from relay.persistence.task.store import DatabaseTaskStore

    url, _ = migrated_schema
    engine = create_engine(url)
    try:
        command.downgrade(config(), "20261106_0118")
        tasks = DatabaseTaskStore(url)
        tasks.create_task({"title": "first"})
        tasks.create_task({"title": "second"})
        # A failed concurrent UNIQUE build leaves a real invalid index. Use
        # the migration's name to reproduce the state a cancelled build leaves.
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            with pytest.raises(IntegrityError):
                conn.execute(text("CREATE UNIQUE INDEX CONCURRENTLY ix_tasks_automation_routing ON tasks (is_routine)"))
            assert conn.scalar(text("SELECT indisvalid FROM pg_index WHERE indexrelid = 'ix_tasks_automation_routing'::regclass")) is False
        command.upgrade(config(), "head")
        with engine.connect() as conn:
            assert conn.scalar(text("SELECT indisvalid FROM pg_index WHERE indexrelid = 'ix_tasks_automation_routing'::regclass")) is True
            assert conn.scalar(text("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'ix_tasks_automation_routing'"))
    finally:
        engine.dispose()
