from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID

import pytest
from relay.persistence.session_store import DatabaseSessionStore, LocalSessionStore
from relay.persistence.store_common import materialize_events, relay_event
from relay.persistence.task_store import DatabaseTaskStore
from relay.sessions.controller import SessionController, SessionRunInFlightError
from sqlalchemy import select, text


@pytest.mark.parametrize("outcome", ["reported_done", "unfinished", "blocked", "needs_review", "unverified"])
def test_work_outcome_survives_replay_and_clears_on_new_execution(outcome):
    created = relay_event("session.created", "ses_work", {
        "workspacePath": "/workspace", "taskGoal": "Resolve", "participants": ["human", "codex"],
    })
    completed = relay_event("session.completed", "ses_work", {"outcome": "Run ended", "workOutcome": outcome})
    assert materialize_events([created, completed])["workOutcome"] == outcome
    restarted = relay_event("session.status", "ses_work", {"status": "running", "phase": "execution"})
    assert "workOutcome" not in materialize_events([created, completed, restarted])
    failed = relay_event("session.failed", "ses_work", {"outcome": "Process failed"})
    assert materialize_events([created, completed, failed])["workOutcome"] == "blocked"
    legacy = relay_event("session.completed", "ses_work", {"outcome": "Old run"})
    assert materialize_events([created, completed, legacy])["workOutcome"] == "unverified"


def test_session_stores_create_uuid_thread_ids() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            created = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "taskGoal": "ship the release",
                    "participants": ["human"],
                }
            )

            assert str(UUID(created["id"])) == created["id"]
            assert created["workspaceLayout"] == "thread"
            assert created["events"][0]["workspaceLayout"] == "thread"


def test_historical_session_without_layout_retains_legacy_node_root() -> None:
    created = relay_event(
        "session.created",
        "ses_legacy",
        {
            "workspacePath": "/workspace/alice",
            "taskGoal": "continue existing checkout",
            "participants": ["human"],
        },
    )

    session = materialize_events([created])

    assert "workspaceLayout" not in session


def test_session_stores_preserve_team_provenance() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            created = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "ownerEmployeeId": "alice",
                    "ownerAgentId": "agent_lead",
                    "teamId": "team_delivery",
                    "taskGoal": "ship the release",
                    "participants": ["human", "codex"],
                }
            )

            persisted = store.get_session(created["id"])
            assert persisted["teamId"] == "team_delivery"
            assert persisted["events"][0]["teamId"] == "team_delivery"
            assert store.list_sessions()[0]["teamId"] == "team_delivery"


def test_session_stores_preserve_managed_computer_affinity() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            created = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "daemonNodeId": "runtime_old",
                    "managedNodeId": "computer_alice",
                    "taskGoal": "ship the release",
                    "participants": ["human", "codex"],
                }
            )

            persisted = store.get_session(created["id"])
            assert persisted["managedNodeId"] == "computer_alice"
            assert persisted["events"][0]["managedNodeId"] == "computer_alice"


def test_session_stores_read_incremental_event_pages() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            created = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "taskGoal": "stream smoothly",
                    "participants": ["human", "pi"],
                }
            )
            first_id = created["events"][0]["id"]
            output = relay_event(
                "agent.output",
                created["id"],
                {
                    "runId": "run_1",
                    "agent": "pi",
                    "stream": "stdout",
                    "text": "hello",
                    "sequence": 0,
                },
            )
            store.append_event(created["id"], output)

            initial = store.read_event_page(created["id"], after_event_id=first_id)
            assert [event["id"] for event in initial["events"]] == [output["id"]]
            assert initial["nextSequence"] == 2
            assert initial["status"] == "running"

            tail = store.read_event_page(
                created["id"], after_sequence=initial["nextSequence"]
            )
            assert tail["events"] == []
            assert tail["nextSequence"] == 2


def test_session_stores_bound_incremental_event_pages() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            created = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "taskGoal": "stream in bounded pages",
                    "participants": ["human"],
                }
            )
            for sequence in range(3):
                store.append_event(
                    created["id"],
                    relay_event(
                        "agent.output",
                        created["id"],
                        {
                            "runId": "run_1",
                            "agent": "codex",
                            "stream": "stdout",
                            "text": str(sequence),
                            "sequence": sequence,
                        },
                    ),
                )

            first = store.read_event_page(created["id"], limit=2)
            second = store.read_event_page(
                created["id"], after_sequence=first["nextSequence"], limit=2
            )

            assert len(first["events"]) == 2
            assert first["nextSequence"] == 2
            assert len(second["events"]) == 2
            assert second["nextSequence"] == 4


def test_session_snapshots_do_not_duplicate_event_history() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            created = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "taskGoal": "stream a long result",
                    "participants": ["human", "codex"],
                }
            )
            store.append_event(
                created["id"],
                relay_event(
                    "agent.output",
                    created["id"],
                    {
                        "runId": "run_one",
                        "agent": "codex",
                        "stream": "stdout",
                        "text": "chunk",
                        "sequence": 0,
                    },
                ),
            )

            if isinstance(store, LocalSessionStore):
                raw_snapshot = json.loads(
                    store._snapshot_path(created["id"]).read_text(encoding="utf-8")
                )
            else:
                with store.engine.begin() as conn:
                    raw_snapshot = conn.scalar(
                        select(store.sessions.c.snapshot).where(
                            store.sessions.c.id == created["id"]
                        )
                    )

            assert "events" not in raw_snapshot
            assert len(store.get_session(created["id"])["events"]) == 2


def test_session_summary_pages_are_bounded_and_event_free() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            for index in range(3):
                store.create_session(
                    {
                        "workspacePath": "/workspace/alice",
                        "ownerEmployeeId": "alice" if index < 2 else "bob",
                        "taskGoal": f"task {index}",
                        "participants": ["human"],
                    }
                )

            summaries = store.list_session_summaries(owner_employee_id="alice", limit=1)

            assert len(summaries) == 1
            assert summaries[0]["ownerEmployeeId"] == "alice"
            assert summaries[0]["eventCount"] == 1
            assert "events" not in summaries[0]


def test_session_stores_notify_after_committed_events() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            notified: list[str] = []
            store.set_event_listener(notified.append)
            created = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "taskGoal": "wake subscribers",
                    "participants": ["human"],
                }
            )
            notified.clear()

            store.append_event(
                created["id"],
                relay_event(
                    "session.status",
                    created["id"],
                    {"status": "completed", "phase": "completed"},
                ),
            )

            assert notified == [created["id"]]


def test_session_stores_delete_session() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            created = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "ownerEmployeeId": "alice",
                    "taskGoal": "ship the release",
                    "participants": ["human"],
                }
            )
            store.append_event(
                created["id"], relay_event("session.archived", created["id"], {})
            )

            store.delete_session(created["id"])

            assert all(item["id"] != created["id"] for item in store.list_sessions())
            try:
                store.get_session(created["id"])
            except KeyError:
                pass
            else:
                raise AssertionError("deleted session should raise KeyError")


def test_database_session_delete_rolls_back_task_unlinks_atomically(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/relay.db"
    session_store = DatabaseSessionStore(database_url, create_schema=True)
    task_store = DatabaseTaskStore(database_url, create_schema=True)
    session = session_store.create_session(
        {
            "workspacePath": "/workspace",
            "taskGoal": "delete atomically",
            "participants": ["human"],
        }
    )
    tasks = [
        task_store.create_task({"title": "first"}),
        task_store.create_task({"title": "second"}),
    ]
    for task in tasks:
        task_store.link_session(task["id"], session["id"])

    original = task_store.unlink_session_in_transaction
    calls = 0

    def fail_after_first_unlink(conn, task_id: str, session_id: str):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("simulated unlink failure")
        return original(conn, task_id, session_id)

    monkeypatch.setattr(
        task_store, "unlink_session_in_transaction", fail_after_first_unlink
    )

    with pytest.raises(RuntimeError, match="simulated unlink failure"):
        session_store.delete_session_with_task_unlinks(session["id"], task_store)

    assert session_store.get_session(session["id"])["id"] == session["id"]
    for task in tasks:
        assert session["id"] in task_store.get_task(task["id"])["linkedSessionIds"]


def test_database_session_delete_rechecks_active_runs_under_lock(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path}/relay.db"
    session_store = DatabaseSessionStore(database_url, create_schema=True)
    task_store = DatabaseTaskStore(database_url, create_schema=True)
    controller = SessionController(session_store, task_store=task_store)
    session = session_store.create_session(
        {
            "workspacePath": "/workspace",
            "taskGoal": "keep active run",
            "participants": ["human", "codex"],
        }
    )
    stale_snapshot = session_store.get_session(session["id"])
    session_store.append_event(
        session["id"],
        relay_event(
            "agent.started",
            session["id"],
            {"runId": "run_active", "agent": "codex"},
        ),
    )

    with pytest.raises(SessionRunInFlightError):
        controller.delete_session(session["id"], snapshot=stale_snapshot)

    assert session_store.get_session(session["id"])["id"] == session["id"]


def test_database_session_store_verify_schema_rejects_missing_table(
    tmp_path: Path,
) -> None:
    store = DatabaseSessionStore(f"sqlite:///{tmp_path}/relay.db", create_schema=True)
    with store.engine.begin() as conn:
        conn.execute(text("DROP TABLE session_artifacts"))

    with pytest.raises(RuntimeError, match="session_artifacts"):
        store.verify_schema()


def test_database_session_store_verify_schema_rejects_missing_column(
    tmp_path: Path,
) -> None:
    store = DatabaseSessionStore(f"sqlite:///{tmp_path}/relay.db", create_schema=True)
    with store.engine.begin() as conn:
        conn.execute(text("ALTER TABLE sessions DROP COLUMN title"))

    with pytest.raises(RuntimeError, match="title"):
        store.verify_schema()


def test_session_store_persists_events_and_artifacts() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "fix auth",
                "participants": ["human", "claude"],
            }
        )
        store.append_event(
            session["id"],
            relay_event(
                "human.decision",
                session["id"],
                {
                    "decision": {
                        "id": "dec_test",
                        "kind": "approve",
                        "createdAt": "2026-06-05T00:00:00.000Z",
                    }
                },
            ),
        )
        artifact = store.write_artifact(
            session["id"],
            {
                "kind": "review",
                "title": "Agent review",
                "body": "Looks good.",
                "extension": "md",
            },
        )
        updated = store.append_event(
            session["id"],
            relay_event("artifact.created", session["id"], {"artifact": artifact}),
        )

        assert updated["events"][0]["type"] == "session.created"
        assert store.get_session(session["id"])["decisions"][0]["kind"] == "approve"
        assert store.read_artifact(session["id"], artifact["id"]) == "Looks good."


def test_session_store_create_artifact_indexes_artifact() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "fix auth",
                "participants": ["human", "claude"],
            }
        )
        artifact, updated = store.create_artifact(
            session["id"],
            {
                "kind": "review",
                "title": "Agent review",
                "body": "  Looks good.\n\n",
                "extension": "md",
            },
        )

        assert str(UUID(artifact["id"])) == artifact["id"]
        assert updated["artifacts"][0]["id"] == artifact["id"]
        assert store.read_artifact(session["id"], artifact["id"]) == "  Looks good.\n\n"


def test_local_session_store_serializes_concurrent_appends() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "collect decisions",
                "participants": ["human"],
            }
        )

        def append(index: int) -> None:
            store.append_event(
                session["id"],
                relay_event(
                    "human.decision",
                    session["id"],
                    {
                        "decision": {
                            "id": f"dec_{index}",
                            "kind": "approve",
                            "createdAt": "2026-06-05T00:00:00.000Z",
                        }
                    },
                ),
            )

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(append, range(25)))

        updated = store.get_session(session["id"])
        assert len(updated["decisions"]) == 25
        assert {decision["id"] for decision in updated["decisions"]} == {
            f"dec_{index}" for index in range(25)
        }


def test_session_store_clears_pending_decision_on_terminal_events() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "finish review",
                "participants": ["human", "codex"],
            }
        )
        store.append_event(
            session["id"],
            relay_event(
                "session.status",
                session["id"],
                {
                    "status": "waiting_for_human",
                    "phase": "feedback",
                    "pendingDecision": "feedback",
                },
            ),
        )
        completed = store.append_event(
            session["id"],
            relay_event(
                "session.completed",
                session["id"],
                {
                    "outcome": "done",
                },
            ),
        )

        assert completed["status"] == "completed"
        assert "pendingDecision" not in completed


def test_session_store_clears_pending_decision_on_cancel_decision() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "cancel review",
                "participants": ["human", "codex"],
            }
        )
        store.append_event(
            session["id"],
            relay_event(
                "session.status",
                session["id"],
                {
                    "status": "waiting_for_human",
                    "phase": "feedback",
                    "pendingDecision": "feedback",
                },
            ),
        )
        cancelled = store.append_event(
            session["id"],
            relay_event(
                "human.decision",
                session["id"],
                {
                    "decision": {
                        "id": "dec_cancel",
                        "kind": "cancel",
                        "createdAt": "2026-06-20T00:00:00.000Z",
                    }
                },
            ),
        )

        assert cancelled["status"] == "cancelled"
        assert "pendingDecision" not in cancelled


def test_agent_started_backfills_session_daemon_node() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            created = store.create_session(
                {
                    "workspacePath": "/workspace",
                    "taskGoal": "fix auth",
                    "participants": ["human", "claude"],
                }
            )
            assert "daemonNodeId" not in created

            pinned = store.append_event(
                created["id"],
                relay_event(
                    "agent.started",
                    created["id"],
                    {
                        "runId": "run_1",
                        "agent": "claude",
                        "daemonNodeId": "node_a",
                    },
                ),
            )
            assert pinned["daemonNodeId"] == "node_a"
            assert pinned["agentRuns"][0]["daemonNodeId"] == "node_a"

            moved = store.append_event(
                created["id"],
                relay_event(
                    "agent.started",
                    created["id"],
                    {
                        "runId": "run_2",
                        "agent": "claude",
                        "daemonNodeId": "node_b",
                    },
                ),
            )
            assert moved["daemonNodeId"] == "node_b"


def test_agent_run_history_uses_the_index_projection() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            session = store.create_session(
                {"workspacePath": "/workspace", "taskGoal": "indexed"}
            )
            store.append_event(
                session["id"],
                relay_event(
                    "agent.started",
                    session["id"],
                    {
                        "runId": "run-indexed",
                        "agent": "codex",
                        "logicalAgentId": "11111111-1111-1111-1111-111111111111",
                        "placementId": "22222222-2222-2222-2222-222222222222",
                    },
                ),
            )

            assert store.has_agent_run("11111111-1111-1111-1111-111111111111", set())
            assert store.has_agent_run(
                "33333333-3333-3333-3333-333333333333",
                {"22222222-2222-2222-2222-222222222222"},
            )
            store.delete_session(session["id"])
            assert store.has_agent_run("11111111-1111-1111-1111-111111111111", set())


def test_local_agent_run_index_backfills_from_authoritative_events() -> None:
    with TemporaryDirectory() as root:
        root_path = Path(root)
        session_id = "44444444-4444-4444-4444-444444444444"
        session_dir = root_path / "sessions" / session_id
        session_dir.mkdir(parents=True)
        created = relay_event(
            "session.created",
            session_id,
            {"workspacePath": "/workspace", "taskGoal": "recover stale snapshot"},
        )
        started = relay_event(
            "agent.started",
            session_id,
            {
                "runId": "run-before-crash",
                "agent": "codex",
                "logicalAgentId": "55555555-5555-5555-5555-555555555555",
                "placementId": "66666666-6666-6666-6666-666666666666",
            },
        )
        (session_dir / "events.jsonl").write_text(
            "".join(f"{json.dumps(event)}\n" for event in (created, started)),
            encoding="utf-8",
        )
        (session_dir / "snapshot.json").write_text(
            json.dumps(materialize_events([created])),
            encoding="utf-8",
        )

        store = LocalSessionStore(root_path)

        assert store.has_agent_run("55555555-5555-5555-5555-555555555555", set())
        assert store.has_agent_run(
            "77777777-7777-7777-7777-777777777777",
            {"66666666-6666-6666-6666-666666666666"},
        )


def test_database_session_store_persists_events_and_artifacts() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "fix auth",
                "participants": ["human", "claude"],
            }
        )
        store.append_event(
            session["id"],
            relay_event(
                "human.decision",
                session["id"],
                {
                    "decision": {
                        "id": "dec_test",
                        "kind": "approve",
                        "createdAt": "2026-06-05T00:00:00.000Z",
                    }
                },
            ),
        )
        artifact = store.write_artifact(
            session["id"],
            {
                "kind": "review",
                "title": "Agent review",
                "body": "Looks good.",
                "extension": "md",
            },
        )
        updated = store.append_event(
            session["id"],
            relay_event("artifact.created", session["id"], {"artifact": artifact}),
        )
        store.append_event(
            session["id"],
            relay_event(
                "agent.started",
                session["id"],
                {
                    "runId": "run_1",
                    "agent": "codex",
                    "role": "fixer",
                },
            ),
        )
        completed_event = relay_event(
            "agent.completed",
            session["id"],
            {
                "runId": "run_1",
                "agent": "codex",
                "status": "completed",
                "exitCode": 0,
                "tokenUsage": {
                    "input": 4,
                    "output": 5,
                    "cache": 1,
                    "total": 10,
                    "source": "codex",
                },
            },
        )
        store.append_event(session["id"], completed_event)
        store.append_event(
            session["id"],
            relay_event(
                "human.decision",
                session["id"],
                {
                    "decision": {
                        "id": "dec_after_usage",
                        "kind": "approve",
                        "createdAt": "2026-06-05T00:01:00.000Z",
                    }
                },
            ),
        )

        assert updated["events"][0]["type"] == "session.created"
        assert store.get_session(session["id"])["decisions"][0]["kind"] == "approve"
        assert store.list_sessions()[0]["id"] == session["id"]
        assert store.read_artifact(session["id"], artifact["id"]) == "Looks good."
        assert not (Path(root) / "session-artifacts").exists()
        with store.engine.begin() as conn:
            content = conn.execute(
                text("select content from session_artifacts where id = :artifact_id"),
                {"artifact_id": artifact["id"]},
            ).scalar_one()
        assert content == "Looks good."
        usage = store.list_token_usage()[0]
        assert usage["taskGoal"] == "fix auth"
        assert usage["runId"] == "run_1"
        assert usage["completedAt"] == completed_event["timestamp"]
        assert usage["total"] == 10
        with store.engine.begin() as conn:
            row = conn.execute(store.run_token_usage.select()).mappings().one()
        assert row["session_id"] == session["id"]
        assert row["run_id"] == "run_1"
        assert row["total_tokens"] == 10


def test_database_session_store_create_artifact_indexes_artifact() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "fix auth",
                "participants": ["human", "claude"],
            }
        )
        artifact, updated = store.create_artifact(
            session["id"],
            {
                "kind": "review",
                "title": "Agent review",
                "body": "  Looks good.\n\n",
                "extension": "md",
            },
        )

        assert str(UUID(artifact["id"])) == artifact["id"]
        assert updated["artifacts"][0]["id"] == artifact["id"]
        assert store.read_artifact(session["id"], artifact["id"]) == "  Looks good.\n\n"
        assert not (Path(root) / "session-artifacts").exists()


def _workspace_file_artifact(session_id: str) -> dict:
    return {
        "id": "22222222-2222-4222-8222-222222222222",
        "kind": "workspace_file",
        "title": "deck.pptx",
        "path": f"/workspace/{session_id}/deck.pptx",
        "createdAt": "2026-07-01T00:00:00.000Z",
        "agentRunId": "run_1",
        "bytes": 10,
        "contentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "workspaceRelativePath": "deck.pptx",
    }


def test_local_session_store_workspace_artifact_snapshot_roundtrip() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "build a deck",
                "participants": ["human", "codex"],
            }
        )
        artifact, updated = store.index_workspace_artifact(
            session["id"],
            _workspace_file_artifact(session["id"]),
            b"pptx binary \x00 bytes",
        )

        assert updated["artifacts"][0]["id"] == artifact["id"]
        assert artifact["bytes"] == len(b"pptx binary \x00 bytes")
        assert artifact["snapshotPath"].endswith(".pptx")
        assert (
            store.read_artifact_content(session["id"], artifact["id"])
            == b"pptx binary \x00 bytes"
        )

        # Metadata-only indexing (no snapshot) still records the artifact.
        no_content, _updated = store.index_workspace_artifact(
            session["id"],
            {
                **_workspace_file_artifact(session["id"]),
                "id": "33333333-3333-4333-8333-333333333333",
            },
            None,
        )
        assert "snapshotPath" not in no_content
        assert store.read_artifact_content(session["id"], no_content["id"]) is None


def test_database_session_store_workspace_artifact_snapshot_roundtrip() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True)
        session = store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "build a deck",
                "participants": ["human", "codex"],
            }
        )
        artifact, updated = store.index_workspace_artifact(
            session["id"],
            _workspace_file_artifact(session["id"]),
            b"pptx binary \x00 bytes",
        )

        assert updated["artifacts"][0]["id"] == artifact["id"]
        assert artifact["bytes"] == len(b"pptx binary \x00 bytes")
        assert (
            store.read_artifact_content(session["id"], artifact["id"])
            == b"pptx binary \x00 bytes"
        )
        with store.engine.begin() as conn:
            row = (
                conn.execute(
                    text(
                        "select kind, metadata from session_artifacts where id = :artifact_id"
                    ),
                    {"artifact_id": artifact["id"]},
                )
                .mappings()
                .one()
            )
        assert row["kind"] == "workspace_file"

        no_content, _updated = store.index_workspace_artifact(
            session["id"],
            {
                **_workspace_file_artifact(session["id"]),
                "id": "33333333-3333-4333-8333-333333333333",
            },
            None,
        )
        assert store.read_artifact_content(session["id"], no_content["id"]) is None


def test_deleted_session_stays_deleted_and_retains_token_usage() -> None:
    with TemporaryDirectory() as root:
        stores = (
            LocalSessionStore(Path(root) / "local"),
            DatabaseSessionStore(f"sqlite:///{root}/relay.db", create_schema=True),
        )
        for store in stores:
            session = store.create_session(
                {
                    "workspacePath": "/workspace/alice",
                    "ownerEmployeeId": "alice",
                    "taskGoal": "ship the release",
                    "participants": ["human"],
                }
            )
            store.append_event(
                session["id"],
                relay_event(
                    "agent.started",
                    session["id"],
                    {
                        "runId": "run_1",
                        "agent": "codex",
                    },
                ),
            )
            store.append_event(
                session["id"],
                relay_event(
                    "agent.completed",
                    session["id"],
                    {
                        "runId": "run_1",
                        "agent": "codex",
                        "status": "completed",
                        "exitCode": 0,
                        "tokenUsage": {
                            "input": 4,
                            "output": 5,
                            "cache": 1,
                            "total": 10,
                            "source": "codex",
                        },
                    },
                ),
            )

            store.delete_session(session["id"], deleted_by="alice")

            with pytest.raises(KeyError):
                store.get_session(session["id"])
            # A late event flush (e.g. a daemon finishing after the delete)
            # must not resurrect the thread.
            with pytest.raises(KeyError):
                store.append_event(
                    session["id"],
                    relay_event(
                        "agent.output",
                        session["id"],
                        {
                            "runId": "run_1",
                            "stream": "stdout",
                            "chunk": "late output",
                        },
                    ),
                )
            assert all(item["id"] != session["id"] for item in store.list_sessions())

            [usage] = store.list_token_usage()
            assert usage["runId"] == "run_1"
            assert usage["taskGoal"] == "ship the release"
            assert usage["total"] == 10

            if isinstance(store, DatabaseSessionStore):
                with store.engine.begin() as conn:
                    tombstone = conn.execute(store.tombstones.select()).mappings().one()
                assert tombstone["session_id"] == session["id"]
                assert tombstone["task_goal"] == "ship the release"
                assert tombstone["deleted_by"] == "alice"
            else:
                tombstone = json.loads(
                    (store.sessions_dir / f"{session['id']}.deleted.json").read_text(
                        encoding="utf-8"
                    )
                )
                assert tombstone["id"] == session["id"]
                assert tombstone["taskGoal"] == "ship the release"
                assert tombstone["deletedBy"] == "alice"
