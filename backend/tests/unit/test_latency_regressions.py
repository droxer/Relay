"""Backend request-latency regressions: reads that must stay cheap per request."""

from __future__ import annotations

import sqlite3
from contextlib import nullcontext
from tempfile import TemporaryDirectory
from typing import Any

from fastapi.testclient import TestClient
from relay.api.web.ui import (
    _cached_web_ui_dist_dir,
    asset_etag,
    etag_in,
    web_ui_asset_response,
    web_ui_dist_dir,
)
from relay.bootstrap.http import SecurityHeadersMiddleware
from relay.daemon_registry import config
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.execution.lifecycle import ExecutionLifecycleService
from relay.persistence.engine import database_engine_options, shared_engine
from relay.persistence.tables import daemon as daemon_tables
from relay.persistence.tables import sessions as session_tables
from relay.persistence.tables import tasks as task_tables
from sqlalchemy import text
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route
from store_fixtures import make_daemon_store, make_session_store


# ── Fix 2: the fleet liveness throttle is checked before the lock ───────


class _CountingLock:
    def __init__(self) -> None:
        self.acquisitions = 0

    def __enter__(self) -> None:
        self.acquisitions += 1

    def __exit__(self, *_: Any) -> None:
        return None


def _registry(root: str) -> DaemonNodeRegistry:
    registry = DaemonNodeRegistry(make_session_store(root), make_daemon_store(root))
    registry.register(
        {
            "sandboxId": "sbx_a",
            "userId": "alice",
            "token": "node_token",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["thread-workspaces"],
            "status": "ready",
        },
        authorized_node_location="user-device",
    )
    return registry


def test_throttled_fleet_liveness_refresh_never_takes_the_dispatch_lock(monkeypatch) -> None:
    monkeypatch.setattr(config, "DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS", 3600)
    with TemporaryDirectory() as root:
        registry = _registry(root)
        registry._refresh_persisted_liveness()  # the first read, now throttled
        lock = _CountingLock()
        monkeypatch.setattr(registry, "dispatch_lock", lock)

        registry._refresh_persisted_liveness()
        registry.monitor_nodes()

        assert lock.acquisitions == 0

        # A due refresh still serializes with dispatch.
        registry._last_fleet_liveness_refresh_at = 0.0
        registry._refresh_persisted_liveness()
        assert lock.acquisitions == 1

        # A single node's refresh is never throttled, and always locked.
        registry._refresh_persisted_liveness("sbx_a")
        assert lock.acquisitions == 2


# ── Fix 5: execution annotation reads only the nodes it needs ───────────


class _NodeStore:
    def __init__(self) -> None:
        self.get_calls: list[str] = []
        self.list_calls = 0

    def list_active_run_requests(self, *, session_ids: set[str]) -> list[dict[str, Any]]:
        return [
            {"sessionId": "s1", "nodeId": "node_1", "currentCommandId": "cmd_1", "status": "running", "state": {}},
            {"sessionId": "s2", "nodeId": "node_1", "currentCommandId": "cmd_2", "status": "running", "state": {}},
        ]

    def list_active_runs(self, *, session_ids: set[str]) -> list[dict[str, Any]]:
        return []

    def get_commands(self, command_ids: set[str]) -> dict[str, dict[str, Any]]:
        return {cid: {"id": cid, "status": "dispatched", "nodeId": "node_1"} for cid in command_ids}

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        self.get_calls.append(node_id)
        return {"id": node_id, "status": "ready", "lastSeenAt": "2030-01-01T00:00:00Z"}

    def list_nodes(self) -> list[dict[str, Any]]:
        self.list_calls += 1
        raise AssertionError("annotate must not read the whole fleet")


class _Registry:
    def __init__(self, store: _NodeStore) -> None:
        self.daemon_store = store

    def _liveness(self, node: dict[str, Any]) -> dict[str, Any]:
        return {"online": True}


def test_annotate_fetches_referenced_nodes_by_id_once_each() -> None:
    store = _NodeStore()
    service = ExecutionLifecycleService(_Registry(store), chat_store=None)

    annotated = service.annotate([{"id": "s1", "status": "running"}, {"id": "s2", "status": "running"}])

    assert [item["execution"]["computerOnline"] for item in annotated] == [True, True]
    assert store.get_calls == ["node_1"]
    assert store.list_calls == 0


# ── Fix 6: the web UI revalidates with a strong ETag; SSE is never gzipped ──


def test_web_ui_assets_carry_a_strong_etag_and_answer_304(tmp_path) -> None:
    dist = tmp_path / "out"
    (dist / "_next" / "static").mkdir(parents=True)
    (dist / "index.html").write_text("<html>home</html>")
    (dist / "_next" / "static" / "app.js").write_text("app")
    _cached_web_ui_dist_dir.cache_clear()

    first = web_ui_asset_response("index.html", dist)
    assert first.status_code == 200
    etag = first.headers["etag"]
    assert etag.startswith('"') and not etag.startswith("W/")
    assert first.headers["cache-control"] == "no-cache"

    revalidated = web_ui_asset_response("index.html", dist, if_none_match=etag)
    assert revalidated.status_code == 304
    assert revalidated.headers["etag"] == etag
    assert revalidated.headers["cache-control"] == "no-cache"
    assert revalidated.body == b""

    hashed = web_ui_asset_response("_next/static/app.js", dist, if_none_match='"other"')
    assert hashed.status_code == 200
    assert hashed.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert "etag" in hashed.headers

    # A rebuilt file is a new validator and new bytes, not the cached copy.
    (dist / "index.html").write_text("<html>home, rebuilt and longer</html>")
    rebuilt = web_ui_asset_response("index.html", dist, if_none_match=etag)
    assert rebuilt.status_code == 200
    assert rebuilt.body == b"<html>home, rebuilt and longer</html>"
    assert rebuilt.headers["etag"] != etag


def test_web_ui_dist_dir_is_resolved_once_per_configuration(tmp_path, monkeypatch) -> None:
    dist = tmp_path / "out"
    dist.mkdir()
    _cached_web_ui_dist_dir.cache_clear()
    probes: list[str] = []
    real_is_dir = type(dist).is_dir

    def counting_is_dir(self: Any) -> bool:
        probes.append(str(self))
        return real_is_dir(self)

    monkeypatch.setattr(type(dist), "is_dir", counting_is_dir)
    assert web_ui_dist_dir(str(dist)) == dist.resolve()
    assert web_ui_dist_dir(str(dist)) == dist.resolve()
    assert probes == [str(dist)]


def test_etag_comparison_accepts_lists_and_the_weak_form_of_the_same_tag() -> None:
    etag = asset_etag(1234, 56)
    assert etag_in(f'"x", {etag}', etag)
    assert etag_in(f"W/{etag}", etag)
    assert etag_in("*", etag)
    assert not etag_in('"x"', etag)


def _streaming_app() -> Starlette:
    async def events(_request: Any) -> StreamingResponse:
        async def frames():
            for index in range(40):
                yield f"data: {'x' * 100}{index}\n\n"

        return StreamingResponse(frames(), media_type="text/event-stream")

    async def big_json(_request: Any) -> JSONResponse:
        return JSONResponse({"items": ["payload"] * 400})

    return Starlette(routes=[Route("/events", events), Route("/list", big_json)])


def test_sse_responses_are_never_gzipped_while_json_is() -> None:
    app = SecurityHeadersMiddleware(_streaming_app())
    client = TestClient(app)

    with client.stream("GET", "/events", headers={"Accept-Encoding": "gzip"}) as stream:
        assert stream.headers["content-type"].startswith("text/event-stream")
        assert "content-encoding" not in stream.headers
        first = next(stream.iter_text())
        assert first.startswith("data: ")

    listed = client.get("/list", headers={"Accept-Encoding": "gzip"})
    assert listed.headers["content-encoding"] == "gzip"
    assert listed.headers["x-content-type-options"] == "nosniff"
    assert listed.json()["items"][0] == "payload"


# ── Fix 7: the hot read paths have an index that leads with what they filter ──


def _index(table: Any, name: str) -> Any:
    return next(index for index in table.indexes if index.name == name)


def test_status_first_indexes_serve_fleet_wide_command_and_run_reads() -> None:
    commands = _index(daemon_tables.commands, "ix_daemon_commands_status_node")
    assert [column.name for column in commands.columns] == ["status", "node_id"]

    running = _index(daemon_tables.runs, "ix_daemon_runs_running")
    assert [column.name for column in running.columns] == ["node_id", "id"]
    assert str(running.dialect_options["postgresql"]["where"]) == "status = 'running'"
    assert str(running.dialect_options["sqlite"]["where"]) == "status = 'running'"


def test_task_recency_index_matches_the_list_order() -> None:
    index = _index(task_tables.tasks, "ix_tasks_live_recency")
    assert [str(expression) for expression in index.expressions] == ["updated_at DESC", "id DESC"]
    assert str(index.dialect_options["sqlite"]["where"]) == "deleted_at IS NULL"


def test_session_event_cursor_index_is_declared_and_builds_on_sqlite(tmp_path) -> None:
    index = _index(session_tables.events, "ix_session_events_cursor")
    assert [str(expression) for expression in index.expressions] == [
        "session_events.session_id",
        "(payload ->> 'id')",
    ]
    make_session_store(tmp_path)  # create_all with the expression index
    with sqlite3.connect(str(tmp_path / "relay.db")) as connection:
        names = {
            row[0]
            for row in connection.execute(
                "select name from sqlite_master where type = 'index'"
            )
        }
    assert {"ix_session_events_cursor", "ix_tasks_live_recency", "ix_daemon_runs_running"} <= names


# ── Fix 8: the pool is sized for the worker threadpool; SQLite runs in WAL ──


def test_postgres_pool_defaults_cover_workers_and_check_stale_connections(monkeypatch) -> None:
    for name in (
        "RELAY_DB_POOL_SIZE",
        "RELAY_DB_MAX_OVERFLOW",
        "RELAY_DB_POOL_PRE_PING",
        "RELAY_DB_POOL_RECYCLE_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)

    options = database_engine_options("postgresql+psycopg://relay:test@db/relay")

    assert options["pool_size"] + options["max_overflow"] >= 40
    assert options["pool_pre_ping"] is True
    assert options["pool_recycle"] == 300

    monkeypatch.setenv("RELAY_DB_POOL_PRE_PING", "false")
    assert database_engine_options("postgresql+psycopg://relay:test@db/relay")["pool_pre_ping"] is False


def test_sqlite_connections_use_wal_with_normal_sync(tmp_path) -> None:
    engine = shared_engine(f"sqlite:///{tmp_path / 'wal.db'}")
    with engine.connect() as connection:
        assert connection.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        assert connection.execute(text("PRAGMA synchronous")).scalar() == 1


def test_sqlite_pragma_test_setup_is_sound() -> None:
    # Guard against the pragma list silently emptying.
    from relay.persistence.engine import SQLITE_CONNECT_PRAGMAS

    assert any("journal_mode" in pragma for pragma in SQLITE_CONNECT_PRAGMAS)
    assert nullcontext is not None


# ── Fix 5b: historical managed-node identity scan is memoized ────────────


def test_historical_managed_node_ids_rescan_only_after_a_new_registration(monkeypatch) -> None:
    from relay.persistence.daemon import nodes as nodes_module

    scans = 0
    real_map = nodes_module._managed_runtime_identity_map

    def counting_map(payloads):
        nonlocal scans
        scans += 1
        return real_map(payloads)

    monkeypatch.setattr(nodes_module, "_managed_runtime_identity_map", counting_map)
    node = {
        "id": "runtime_old", "userId": "alice", "workspacePath": "/workspace/alice", "workspaceId": "repo:relay",
        "status": "ready", "agents": {"codex": "ready"}, "token": None, "nodeToken": "tok_secret",
        "nodeTokenHash": "sha256:hash", "createdAt": "2026-06-13T00:00:00.000Z",
        "updatedAt": "2026-06-13T00:00:00.000Z", "managedNodeId": "computer_one",
    }
    with TemporaryDirectory() as root:
        store = make_daemon_store(root)
        store.register_node(node)

        assert store.historical_managed_node_ids({"runtime_old"}) == {"runtime_old": "computer_one"}
        assert store.historical_managed_node_ids({"runtime_old", "runtime_missing"}) == {"runtime_old": "computer_one"}
        assert scans == 1, "an unchanged registration log must not be decoded again"

        store.register_node({**node, "id": "runtime_new", "managedNodeId": "computer_two"})
        assert store.historical_managed_node_ids({"runtime_new"}) == {"runtime_new": "computer_two"}
        assert scans == 2


def test_web_ui_export_is_discovered_after_an_initial_miss(tmp_path, monkeypatch) -> None:
    dist = tmp_path / "later-export"
    real_is_dir = type(dist).is_dir
    # Isolate discovery from any export already present in this checkout.
    monkeypatch.setattr(type(dist), "is_dir", lambda path: path == dist and real_is_dir(path))
    assert web_ui_asset_response("index.html", dist).status_code == 404
    dist.mkdir()
    (dist / "index.html").write_text("built after startup")
    response = web_ui_asset_response("index.html", dist)
    assert response.status_code == 200
    assert response.body == b"built after startup"
