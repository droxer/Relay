"""Regression guarantees for the backend scalability review."""

import asyncio
import base64
import threading
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from relay.persistence.session_store import DatabaseSessionStore
from relay.persistence.store_common import relay_event


@pytest.mark.parametrize(
    "endpoint",
    [
        "start_task",
        "pickup_task",
        "task_files",
        "task_workspace_files",
        "task_workspace_file",
    ],
)
def test_task_dispatch_auth_does_not_run_on_event_loop(endpoint, monkeypatch):
    from relay.api import task_routes
    from fastapi import HTTPException
    from starlette.requests import Request

    async def run():
        loop_thread = threading.get_ident()

        def auth(*args):
            assert threading.get_ident() != loop_thread
            raise HTTPException(401)

        monkeypatch.setattr(task_routes, "request_actor", auth)
        request = Request({"type": "http", "method": "POST", "headers": []})
        with pytest.raises(HTTPException):
            await getattr(task_routes, endpoint)(
                "test", request, SimpleNamespace(auth_store=None)
            )

    asyncio.run(run())


def test_stream_writes_exclude_old_logs_but_details_preserve_them(tmp_path):
    store = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/sessions.db", create_schema=True
    )
    session = store.create_session({"taskGoal": "history", "workspacePath": "/work"})
    sid = session["id"]
    log = "x" * 262144
    store.append_event(
        sid, relay_event("agent.started", sid, {"runId": "r", "agent": "codex"})
    )
    store.append_event(
        sid,
        relay_event(
            "agent.completed",
            sid,
            {
                "runId": "r",
                "agent": "codex",
                "status": "completed",
                "exitCode": 0,
                "agentLog": log,
            },
        ),
    )
    writes = []

    def capture(conn, cursor, statement, parameters, context, many):
        if statement.startswith("UPDATE sessions SET"):
            writes.append(sum(len(p) for p in parameters if isinstance(p, str)))

    event.listen(store.engine, "before_cursor_execute", capture)
    store.append_event(
        sid,
        relay_event(
            "agent.output", sid, {"runId": "r2", "agent": "codex", "text": "y"}
        ),
        hydrate_events=False,
    )
    assert writes and max(writes) < 10000
    assert store.get_session(sid)["agentRuns"][0]["agentLog"] == log
    assert store.list_sessions()[0]["agentRuns"][0]["agentLog"] == log


def test_reconnect_cursor_has_index(tmp_path):
    store = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/sessions.db", create_schema=True
    )
    session = store.create_session({"taskGoal": "cursor", "workspacePath": "/work"})
    first = session["events"][0]
    statements = []
    event.listen(
        store.engine,
        "before_cursor_execute",
        lambda c, cur, s, p, ctx, many: statements.append((s, p)),
    )
    assert (
        store.read_event_page(session["id"], after_event_id=first["id"])["events"] == []
    )
    cursor_sql, params = next(
        (s, p)
        for s, p in statements
        if "SELECT session_events.sequence" in s and "payload" in s
    )
    with store.engine.connect() as conn:
        plan = conn.exec_driver_sql("EXPLAIN QUERY PLAN " + cursor_sql, params).all()
    assert "ix_session_events_cursor" in str(plan)


def test_managed_state_and_images_are_shared_between_replicas(tmp_path):
    from relay.persistence.managed_node_store import DatabaseManagedNodeStore
    from relay.persistence.profile_image_store import DatabaseProfileImageStore

    url = f"sqlite:///{tmp_path}/shared.db"
    a = DatabaseManagedNodeStore(url, create_schema=True)
    b = DatabaseManagedNodeStore(url, create_schema=True)
    node = a.create_node({"employeeId": "alice"})
    assert b.get_node(node["id"]) == node
    attempt, credential = a.create_attempt(node["id"])
    assert b.consume_enrollment_grant(credential) == (b.get_node(node["id"]), attempt)
    b.complete_enrollment_grant(credential, "runtime")
    with pytest.raises(PermissionError):
        a.complete_enrollment_grant(credential, "other-runtime")
    with pytest.raises(ValueError):
        b.create_attempt(node["id"])
    images_a = DatabaseProfileImageStore(url, create_schema=True)
    images_b = DatabaseProfileImageStore(url, create_schema=True)
    content = b"\x89PNG\r\n\x1a\nimage"
    images_a.save(
        "agents", "agent", "data:image/png;base64," + base64.b64encode(content).decode()
    )
    assert images_b.read("agents", "agent")[0] == content
    images_b.delete("agents", "agent")
    assert images_a.read("agents", "agent") is None


def test_recovery_queries_are_bounded_in_sql(tmp_path):
    from relay.persistence.daemon_store import DatabaseDaemonStore

    store = DatabaseDaemonStore(f"sqlite:///{tmp_path}/daemon.db", create_schema=True)
    statements = []
    event.listen(
        store.engine,
        "before_cursor_execute",
        lambda c, cur, s, p, ctx, many: statements.append(s),
    )
    assert store.list_active_run_requests(limit=7, after_id=None) == []
    assert store.list_active_runs(limit=7, after_id=None) == []
    assert all("LIMIT" in s for s in statements if s.startswith("SELECT"))


def test_managed_attempt_creation_is_atomic_across_instances(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from relay.persistence.managed_node_store import DatabaseManagedNodeStore

    url = f"sqlite:///{tmp_path}/concurrent.db"
    stores = [DatabaseManagedNodeStore(url, create_schema=True) for _ in range(2)]
    node = stores[0].create_node({"employeeId": "alice"})
    barrier = threading.Barrier(2)

    def create(store):
        barrier.wait()
        try:
            return store.create_attempt(node["id"])[0]
        except ValueError:
            return None

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(create, stores))
    assert sum(result is not None for result in results) == 1
    assert len(stores[0].list_attempts(node["id"])) == 1


def test_local_operational_import_is_dry_runnable_and_idempotent(tmp_path):
    from relay.persistence.managed_node_store import DatabaseManagedNodeStore
    from relay.persistence.profile_image_store import (
        LocalProfileImageStore,
        DatabaseProfileImageStore,
    )
    from relay.persistence.operational_import import (
        migrate_local_operational_state,
        require_operational_import,
    )
    from relay.services.managed_nodes import LocalManagedNodeStore

    root = tmp_path / "legacy"
    local = LocalManagedNodeStore(root)
    node = local.create_node({"employeeId": "alice"})
    attempt, credential = local.create_attempt(node["id"])
    image = b"\x89PNG\r\n\x1a\nimage"
    LocalProfileImageStore(root).save(
        "agents", "agent", "data:image/png;base64," + base64.b64encode(image).decode()
    )
    url = f"sqlite:///{tmp_path}/destination.db"
    shared = DatabaseManagedNodeStore(url, create_schema=True)
    with pytest.raises(RuntimeError, match="imported"):
        require_operational_import(root, shared)
    assert migrate_local_operational_state(root, url, dry_run=True)["nodes"] == 1
    assert shared.list_nodes() == []
    assert migrate_local_operational_state(root, url)["grants"] == 1
    assert shared.consume_enrollment_grant(credential)[1] == attempt
    assert DatabaseProfileImageStore(url).read("agents", "agent")[0] == image
    shared.update_node(node["id"], {"displayName": "changed"})
    assert migrate_local_operational_state(root, url)["alreadyImported"]
    assert shared.get_node(node["id"])["displayName"] == "changed"
    assert local.get_node(node["id"])["displayName"] != "changed"
    require_operational_import(root, shared)


def test_recovery_does_not_acquire_fleet_dispatch_lock():
    from relay.daemon_registry.registry import DaemonNodeRegistry

    registry = DaemonNodeRegistry.__new__(DaemonNodeRegistry)
    registry._recovery_lock = threading.Lock()

    class ForbiddenLock:
        def __enter__(self):
            raise AssertionError("recovery acquired fleet dispatch lock")

        def __exit__(self, *args):
            pass

    registry.dispatch_lock = ForbiddenLock()
    calls = []
    registry._reap_stale_runs_unlocked = lambda **kwargs: calls.append(True)
    registry.reap_stale_runs()
    assert calls == [True]


def test_retention_limits_deletes_and_does_not_load_command_payloads(tmp_path):
    from relay.persistence.daemon_store import DatabaseDaemonStore, command_to_row
    from relay.core.ids import new_database_id
    from sqlalchemy import insert

    store = DatabaseDaemonStore(
        f"sqlite:///{tmp_path}/retention.db", create_schema=True
    )
    node_id = new_database_id()
    now = "2020-01-01T00:00:00.000Z"
    store.register_node(
        {
            "id": node_id,
            "workspacePath": "/work",
            "sandboxMode": "none",
            "status": "ready",
            "agents": {},
            "createdAt": now,
            "updatedAt": now,
        }
    )
    with store.engine.begin() as conn:
        rows = []
        for _ in range(1010):
            command_id = new_database_id()
            rows.append(
                command_to_row(
                    {
                        "id": command_id,
                        "nodeId": node_id,
                        "status": "completed",
                        "createdAt": now,
                        "updatedAt": now,
                        "completedAt": now,
                        "command": {
                            "id": command_id,
                            "type": "workspace.list",
                            "large": "x" * 1000,
                        },
                    },
                    node_pk=node_id,
                )
            )
        conn.execute(insert(store.commands), rows)
    statements = []
    event.listen(
        store.engine,
        "before_cursor_execute",
        lambda c, cur, s, p, ctx, many: statements.append(s),
    )
    assert store.prune_terminal_records(0, 0)["commands"] == 1000
    assert all(
        "daemon_commands.command" not in s for s in statements if s.startswith("SELECT")
    )
    assert store.prune_terminal_records(0, 0)["commands"] == 10


def test_import_conflict_rolls_back_prior_records(tmp_path):
    from relay.persistence.managed_node_store import DatabaseManagedNodeStore
    from relay.persistence.operational_import import migrate_local_operational_state
    from relay.persistence.profile_image_store import (
        DatabaseProfileImageStore,
        LocalProfileImageStore,
    )
    from relay.services.managed_nodes import LocalManagedNodeStore

    root = tmp_path / "legacy"
    source = LocalManagedNodeStore(root)
    node = source.create_node({"employeeId": "alice"})
    url = f"sqlite:///{tmp_path}/conflict.db"
    shared = DatabaseManagedNodeStore(url, create_schema=True)
    a = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nfirst").decode()
    b = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nsecond").decode()
    LocalProfileImageStore(root).save("agents", "agent", a)
    DatabaseProfileImageStore(url).save("agents", "agent", b)
    with pytest.raises(ValueError, match="Conflicting profile image"):
        migrate_local_operational_state(root, url)
    assert shared.get_node(node["id"]) is None
    assert source.get_node(node["id"]) == node


@pytest.mark.parametrize(
    "data_url", ["", "data:image/png;base64,bm90LWEtcG5n", "data:text/html;base64,eA=="]
)
def test_database_images_preserve_validation(data_url, tmp_path):
    from relay.persistence.profile_image_store import (
        DatabaseProfileImageStore,
        ProfileImageError,
    )

    store = DatabaseProfileImageStore(
        f"sqlite:///{tmp_path}/images.db", create_schema=True
    )
    with pytest.raises(ProfileImageError):
        store.save("agents", "agent", data_url)
    assert store.read("agents", "agent") is None


def test_managed_attempt_failure_rolls_back_across_records(tmp_path, monkeypatch):
    from relay.persistence.managed_node_store import DatabaseManagedNodeStore

    store = DatabaseManagedNodeStore(
        f"sqlite:///{tmp_path}/rollback.db", create_schema=True
    )
    node = store.create_node({"employeeId": "alice"})
    original = store._write_record

    def fail_grant(kind, record):
        if kind == "grants":
            raise RuntimeError("storage unavailable")
        original(kind, record)

    monkeypatch.setattr(store, "_write_record", fail_grant)
    with pytest.raises(RuntimeError, match="storage unavailable"):
        store.create_attempt(node["id"])
    assert store.list_attempts(node["id"]) == []
    assert store.get_node(node["id"]) == node


def test_dispatch_service_keeps_database_phases_off_loop_and_transport_on_loop():
    from relay.services.task_dispatch import TaskDispatcher

    async def run():
        loop_thread = threading.get_ident()

        async def remote(node_id, request):
            assert threading.get_ident() == loop_thread
            assert node_id == "node"
            return {"id": "session"}

        class Dispatcher(TaskDispatcher):
            def _prepare_dispatch(self):
                assert threading.get_ident() != loop_thread
                self._prepared_node = {"id": "node"}

            def _run_request(self, node):
                assert threading.get_ident() != loop_thread
                return {}

            def _finish_dispatch(self, node, session, error):
                assert threading.get_ident() != loop_thread
                assert error is None
                return session

        dispatcher = Dispatcher(
            SimpleNamespace(backend=SimpleNamespace(run=remote)),
            {},
            {},
            assignments=[],
            record_pending=True,
        )
        assert await dispatcher.start() == {"id": "session"}

    asyncio.run(run())
