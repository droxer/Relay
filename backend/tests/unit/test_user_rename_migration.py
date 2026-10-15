"""Migration 20261015_0094 renames employee data to user data on Postgres.

Seeds rows the way the pre-rename runtime wrote them, migrates one revision,
and reads them back under the new names. Skips without a reachable Postgres,
like the schema-drift suite, because the migration chain is Postgres-only.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import SQLAlchemyError

BACKEND_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_URL = "postgresql+psycopg://relay:relay@localhost:5432/relay"
BEFORE = "20261013_0093"
SCHEMA = "20261015_0094"
AFTER = "20261015_0095"

USER_ID = str(uuid.uuid4())
ACCOUNT_ID = str(uuid.uuid4())
NODE_ID = str(uuid.uuid4())
TASK_ID = str(uuid.uuid4())

pytestmark = pytest.mark.postgres


def _reachable(url: str) -> bool:
    try:
        engine = create_engine(url)
        with engine.connect() as connection:
            connection.execute(text("select 1"))
        engine.dispose()
    except SQLAlchemyError:
        return False
    return True


@pytest.fixture
def schema_at_before(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[str, Config]]:
    base_url = os.environ.get("RELAY_TEST_DATABASE_URL") or DEFAULT_URL
    if not _reachable(base_url):
        pytest.skip(f"no Postgres reachable at {base_url}")
    schema = f"rename_{uuid.uuid4().hex[:12]}"
    admin = create_engine(base_url)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped_url = f"{base_url}?options=-csearch_path%3D{schema}"
    monkeypatch.setenv("RELAY_DATABASE_URL", scoped_url)
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "migrations"))
    try:
        command.upgrade(config, BEFORE)
        yield scoped_url, config
    finally:
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin.dispose()


def _seed_pre_rename_rows(connection: Connection) -> None:
    connection.execute(
        text(
            "INSERT INTO employees (id, handle, display_name, created_at, updated_at) "
            "VALUES (:id, 'alice', 'Alice', now(), now())"
        ),
        {"id": USER_ID},
    )
    connection.execute(
        text(
            "INSERT INTO auth_users (id, username, role, employee_id, password_hash, "
            "created_at, updated_at) VALUES (:id, 'alice', 'user', :employee, 'h', now(), now())"
        ),
        {"id": ACCOUNT_ID, "employee": USER_ID},
    )
    connection.execute(
        text(
            "INSERT INTO auth_sessions (id, token_hash, user_id, created_at, expires_at) "
            "VALUES (:id, 'tok', :account, now(), now() + interval '1 day')"
        ),
        {"id": str(uuid.uuid4()), "account": ACCOUNT_ID},
    )
    connection.execute(
        text(
            "INSERT INTO daemon_nodes (id, employee_id, node_location, status, credential_version, "
            "created_at, updated_at) VALUES (:id, :employee, 'employee-device', 'ready', 1, now(), now())"
        ),
        {"id": NODE_ID, "employee": USER_ID},
    )
    snapshot = {"title": "Ship it", "ownerEmployeeId": USER_ID, "note": "ask an employee"}
    connection.execute(
        text(
            "INSERT INTO tasks (id, title, description, priority, status, owner_employee_id, "
            "is_routine, routine_enabled, routine_listens, routine_has_schedule, "
            "dispatch_failure_count, snapshot, version, created_at, updated_at) VALUES (:id, "
            "'Ship it', '', 'medium', 'todo', :employee, false, false, false, false, 0, "
            "CAST(:snapshot AS jsonb), 1, now(), now())"
        ),
        {"id": TASK_ID, "employee": USER_ID, "snapshot": json.dumps(snapshot)},
    )
    connection.execute(
        text(
            "INSERT INTO task_events (id, task_id, sequence, type, timestamp, payload) "
            "VALUES (:id, :task, 1, 'task.created', now(), CAST(:payload AS jsonb))"
        ),
        {
            "id": str(uuid.uuid4()),
            "task": TASK_ID,
            "payload": json.dumps(
                {"type": "task.created", "ownerEmployeeId": USER_ID, "assigneeEmployeeId": USER_ID}
            ),
        },
    )


def test_employee_rows_read_back_as_user_rows(schema_at_before: tuple[str, Config]) -> None:
    url, config = schema_at_before
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            _seed_pre_rename_rows(connection)

        command.upgrade(config, AFTER)

        with engine.connect() as connection:
            assert connection.execute(text("SELECT handle FROM users")).scalar_one() == "alice"
            assert (
                connection.execute(text("SELECT CAST(user_id AS text) FROM auth_accounts")).scalar_one()
                == USER_ID
            )
            assert (
                connection.execute(text("SELECT CAST(account_id AS text) FROM auth_sessions")).scalar_one()
                == ACCOUNT_ID
            )
            node = connection.execute(
                text("SELECT CAST(user_id AS text) AS user_id, node_location FROM daemon_nodes")
            ).one()
            assert (node.user_id, node.node_location) == (USER_ID, "user-device")
            snapshot = connection.execute(text("SELECT snapshot FROM tasks")).scalar_one()
            assert snapshot == {"title": "Ship it", "ownerUserId": USER_ID, "note": "ask an employee"}
            payload = connection.execute(text("SELECT payload FROM task_events")).scalar_one()
            assert payload == {"type": "task.created", "ownerUserId": USER_ID, "assigneeUserId": USER_ID}
    finally:
        engine.dispose()


def test_downgrade_restores_the_employee_schema(schema_at_before: tuple[str, Config]) -> None:
    url, config = schema_at_before
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            _seed_pre_rename_rows(connection)

        command.upgrade(config, AFTER)
        command.downgrade(config, BEFORE)

        with engine.connect() as connection:
            node = connection.execute(
                text("SELECT CAST(employee_id AS text) AS employee_id, node_location FROM daemon_nodes")
            ).one()
            assert (node.employee_id, node.node_location) == (USER_ID, "employee-device")
            assert connection.execute(text("SELECT count(*) FROM auth_users")).scalar_one() == 1
            snapshot = connection.execute(text("SELECT snapshot FROM tasks")).scalar_one()
            assert snapshot == {"title": "Ship it", "ownerEmployeeId": USER_ID, "note": "ask an employee"}
            payload = connection.execute(text("SELECT payload FROM task_events")).scalar_one()
            assert payload == {
                "type": "task.created",
                "ownerEmployeeId": USER_ID,
                "assigneeEmployeeId": USER_ID,
            }
    finally:
        engine.dispose()


def test_no_generated_name_still_says_employee(schema_at_before: tuple[str, Config]) -> None:
    url, config = schema_at_before
    command.upgrade(config, AFTER)
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            names = connection.execute(
                text(
                    "SELECT c.relname FROM pg_class c JOIN pg_namespace n "
                    "ON n.oid = c.relnamespace WHERE n.nspname = current_schema() "
                    "UNION ALL SELECT con.conname FROM pg_constraint con "
                    "JOIN pg_namespace n ON n.oid = con.connamespace "
                    "WHERE n.nspname = current_schema()"
                )
            ).scalars().all()
    finally:
        engine.dispose()

    assert [name for name in names if "employee" in name or "auth_users" in name] == []


def test_an_interrupted_json_rewrite_resumes(schema_at_before: tuple[str, Config]) -> None:
    url, config = schema_at_before
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            _seed_pre_rename_rows(connection)
        command.upgrade(config, SCHEMA)
        # A run that died after rewriting one row leaves the rest for the retry.
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE tasks SET snapshot = jsonb_build_object("
                    "'title', 'Ship it', 'ownerUserId', CAST(:user AS text), "
                    "'note', 'ask an employee')"
                ),
                {"user": USER_ID},
            )

        command.upgrade(config, AFTER)

        with engine.connect() as connection:
            payload = connection.execute(text("SELECT payload FROM task_events")).scalar_one()
            assert payload["ownerUserId"] == USER_ID
            snapshot = connection.execute(text("SELECT snapshot FROM tasks")).scalar_one()
            assert snapshot == {"title": "Ship it", "ownerUserId": USER_ID, "note": "ask an employee"}
    finally:
        engine.dispose()
