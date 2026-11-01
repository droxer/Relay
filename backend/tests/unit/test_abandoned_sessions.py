"""A thread opened and never dispatched is settled at boot, through its log."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import update

from relay.migrations_runtime.abandoned_sessions import settle_never_dispatched_sessions
from relay.persistence.events import relay_event
from relay.sessions.abandoned import is_never_dispatched
from tests.store_fixtures import create_run_request_on_node, make_daemon_store, make_session_store

NOW = datetime(2026, 11, 1, tzinfo=UTC)


def _age(store, session_id: str, days: int) -> None:
    with store.engine.begin() as conn:
        conn.execute(
            update(store.sessions)
            .where(store.sessions.c.id == session_id)
            .values(updated_at=NOW - timedelta(days=days))
        )


def _open(store, goal: str, *, days: int) -> dict:
    session = store.create_session({"workspacePath": "/workspace", "taskGoal": goal})
    store.append_event(session["id"], relay_event("session.status", session["id"], {"status": "running", "phase": "assigned"}))
    _age(store, session["id"], days)
    return session


def test_never_dispatched_means_open_with_no_run_and_no_deletion() -> None:
    assert is_never_dispatched({"status": "running", "agentRuns": []})
    assert not is_never_dispatched({"status": "running", "agentRuns": [{"status": "completed"}]})
    assert not is_never_dispatched({"status": "completed", "agentRuns": []})
    assert not is_never_dispatched({"status": "running", "agentRuns": [], "deletionRequestedAt": "2026-10-01T00:00:00Z"})


def test_settles_only_old_threads_nothing_ever_ran_or_holds(tmp_path: Path) -> None:
    sessions = make_session_store(tmp_path)
    daemon = make_daemon_store(tmp_path)
    orphan = _open(sessions, "Planned, never sent", days=30)
    reserved = _open(sessions, "Queued for a computer", days=30)
    create_run_request_on_node(daemon, {
        "nodeId": "node-1", "sessionId": reserved["id"], "taskGoal": "Queued", "assignments": [], "state": {},
    })
    ran = _open(sessions, "Ran once", days=30)
    sessions.append_event(ran["id"], relay_event("agent.started", ran["id"], {"agent": "claude", "runId": "r1"}))
    _age(sessions, ran["id"], 30)
    recent = _open(sessions, "Opened yesterday", days=1)

    settled = settle_never_dispatched_sessions(session_store=sessions, daemon_store=daemon, now=NOW)

    assert settled == [orphan["id"]]
    after = sessions.get_session(orphan["id"])
    assert (after["status"], after["phase"]) == ("cancelled", "cancelled")
    # The log says who settled it and why, so it never reads as a person's cancel.
    assert after["events"][-1]["reason"] == "never_dispatched"
    for kept in (reserved, ran, recent):
        assert sessions.get_session(kept["id"])["status"] == "running"


def test_is_idempotent(tmp_path: Path) -> None:
    sessions = make_session_store(tmp_path)
    daemon = make_daemon_store(tmp_path)
    _open(sessions, "Planned, never sent", days=30)

    assert len(settle_never_dispatched_sessions(session_store=sessions, daemon_store=daemon, now=NOW)) == 1
    assert settle_never_dispatched_sessions(session_store=sessions, daemon_store=daemon, now=NOW) == []
