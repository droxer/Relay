import importlib.util
import json
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text

MIGRATION = Path(__file__).parents[2] / "migrations/versions/20261013_0091_automation_v2.py"

ROWS = {
    "a": {
        "enabled": 1, "kind": "webhook", "next": None,
        "snapshot": {"isRoutine": True, "routineEnabled": True, "routineTrigger": {"kind": "webhook"}},
    },
    "b": {
        "enabled": 0, "kind": None, "next": None,
        "snapshot": {"isRoutine": True, "routineEnabled": False, "routineDisabledReason": "rate_limited"},
    },
    "c": {
        "enabled": 0, "kind": None, "next": "2026-10-14",
        "snapshot": {"isRoutine": True, "routineEnabled": False, "routineCadence": "weekly",
                     "routineNextRunDate": "2026-10-14"},
    },
}


def _load():
    spec = importlib.util.spec_from_file_location("automation_v2_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _seed(conn):
    conn.execute(text(
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, is_routine BOOLEAN NOT NULL, routine_enabled BOOLEAN NOT NULL,"
        " routine_trigger_kind TEXT, routine_next_run_date DATE, snapshot TEXT NOT NULL, created_at TEXT, deleted_at TEXT)"
    ))
    conn.execute(text("CREATE INDEX ix_tasks_due_routines ON tasks (routine_next_run_date)"))
    conn.execute(text("CREATE INDEX ix_tasks_triggered_routines ON tasks (created_at)"))
    conn.execute(text("CREATE TABLE automation_state (routine_id TEXT PRIMARY KEY)"))
    for key, row in ROWS.items():
        conn.execute(
            text("INSERT INTO tasks VALUES (:id, 1, :enabled, :kind, :next, :snapshot, '2026-10-01', NULL)"),
            {"id": key, "enabled": row["enabled"], "kind": row["kind"], "next": row["next"],
             "snapshot": json.dumps(row["snapshot"])},
        )
    conn.execute(text(
        "INSERT INTO tasks VALUES ('plain', 0, 0, NULL, NULL, '{}', '2026-10-01', NULL)"
    ))


def _read(conn):
    rows = conn.execute(text(
        "SELECT id, routine_state, routine_listens, routine_has_schedule, snapshot FROM tasks ORDER BY id"
    )).all()
    return {row[0]: (row[1], bool(row[2]), bool(row[3]), json.loads(row[4])) for row in rows}


def test_upgrade_backfills_columns_and_snapshots_then_downgrades():
    module = _load()
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        _seed(conn)
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            data = _read(conn)
            assert data["a"][:3] == ("active", True, False)
            assert data["b"][:3] == ("paused_by_relay", False, False)
            assert data["c"][:3] == ("paused", False, True)
            assert data["plain"][:3] == (None, False, False)
            assert data["a"][3]["routineTriggers"] == [{"kind": "webhook"}]
            assert data["a"][3]["routineState"] == "active"
            assert data["b"][3]["routinePauseReason"] == "rate_limited"
            assert data["c"][3]["routineTriggers"][0]["kind"] == "schedule"
            assert data["c"][3]["routineState"] == "paused"
            assert "routineTriggers" not in data["plain"][3]
            inspector = inspect(conn)
            assert "consecutive_failures" in {c["name"] for c in inspector.get_columns("automation_state")}
            names = {i["name"] for i in inspector.get_indexes("tasks")}
            assert {"ix_tasks_due_schedules", "ix_tasks_listening_routines",
                    "ix_tasks_unseeded_schedules", "ix_tasks_due_routines"} <= names

            module.backfill(conn)
            assert _read(conn) == data

            module.downgrade()
            inspector = inspect(conn)
            columns = {c["name"] for c in inspector.get_columns("tasks")}
            assert not columns & {"routine_next_run_at", "routine_state", "routine_listens", "routine_has_schedule"}
            assert "consecutive_failures" not in {c["name"] for c in inspector.get_columns("automation_state")}
