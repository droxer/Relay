"""Work bounds for database-backed control-plane paths."""

import asyncio
import json
import threading
from types import SimpleNamespace

from relay.persistence.session_store import DatabaseSessionStore
from relay.persistence.store_common import relay_event
from relay.persistence.task_store import DatabaseTaskStore
from relay.services.execution_lifecycle import ExecutionLifecycleService
from relay.tasks.scheduler import TaskScheduler
from sqlalchemy import event


def capture_sql(store):
    statements = []
    event.listen(
        store.engine,
        "before_cursor_execute",
        lambda conn, cursor, statement, parameters, context, many: statements.append(
            statement
        ),
    )
    return statements


def test_full_task_list_batches_histories_and_filters_before_limit(tmp_path):
    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)
    for i in range(12):
        store.create_task(
            {"title": str(i), "ownerEmployeeId": "alice" if i < 6 else "bob"}
        )
    statements = capture_sql(store)
    tasks = store.list_tasks(employee_id="alice", limit=3)
    assert len(tasks) == 3
    assert all(t["ownerEmployeeId"] == "alice" and t["events"] for t in tasks)
    assert len([s for s in statements if s.startswith("SELECT")]) <= 2
    assert "LIMIT" in statements[0]


def test_task_append_updates_projection_without_replaying_history(
    tmp_path, monkeypatch
):
    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)
    task = store.create_task({"title": "History"})
    for i in range(30):
        store.record_activity(task["id"], str(i))

    def no_replay(*args, **kwargs):
        raise AssertionError("append replayed full history")

    monkeypatch.setattr(
        "relay.persistence.task_store.materialize_task_events", no_replay
    )
    updated = store.record_activity(task["id"], "latest")
    assert len(updated["activity"]) == 31
    assert updated["activity"][-1]["message"] == "latest"


def test_dispatch_candidate_page_limits_sql(tmp_path):
    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)
    for i in range(8):
        task = store.create_task({"title": str(i)})
        store.assign_task(task["id"], "codex")
    statements = capture_sql(store)
    tasks = store.list_dispatchable_tasks(limit=2)
    assert len(tasks) == 2
    assert "LIMIT" in statements[-1]


def test_thread_summary_does_not_transfer_completed_run_logs(tmp_path):
    store = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/sessions.db", create_schema=True
    )
    session = store.create_session({"taskGoal": "Summary", "workspacePath": "/work"})
    store.append_event(
        session["id"],
        relay_event("agent.started", session["id"], {"runId": "run", "agent": "codex"}),
    )
    store.append_event(
        session["id"],
        relay_event(
            "agent.completed",
            session["id"],
            {
                "runId": "run",
                "agent": "codex",
                "status": "completed",
                "exitCode": 0,
                "agentLog": "x" * 100000,
            },
        ),
    )
    statements = capture_sql(store)
    summary = store.list_session_summaries()[0]
    assert len(json.dumps(summary)) < 5000
    assert summary["runCount"] == 1
    assert "SELECT sessions.snapshot," not in statements[0]


def test_execution_annotations_batch_commands_and_scope_sessions():
    seen = []

    class Store:
        def list_active_run_requests(self, *, session_ids=None):
            assert session_ids == {"s1", "s2"}
            return [
                {"sessionId": s, "currentCommandId": s, "status": "running"}
                for s in session_ids
            ]

        def list_active_runs(self, *, session_ids=None):
            assert session_ids == {"s1", "s2"}
            return []

        def get_commands(self, ids):
            seen.append(ids)
            return {i: {"status": "queued"} for i in ids}

        def get_command(self, command_id):
            raise AssertionError("N+1 command lookup")

    service = ExecutionLifecycleService(SimpleNamespace(daemon_store=Store()), None)
    assert len(service.annotate([{"id": "s1"}, {"id": "s2"}])) == 2
    assert seen == [{"s1", "s2"}]


def test_scheduler_database_phase_runs_off_event_loop(monkeypatch):
    scheduler = TaskScheduler(task_store=None, registry=None, backend=None)

    async def run():
        loop_thread = threading.get_ident()

        def promote(today):
            assert threading.get_ident() != loop_thread
            return 0, 0

        monkeypatch.setattr(scheduler, "_promote_due_routines", promote)
        monkeypatch.setattr(scheduler, "_dispatchable_tasks", lambda: [])
        await scheduler.tick()

    asyncio.run(run())


def test_artifact_index_deduplicates_before_sql_limit(tmp_path):
    store = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/sessions.db", create_schema=True
    )
    for owner in ("alice", "bob"):
        session = store.create_session(
            {"taskGoal": owner, "workspacePath": "/work", "ownerEmployeeId": owner}
        )
        for i, name in enumerate(("old.txt", "same.txt", "same.txt")):
            artifact = {
                "id": f"{owner}-{i}",
                "kind": "workspace_file",
                "title": name,
                "workspaceRelativePath": name,
                "createdAt": f"2026-09-17T00:00:0{i}.000Z",
            }
            store.append_event(
                session["id"],
                relay_event("artifact.created", session["id"], {"artifact": artifact}),
            )
    statements = capture_sql(store)
    artifacts = store.list_artifact_summaries(
        owner_employee_id="alice", workspace_path="/work", limit=2
    )
    assert [a["id"] for a in artifacts] == ["alice-2", "alice-0"]
    assert all(a["ownerEmployeeId"] == "alice" for a in artifacts)
    assert len(statements) == 1 and "LIMIT" in statements[0]
    assert "session_events" not in statements[0]


def test_sync_api_reads_and_json_mutations_do_not_block_loop(tmp_path, monkeypatch):
    import httpx
    from relay.app import create_app

    app = create_app(str(tmp_path))

    async def run():
        loop_thread = threading.get_ident()

        def check_thread(*args):
            assert threading.get_ident() != loop_thread
            return False

        monkeypatch.setattr(app.state.auth_store, "has_users", check_thread)
        monkeypatch.setattr(app.state.auth_store, "authenticate", check_thread)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            assert (await client.get("/api/v1/auth/status")).status_code == 200
            assert (
                await client.post(
                    "/api/v1/auth/login", json={"username": "a", "password": "b"}
                )
            ).status_code == 401

    asyncio.run(run())


def test_background_task_writes_do_not_load_history(tmp_path, monkeypatch):
    from relay.persistence.task_store import compact_task_writes

    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)
    task = store.create_task({"title": "History"})
    for i in range(20):
        store.record_activity(task["id"], str(i))

    def no_history(*args, **kwargs):
        raise AssertionError("background write loaded history")

    monkeypatch.setattr(store, "_events_for_task", no_history)
    monkeypatch.setattr(store, "_hydrate_task", no_history)
    with compact_task_writes():
        task = store.record_activity(task["id"], "latest")
        assert task["activityCount"] == 21
        with store.task_write_scope(task["id"]) as current:
            assert current["lastActivity"]["message"] == "latest"


def test_scheduler_pages_remain_complete_when_candidates_leave_queue(tmp_path):
    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)
    expected = set()
    for i in range(65):
        task = store.create_task(
            {
                "title": str(i),
                "priority": ("high", "normal", "low")[i % 3],
                **({"dueDate": "2026-09-17"} if i % 2 else {}),
            }
        )
        store.assign_task(task["id"], "codex")
        expected.add(task["id"])
    statements = capture_sql(store)
    scheduler = TaskScheduler(task_store=store, registry=None, backend=None)
    seen = []
    for candidate in scheduler._dispatchable_tasks():
        seen.append(candidate["id"])
        store.update_task(candidate["id"], {"status": "done"})
    assert set(seen) == expected and len(seen) == len(expected)
    queue_queries = [sql for sql in statements if "ORDER BY CASE" in sql]
    assert len(queue_queries) == 3
    assert all("LIMIT" in sql for sql in queue_queries)


def test_scheduler_shutdown_waits_for_worker(tmp_path, monkeypatch):
    from threading import Event

    entered, release, finished = Event(), Event(), Event()
    scheduler = TaskScheduler(task_store=None, registry=None, backend=None)

    def promote(today):
        entered.set()
        assert release.wait(5)
        finished.set()
        return 0, 0

    monkeypatch.setattr(scheduler, "_promote_due_routines", promote)
    monkeypatch.setattr(scheduler, "_dispatchable_tasks", lambda: [])

    async def run():
        scheduler.start()
        assert await asyncio.to_thread(entered.wait, 5)
        stopped = asyncio.create_task(scheduler.stop())
        await asyncio.sleep(0)
        assert not stopped.done()
        release.set()
        await stopped
        assert finished.is_set()

    asyncio.run(run())
