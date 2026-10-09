"""Write and read bounds from the 2026-10 database schema review."""

from __future__ import annotations

from sqlalchemy import event

from relay.persistence.session_store import DatabaseSessionStore
from relay.persistence.store_common import relay_event


def capture_sql(engine):
    statements: list[str] = []
    event.listen(
        engine,
        "before_cursor_execute",
        lambda conn, cursor, statement, parameters, context, many: statements.append(
            statement
        ),
    )
    return statements


def session_store(tmp_path) -> DatabaseSessionStore:
    return DatabaseSessionStore(f"sqlite:///{tmp_path}/sessions.db", create_schema=True)


def output_event(session_id: str, text: str) -> dict:
    return relay_event(
        "agent.output",
        session_id,
        {"runId": "run", "agent": "codex", "stream": "stdout", "text": text},
    )


def test_streamed_output_appends_without_touching_the_snapshot(tmp_path):
    store = session_store(tmp_path)
    session = store.create_session({"taskGoal": "Stream", "workspacePath": "/work"})
    store.append_event(
        session["id"],
        relay_event("agent.started", session["id"], {"runId": "run", "agent": "codex"}),
    )
    before = store.get_session_header(session["id"])
    statements = capture_sql(store.engine)

    store.append_event(session["id"], output_event(session["id"], "chunk"), hydrate_events=False)

    snapshot_writes = [
        s for s in statements if s.startswith("UPDATE sessions") and "snapshot" in s
    ]
    snapshot_reads = [
        s for s in statements if s.startswith("SELECT") and "sessions.snapshot" in s
    ]
    assert snapshot_writes == [] and snapshot_reads == []
    header = store.get_session_header(session["id"])
    assert header["eventCount"] == before["eventCount"] + 1
    assert header["updatedAt"] == before["updatedAt"]


def test_streamed_output_keeps_event_order_and_counts(tmp_path):
    store = session_store(tmp_path)
    session = store.create_session({"taskGoal": "Stream", "workspacePath": "/work"})
    for text in ("a", "b"):
        store.append_event(session["id"], output_event(session["id"], text), hydrate_events=False)
    store.append_event(
        session["id"],
        relay_event("session.renamed", session["id"], {"title": "Renamed"}),
    )

    full = store.get_session(session["id"])
    page = store.read_event_page(session["id"])

    texts = [e.get("text") for e in full["events"] if e["type"] == "agent.output"]
    assert texts == ["a", "b"]
    assert full["eventCount"] == len(full["events"]) == page["version"]
    assert full["title"] == "Renamed"
    assert [e["id"] for e in page["events"]] == [e["id"] for e in full["events"]]


def test_neutral_session_events_never_have_a_reducer():
    from relay.persistence.store_common import (
        SESSION_EVENT_HANDLERS,
        SNAPSHOT_NEUTRAL_SESSION_EVENTS,
    )

    assert not SNAPSHOT_NEUTRAL_SESSION_EVENTS & SESSION_EVENT_HANDLERS.keys()


def workspace_file(artifact_id: str, name: str, created_at: str) -> dict:
    return {
        "id": artifact_id,
        "kind": "workspace_file",
        "title": name,
        "workspaceRelativePath": name,
        "createdAt": created_at,
    }


def test_artifact_index_reads_the_projection_not_session_snapshots(tmp_path):
    store = session_store(tmp_path)
    session = store.create_session(
        {"taskGoal": "Files", "workspacePath": "/work", "ownerEmployeeId": "alice"}
    )
    for i, name in enumerate(("a.txt", "b.txt", "a.txt")):
        store.append_event(
            session["id"],
            relay_event(
                "artifact.created",
                session["id"],
                {"artifact": workspace_file(f"f{i}", name, f"2026-10-10T00:00:0{i}.000Z")},
            ),
        )
    statements = capture_sql(store.engine)

    artifacts = store.list_artifact_summaries(owner_employee_id="alice", limit=10)

    assert [a["id"] for a in artifacts] == ["f2", "f1"]
    assert artifacts[0]["sessionTitle"] is None and artifacts[0]["taskGoal"] == "Files"
    assert len(statements) == 1
    assert "session_workspace_files" in statements[0]
    assert "snapshot" not in statements[0]


def test_artifact_index_keeps_the_newest_copy_when_events_arrive_out_of_order(tmp_path):
    store = session_store(tmp_path)
    session = store.create_session(
        {"taskGoal": "Files", "workspacePath": "/work", "ownerEmployeeId": "alice"}
    )
    for artifact in (
        workspace_file("new", "a.txt", "2026-10-10T00:00:09.000Z"),
        workspace_file("old", "a.txt", "2026-10-10T00:00:01.000Z"),
    ):
        store.append_event(
            session["id"],
            relay_event("artifact.created", session["id"], {"artifact": artifact}),
        )

    assert [a["id"] for a in store.list_artifact_summaries(limit=10)] == ["new"]


def test_artifact_index_rows_leave_with_their_session(tmp_path):
    store = session_store(tmp_path)
    session = store.create_session({"taskGoal": "Files", "workspacePath": "/work"})
    store.append_event(
        session["id"],
        relay_event(
            "artifact.created",
            session["id"],
            {"artifact": workspace_file("f", "a.txt", "2026-10-10T00:00:00.000Z")},
        ),
    )

    store.delete_session(session["id"])

    assert store.list_artifact_summaries(limit=10) == []


def test_pending_deletions_use_the_derived_column(tmp_path):
    store = session_store(tmp_path)
    kept = store.create_session({"taskGoal": "Keep", "workspacePath": "/work"})
    doomed = store.create_session({"taskGoal": "Doomed", "workspacePath": "/work"})
    store.append_event(
        doomed["id"],
        relay_event("session.deletion_requested", doomed["id"], {"requestedBy": "a"}),
    )
    statements = capture_sql(store.engine)

    pending = store.list_pending_deletions()

    assert [s["id"] for s in pending] == [doomed["id"]]
    assert kept["id"] not in {s["id"] for s in pending}
    assert "deletion_requested_at IS NOT NULL" in statements[0]


def task_store(tmp_path):
    from relay.persistence.task_store import DatabaseTaskStore

    return DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)


def test_task_lists_filter_deleted_tasks_on_the_derived_column(tmp_path):
    store = task_store(tmp_path)
    kept = store.create_task({"title": "Keep", "ownerEmployeeId": "alice"})
    gone = store.create_task({"title": "Gone", "ownerEmployeeId": "alice"})
    store.delete_task(gone["id"])
    statements = capture_sql(store.engine)

    summaries = store.list_task_summaries(employee_id="alice")
    full = store.list_tasks(employee_id="alice")

    assert [t["id"] for t in summaries] == [kept["id"]]
    assert [t["id"] for t in full] == [kept["id"]]
    task_reads = [s for s in statements if s.startswith("SELECT") and "FROM tasks" in s]
    assert task_reads and all("deleted_at IS NULL" in s for s in task_reads)
    assert not any("deletedAt" in str(s) for s in task_reads)


def daemon_store(tmp_path):
    from relay.persistence.daemon_store import DatabaseDaemonStore

    store = DatabaseDaemonStore(f"sqlite:///{tmp_path}/daemon.db", create_schema=True)
    store.register_node(
        {
            "id": "sbx_alice",
            "employeeId": "alice",
            "workspacePath": "/workspace/alice",
            "workspaceId": "repo:relay",
            "status": "ready",
            "agents": {"codex": "ready"},
            "createdAt": "2026-10-01T00:00:00.000Z",
            "updatedAt": "2026-10-01T00:00:00.000Z",
        }
    )
    return store


def test_idle_heartbeat_writes_only_liveness_columns(tmp_path):
    store = daemon_store(tmp_path)
    before = store.get_node("sbx_alice")
    statements = capture_sql(store.engine)

    seen = store.mark_node_seen("sbx_alice", {})

    writes = [s for s in statements if not s.startswith("SELECT")]
    assert len(writes) == 1
    assert writes[0].startswith("UPDATE daemon_nodes SET")
    assert set(writes[0].split(" SET ")[1].split(" WHERE ")[0].replace("=?", "").split(", ")) == {
        "updated_at",
        "last_seen_at",
    }
    assert not any("FOR UPDATE" in s for s in statements)
    after = store.get_node("sbx_alice")
    assert seen["lastSeenAt"] == after["lastSeenAt"] >= before["updatedAt"]
    assert after["agents"] == before["agents"] and after["status"] == "ready"


def test_idle_heartbeat_for_an_unknown_node_returns_none(tmp_path):
    assert daemon_store(tmp_path).mark_node_seen("sbx_missing", {}) is None


def test_pending_command_lookup_uses_the_run_request_column(tmp_path):
    store = daemon_store(tmp_path)
    request_id = "00000000-0000-4000-8000-0000000000aa"
    for command_id, run_request_id in (
        ("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-0000000000bb"),
        ("00000000-0000-4000-8000-000000000002", request_id),
    ):
        store.stage_command(
            "sbx_alice",
            {
                "id": command_id,
                "type": "run.start",
                "sessionId": "ses",
                "runId": f"run-{command_id[-1]}",
                "agent": "codex",
                "taskGoal": "goal",
                "_runRequestId": run_request_id,
            },
        )
    statements = capture_sql(store.engine)

    pending = store.pending_command_for_run_request(request_id)

    assert pending["id"] == "00000000-0000-4000-8000-000000000002"
    assert len(statements) == 1 and "run_request_id" in statements[0]


def insert_run_request(store, request_id, status, completed_at):
    from datetime import datetime, timezone

    from sqlalchemy import insert, select

    now = datetime.now(timezone.utc)
    with store.engine.begin() as conn:
        node_pk = conn.scalar(select(store.nodes.c.id).where(store.nodes.c.id == "sbx_alice"))
        conn.execute(
            insert(store.run_requests).values(
                id=request_id,
                node_id=node_pk,
                session_id=f"ses-{request_id[-1]}",
                task_goal="goal",
                assignments=[],
                current_index=0,
                state={},
                status=status,
                created_at=now,
                updated_at=completed_at or now,
                completed_at=completed_at,
            )
        )


def test_retention_prunes_old_terminal_run_requests_and_their_events(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from relay.persistence.store_common import daemon_event

    store = daemon_store(tmp_path)
    long_ago = datetime.now(timezone.utc) - timedelta(days=30)
    insert_run_request(store, "00000000-0000-4000-8000-00000000000a", "completed", long_ago)
    insert_run_request(store, "00000000-0000-4000-8000-00000000000b", "completed", datetime.now(timezone.utc))
    insert_run_request(store, "00000000-0000-4000-8000-00000000000c", "running", None)
    store.append_daemon_event(daemon_event("daemon.run_request.updated", {"requestId": "a"}))

    pruned = store.prune_terminal_records(
        retention_seconds=0, per_node_limit=100, run_request_retention_seconds=7 * 86400
    )

    assert pruned["runRequests"] == 1
    assert store.get_run_request("00000000-0000-4000-8000-00000000000a") is None
    assert store.get_run_request("00000000-0000-4000-8000-00000000000b") is not None
    assert store.get_run_request("00000000-0000-4000-8000-00000000000c") is not None
    with store.engine.connect() as conn:
        from sqlalchemy import select

        types = list(conn.scalars(select(store.events.c.type)))
    assert "daemon.run_request.updated" not in types
    assert "daemon.node.registered" in types


def completed_run_session(store, *, agent_log: str, run_id: str = "run"):
    session = store.create_session({"taskGoal": "Old", "workspacePath": "/work"})
    sid = session["id"]
    store.append_event(sid, relay_event("agent.started", sid, {"runId": run_id, "agent": "codex"}))
    store.append_event(sid, output_event(sid, "x" * 1000) | {"runId": run_id}, hydrate_events=False)
    store.append_event(
        sid,
        relay_event(
            "agent.output.batch",
            sid,
            {"runId": run_id, "agent": "codex", "entries": [{"stream": "stdout", "text": "y" * 1000, "sequence": 1}]},
        ),
        hydrate_events=False,
    )
    store.append_event(
        sid,
        relay_event(
            "agent.completed",
            sid,
            {"runId": run_id, "agent": "codex", "status": "completed", "exitCode": 0, "agentLog": agent_log},
        ),
    )
    return sid


def test_output_compaction_redacts_completed_runs_and_keeps_the_log_shape(tmp_path):
    from datetime import datetime, timedelta, timezone

    store = session_store(tmp_path)
    sid = completed_run_session(store, agent_log="final log")
    before = store.get_session(sid)

    redacted = store.compact_completed_run_output(
        older_than=datetime.now(timezone.utc) + timedelta(seconds=1)
    )

    after = store.get_session(sid)
    assert redacted == 2
    assert [e["id"] for e in after["events"]] == [e["id"] for e in before["events"]]
    assert after["eventCount"] == store.get_session_header(sid)["eventCount"]
    outputs = [e for e in after["events"] if e["type"].startswith("agent.output")]
    assert all(e["compacted"] for e in outputs)
    assert outputs[0]["text"] == ""
    assert outputs[1]["entries"] == [{"stream": "stdout", "text": "", "sequence": 1}]
    assert after["agentRuns"][0]["agentLog"] == "final log"
    again = store.compact_completed_run_output(
        older_than=datetime.now(timezone.utc) + timedelta(seconds=1)
    )
    assert again == 0


def test_output_compaction_keeps_runs_without_a_completed_log(tmp_path):
    from datetime import datetime, timedelta, timezone

    store = session_store(tmp_path)
    sid = completed_run_session(store, agent_log="")
    running = store.create_session({"taskGoal": "Live", "workspacePath": "/work"})
    store.append_event(
        running["id"], output_event(running["id"], "live"), hydrate_events=False
    )

    redacted = store.compact_completed_run_output(
        older_than=datetime.now(timezone.utc) + timedelta(seconds=1)
    )

    assert redacted == 0
    texts = [e.get("text") for e in store.get_session(sid)["events"] if e["type"] == "agent.output"]
    assert texts == ["x" * 1000]


def test_output_compaction_skips_threads_active_since_the_cutoff(tmp_path):
    from datetime import datetime, timedelta, timezone

    store = session_store(tmp_path)
    completed_run_session(store, agent_log="final log")

    redacted = store.compact_completed_run_output(
        older_than=datetime.now(timezone.utc) - timedelta(days=1)
    )

    assert redacted == 0


def test_registry_compaction_is_opt_in_and_survives_a_failed_sweep(monkeypatch):
    from types import SimpleNamespace

    from relay.daemon_registry import registry as registry_module

    calls = []
    store = SimpleNamespace(
        compact_completed_run_output=lambda **kwargs: calls.append(kwargs) or 3
    )
    sweep = registry_module.DaemonNodeRegistry._maybe_compact_session_output

    monkeypatch.setattr(registry_module, "SESSION_OUTPUT_RETENTION_DAYS", 0)
    sweep(SimpleNamespace(store=store))
    assert calls == []

    monkeypatch.setattr(registry_module, "SESSION_OUTPUT_RETENTION_DAYS", 30)
    sweep(SimpleNamespace(store=store))
    assert len(calls) == 1 and "older_than" in calls[0]

    def failing(**_kwargs):
        raise RuntimeError("database away")

    sweep(SimpleNamespace(store=SimpleNamespace(compact_completed_run_output=failing)))


def test_dashboard_counters_share_one_pass_over_sessions(tmp_path):
    store = session_store(tmp_path)
    for owner, status_event in (("alice", "session.completed"), ("bob", None)):
        session = store.create_session(
            {"taskGoal": owner, "workspacePath": "/work", "ownerEmployeeId": owner}
        )
        if status_event:
            store.append_event(
                session["id"], relay_event(status_event, session["id"], {"outcome": "done"})
            )
    statements = capture_sql(store.engine)

    metrics = store.dashboard_session_metrics(day_window=3)

    assert len(statements) == 3
    assert metrics["total"] == 2 and metrics["last24h"] == 2 and metrics["last7d"] == 2
    assert metrics["statusCounts"] == {"completed": 1, "running": 1}
    assert {e["employeeId"] for e in metrics["topEmployees"]} == {"alice", "bob"}
    assert metrics["dailyCounts"][-1]["count"] == 2
    assert metrics["dailyCounts"][-1]["completed"] == 1


def test_storage_report_counts_rows_and_inline_content(tmp_path):
    from relay.persistence.storage_report import storage_report

    store = session_store(tmp_path)
    session = store.create_session({"taskGoal": "Report", "workspacePath": "/work"})
    store.write_artifact(
        session["id"], {"kind": "review", "title": "notes", "body": "abcdef", "extension": "txt"}
    )

    report = storage_report(str(store.engine.url))

    tables = {table["name"]: table for table in report["tables"]}
    assert tables["sessions"]["rows"] == 1
    assert tables["session_artifacts"]["rows"] == 1
    assert report["inlineContent"]["sessionArtifactBytes"] == 6
    assert report["inlineContent"]["skillBlobBytes"] == 0
    assert report["inlineContent"]["profileImageBytes"] == 0


def test_daemon_reported_files_reach_the_artifact_index(tmp_path):
    store = session_store(tmp_path)
    session = store.create_session(
        {"taskGoal": "Files", "workspacePath": "/work", "ownerEmployeeId": "alice"}
    )

    store.index_workspace_artifact(
        session["id"],
        workspace_file("gen", "report.md", "2026-10-10T00:00:00.000Z"),
        b"# report",
    )

    [artifact] = store.list_artifact_summaries(owner_employee_id="alice")
    assert artifact["id"] == "gen" and artifact["bytes"] == 8
