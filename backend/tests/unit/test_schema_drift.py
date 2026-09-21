"""The migrated schema and the declared schema must not drift apart.

Relay builds its schema two different ways: production runs Alembic against
Postgres, while SQLite tests call ``metadata.create_all``. When the two disagree,
tests exercise constraints that production does not have (or vice versa), so a
real uniqueness or concurrency bug can pass CI. That is not hypothetical — the
``(agent_id, sequence)`` uniqueness on ``agent_events`` existed in the migration
and not in the metadata.

This test migrates a scratch Postgres schema to head and diffs it against
``relay.persistence.schema.metadata``. It needs a live Postgres because the
migration chain is Postgres-only (pgcrypto, jsonb, ``USING`` casts), so it skips
when one is not reachable.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from relay.persistence.schema import metadata
from relay.persistence.session_store import DatabaseSessionStore
from relay.services.task_deletion import task_has_active_linked_session
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent
DEFAULT_URL = "postgresql+psycopg://relay:relay@localhost:5432/relay"

pytestmark = pytest.mark.postgres


def _database_url() -> str:
    return os.environ.get("RELAY_TEST_DATABASE_URL") or DEFAULT_URL


def _postgres_available(url: str) -> bool:
    try:
        engine = create_engine(url)
        with engine.connect() as connection:
            connection.execute(text("select 1"))
        engine.dispose()
    except SQLAlchemyError:
        return False
    return True


@pytest.fixture
def migrated_schema(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[str, str]]:
    """Migrate to head inside a throwaway schema, then drop it."""
    base_url = _database_url()
    if not _postgres_available(base_url):
        pytest.skip(f"no Postgres reachable at {base_url}")

    schema = f"drift_{uuid.uuid4().hex[:12]}"
    admin = create_engine(base_url)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))

    # Alembic emits unqualified DDL, so search_path decides where it lands.
    scoped_url = f"{base_url}?options=-csearch_path%3D{schema}"
    monkeypatch.setenv("RELAY_DATABASE_URL", scoped_url)
    try:
        # env.py reads RELAY_DATABASE_URL first; the url cannot go through
        # alembic.ini because configparser interpolates the '%' escapes.
        config = Config(str(REPO_ROOT / "backend" / "alembic.ini"))
        config.set_main_option("script_location", str(BACKEND_ROOT / "migrations"))
        command.upgrade(config, "head")
        yield scoped_url, schema
    finally:
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin.dispose()


def _significant(diff: Any) -> bool:
    """Drop diffs that reflect reflection limits rather than real drift."""
    kind = diff[0] if isinstance(diff, tuple) else None
    if kind in {"add_table", "remove_table"}:
        name = getattr(diff[1], "name", diff[1])
        return name != "alembic_version"
    # Server-side defaults are set by migrations for backfill purposes and
    # deliberately dropped from the declared metadata.
    return kind not in {"modify_default", "modify_comment"}


def test_migrated_schema_matches_declared_metadata(
    migrated_schema: tuple[str, str],
) -> None:
    url, schema = migrated_schema
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(
                connection,
                opts={
                    "target_metadata": metadata,
                    "compare_type": True,
                    "include_schemas": False,
                    "version_table_schema": schema,
                },
            )
            diffs = [
                diff for diff in compare_metadata(context, metadata) if _significant(diff)
            ]
    finally:
        engine.dispose()

    assert diffs == [], "schema drift:\n" + "\n".join(str(diff) for diff in diffs)


def test_dangling_legacy_session_id_is_treated_as_missing(
    migrated_schema: tuple[str, str],
) -> None:
    url, _schema = migrated_schema
    store = DatabaseSessionStore(url)

    with pytest.raises(KeyError, match="ses_legacy"):
        store.get_session("ses_legacy")

    assert not task_has_active_linked_session(
        store,
        {"linkedSessionIds": ["ses_legacy"]},
    )


def test_empty_project_migration_preserves_data_and_guards_downgrade(
    migrated_schema: tuple[str, str],
) -> None:
    from relay.persistence.agent_store import DatabaseAgentStore
    from relay.persistence.project_store import DatabaseProjectStore
    from relay.security.auth import DatabaseUserAuthStore

    url, _schema = migrated_schema
    owner = DatabaseUserAuthStore(url).create_user(
        "project-owner", "kestrel-vault-7719", employee_id="project-owner"
    )["employeeId"]
    store = DatabaseProjectStore(url)
    project = store.create_project(owner, {
        "name": "New project", "computerId": "device:review", "members": [],
    })
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "migrations"))
    with pytest.raises(RuntimeError, match="assign their lead agents first"):
        command.downgrade(config, "20260908_0066")
    command.upgrade(config, "head")
    assert store.get_project(project["id"]) == project

    agent = DatabaseAgentStore(url).create_agent(owner, {
        "displayName": "Lead", "executorKind": "codex", "defaultRole": "planner",
    })
    populated = store.update_project(project["id"], {
        "leadAgentId": agent["id"],
        "members": [{
            "agentId": agent["id"], "role": "planner",
            "responsibilities": "Plan",
        }],
    }, expected_version=1)
    command.downgrade(config, "20260908_0066")
    command.upgrade(config, "head")
    assert store.get_project(project["id"]) == populated


@pytest.mark.parametrize("scoped", [False, True])
def test_postgres_wip_admission_is_atomic_across_store_instances(migrated_schema, monkeypatch, scoped):
    from concurrent.futures import ThreadPoolExecutor

    from relay.persistence.store_common import relay_task_event
    from relay.persistence.task_store import DatabaseTaskStore
    from relay.security.auth import DatabaseUserAuthStore

    monkeypatch.setenv('RELAY_TASK_WIP_LIMIT', '1')
    url, _schema = migrated_schema
    owner = DatabaseUserAuthStore(url).create_user(
        'wip-owner', 'test-wip-password', employee_id='wip-owner',
    )['employeeId']
    store = DatabaseTaskStore(url)
    tasks = [store.create_task({'title': str(i), 'ownerEmployeeId': owner}) for i in range(4)]

    def attempt(task):
        try:
            from contextlib import nullcontext
            writer = DatabaseTaskStore(url)
            with writer.task_write_scope(task['id']) if scoped else nullcontext():
                writer.append_event(task['id'], relay_task_event(
                    'task.execution.claimed', task['id'], {'requestId': task['id'], 'expectedRevision': 0},
                ))
            return True
        except ValueError as error:
            assert 'task_wip_limit' in str(error)
            return False

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sum(pool.map(attempt, tasks)) == 1
    assert sum(bool(task.get('startedAt')) for task in store.list_tasks()) == 1


def test_postgres_task_admission_does_not_lock_other_employees(migrated_schema):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from relay.persistence.store_common import relay_task_event
    from relay.persistence.task_store import DatabaseTaskStore

    url, _ = migrated_schema
    store = DatabaseTaskStore(url)
    first = store.create_task({"title": "First", "ownerEmployeeId": str(uuid.uuid4())})
    second = store.create_task(
        {"title": "Second", "ownerEmployeeId": str(uuid.uuid4())}
    )
    acquired, release = Event(), Event()

    def hold_first():
        with store.task_write_scope(first["id"]):
            store.append_event(
                first["id"],
                relay_task_event("task.status", first["id"], {"status": "running"}),
            )
            acquired.set()
            assert release.wait(10)

    with ThreadPoolExecutor(max_workers=2) as pool:
        held = pool.submit(hold_first)
        try:
            assert acquired.wait(5)
            other = pool.submit(
                store.append_event,
                second["id"],
                relay_task_event("task.status", second["id"], {"status": "running"}),
            )
            assert other.result(timeout=3)["status"] == "running"
        finally:
            release.set()
        held.result()


def test_postgres_performance_projections_and_queue_pages(migrated_schema):
    from relay.persistence.session_store import DatabaseSessionStore
    from relay.persistence.store_common import relay_event
    from relay.persistence.task_store import DatabaseTaskStore

    url, _ = migrated_schema
    owner = str(uuid.uuid4())
    sessions = DatabaseSessionStore(url)
    session = sessions.create_session(
        {"taskGoal": "Projection", "workspacePath": "/work", "ownerEmployeeId": owner}
    )
    sessions.append_event(
        session["id"],
        relay_event("agent.started", session["id"], {"runId": "run", "agent": "codex"}),
    )
    for i in range(3):
        sessions.append_event(
            session["id"],
            relay_event(
                "artifact.created",
                session["id"],
                {
                    "artifact": {
                        "id": str(uuid.uuid4()),
                        "kind": "workspace_file",
                        "title": "file.txt",
                        "path": "/work/file.txt",
                        "createdAt": f"2026-09-17T00:00:0{i}.000Z",
                    }
                },
            ),
        )
    summary = sessions.list_session_summaries(owner_employee_id=owner)[0]
    assert summary["runCount"] == 1 and summary["hasRunningAgent"]
    assert summary["artifactCount"] == 1
    artifacts = sessions.list_artifact_summaries(
        owner_employee_id=owner, workspace_path="/work", limit=2
    )
    assert len(artifacts) == 1 and artifacts[0]["createdAt"].endswith("02.000Z")
    tasks = DatabaseTaskStore(url)
    for i in range(5):
        task = tasks.create_task({"title": str(i), "ownerEmployeeId": owner})
        tasks.assign_task(task["id"], "codex")
    first = tasks.list_dispatchable_tasks(limit=2)
    second = tasks.list_dispatchable_tasks(limit=2, after=first[-1])
    third = tasks.list_dispatchable_tasks(limit=2, after=second[-1])
    assert len({t["id"] for t in [*first, *second, *third]}) == 5
    assert len(tasks.list_tasks(employee_id=owner, limit=2)) == 2


def test_postgres_managed_nodes_lock_independently_and_enrollment_is_shared(migrated_schema):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from relay.persistence.managed_node_store import DatabaseManagedNodeStore
    url, _ = migrated_schema
    a, b = DatabaseManagedNodeStore(url), DatabaseManagedNodeStore(url)
    one = a.create_node({'employeeId': 'one'})
    two = a.create_node({'employeeId': 'two'})
    with ThreadPoolExecutor(2) as pool:
        with a._mutation_scope(one['id']):
            assert pool.submit(b.create_attempt, two['id']).result(timeout=3)[0]['managedNodeId'] == two['id']
        barrier = Barrier(2)
        def attempt(store):
            barrier.wait()
            try:
                return store.create_attempt(one['id'])
            except ValueError:
                return None
        results = list(pool.map(attempt, [a, b]))
    winners = [result for result in results if result]
    assert len(winners) == 1
    record, credential = winners[0]
    assert b.consume_enrollment_grant(credential)[1] == record
    b.complete_enrollment_grant(credential, 'runtime-one')
    with pytest.raises(PermissionError):
        a.complete_enrollment_grant(credential, 'runtime-two')


def test_postgres_recovery_claims_disjoint_pages_and_expired_claims_recover(migrated_schema):
    from concurrent.futures import ThreadPoolExecutor
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import insert, update
    from relay.persistence.daemon_store import DatabaseDaemonStore, node_to_row, run_request_to_row
    url, _ = migrated_schema
    a, b = DatabaseDaemonStore(url), DatabaseDaemonStore(url)
    node_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    node = {'id': node_id, 'status': 'ready', 'workspacePath': '/work', 'sandboxMode': 'none', 'createdAt': now, 'updatedAt': now}
    with a.engine.begin() as conn:
        conn.execute(insert(a.nodes).values(**node_to_row(node)))
        for _ in range(4):
            request = {'id': str(uuid.uuid4()), 'sessionId': str(uuid.uuid4()), 'taskGoal': 'test', 'assignments': [], 'status': 'running', 'createdAt': now, 'updatedAt': now}
            conn.execute(insert(a.run_requests).values(**run_request_to_row(request, node_pk=node_id)))
    with ThreadPoolExecutor(2) as pool:
        pages = list(pool.map(lambda store: store.claim_recovery_requests(limit=2), [a, b]))
    assert [len(page) for page in pages] == [2, 2]
    assert len({r['id'] for page in pages for r in page}) == 4
    assert a.claim_recovery_requests(limit=2) == []
    with a.engine.begin() as conn:
        conn.execute(update(a.run_requests).values(recovery_after=datetime.now(timezone.utc) - timedelta(seconds=1)))
    assert len(b.claim_recovery_requests(limit=2)) == 2


def test_postgres_stream_cursor_and_scalability_migration_roundtrip(migrated_schema):
    from sqlalchemy import inspect
    url, _ = migrated_schema
    store = DatabaseSessionStore(url)
    session = store.create_session({'taskGoal': 'cursor', 'workspacePath': '/work'})
    cursor = session['events'][0]['id']
    assert store.read_event_page(session['id'], after_event_id=cursor)['events'] == []
    config = Config(str(REPO_ROOT / 'backend' / 'alembic.ini'))
    config.set_main_option('script_location', str(BACKEND_ROOT / 'migrations'))
    command.downgrade(config, '20260917_0075')
    assert 'managed_node_records' not in inspect(store.engine).get_table_names()
    assert 'profile_images' not in inspect(store.engine).get_table_names()
    assert store.get_session(session['id'])['events'][0]['id'] == cursor
    command.upgrade(config, 'head')
    assert store.read_event_page(session['id'], after_event_id=cursor)['events'] == []
