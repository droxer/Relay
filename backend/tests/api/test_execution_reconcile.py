"""An unrecoverable execution must have a way out that a person can reach.

Deletion waits for exit evidence, and evidence only ever arrived from the
daemon. When the machine is gone, nothing produces it. Two assertions release
such an execution: deleting the thread asserts it for the thread (the delete
completes once recovery is required), and the reconcile endpoint asserts it
for the node, whose deletion the stuck request would otherwise block as
active work. These tests pin both paths and their limits.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, update

from relay.app import create_app
from relay.core.ids import new_database_id
from relay.persistence.events import relay_event
from relay.sessions.controller import SessionController


def _bootstrap(client: TestClient) -> None:
    response = client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token",
        "username": "admin",
        "email": "admin@example.com", "password": "kestrel-vault-7719",
    })
    assert response.status_code == 200
    assert client.post("/api/v1/auth/login", json={
        "username": "admin", "password": "kestrel-vault-7719",
    }).status_code == 200


def _create_session(client: TestClient) -> str:
    response = client.post("/api/v1/threads", json={
        "taskGoal": "demo task",
        "assignments": [{"agent": "claude"}],
        "workspacePath": "/workspace",
    })
    assert response.status_code == 201
    return response.json()["id"]


def _dispatched_run(
    app, session_id: str, *, lease_seconds: float = 60, node_id: str = "sbx_alice",
    owner_id: str = "alice",
) -> dict:
    """A run the daemon took and never reported back on."""
    registry = app.state.registry
    registry.register({
        "sandboxId": node_id, "userId": owner_id, "token": "node_token",
        "protocolVersion": 1, "supportedAgents": ["claude"], "status": "ready",
    })
    request = registry.daemon_store.create_run_request({
        "nodeId": node_id, "sessionId": session_id, "taskGoal": "work",
        "assignments": [{"executorKind": "claude"}], "state": {},
    })
    command = {
        "id": new_database_id(), "type": "run.start", "sessionId": session_id,
        "runId": new_database_id(), "agent": "claude", "taskGoal": "work",
        "_runRequestId": request["id"],
    }
    registry.daemon_store.update_run_request(request["id"], {
        "currentCommandId": command["id"], "currentRunId": command["runId"],
    })
    registry.daemon_store.enqueue_command(node_id, command)
    registry.daemon_store.take_queued_commands(node_id, lease_seconds=lease_seconds)
    SessionController(app.state.session_store).record_agent_started(session_id, {
        "runId": command["runId"], "agent": "claude",
    })
    return {"request": request, "command": command}


def _stop_requested_long_ago(app, request_id: str) -> None:
    """Age the stop request past the termination_unconfirmed threshold."""
    store = app.state.registry.daemon_store
    request = store.get_run_request(request_id)
    state = dict(request.get("state") or {})
    state["_relay_stop_command_id"] = "cmd_stop"
    state["_relay_stop_requested_at"] = "2020-01-01T00:00:00+00:00"
    store.update_run_request(request_id, {"state": state})


def test_execution_status_read_stays_scoped_with_a_long_transcript(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    session_id = _create_session(client)
    sessions = app.state.session_store
    SessionController(sessions).record_agent_started(session_id, {
        "runId": "legacy-running", "agent": "claude",
    })
    for sequence in range(64):
        sessions.append_event(session_id, relay_event("agent.output", session_id, {
            "runId": "legacy-running", "agent": "claude", "stream": "stdout",
            "text": "x" * 8192, "sequence": sequence,
        }), hydrate_events=False)

    queries = []

    def record_read(_conn, _cursor, statement, *_args):
        if statement.startswith("SELECT"):
            queries.append(statement)

    store = app.state.registry.daemon_store
    find_runs = store.list_active_runs
    run_scopes = []

    def record_scope(**options):
        run_scopes.append(options.get("session_ids"))
        return find_runs(**options)

    monkeypatch.setattr(store, "list_active_runs", record_scope)
    event.listen(sessions.engine, "before_cursor_execute", record_read)
    try:
        response = client.get(f"/api/v1/threads/{session_id}/execution")
    finally:
        event.remove(sessions.engine, "before_cursor_execute", record_read)

    assert response.status_code == 200
    assert response.json()["blockingReason"] == "orphaned_run"
    assert not any("session_events" in query for query in queries)
    assert sum("FROM sessions" in query for query in queries) == 1
    assert run_scopes == [{session_id}]


def test_delete_releases_an_execution_whose_computer_never_reported_exit(monkeypatch) -> None:
    """Deleting a thread whose execution Relay gave up on completes by itself.

    The delete is the operator's assertion that the agent is gone; asking them
    to also find the reconcile button served no one.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)
        _stop_requested_long_ago(app, run["request"]["id"])

        stuck = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert stuck["phase"] == "recovery_required"
        assert stuck["blockingReason"] == "termination_unconfirmed"
        assert stuck["canDelete"] is False
        assert stuck["canReportGone"] is True

        assert client.delete(f"/api/v1/threads/{session_id}?stop=true").status_code == 204

        assert client.get(f"/api/v1/threads/{session_id}").status_code == 404
        store = app.state.registry.daemon_store
        assert store.active_run_request_for_session_any_node(session_id) is None
        assert store.get_run_request(run["request"]["id"])["status"] == "cancelled"
        assert store.get_command(run["command"]["id"])["status"] == "cancelled"


def test_delete_releases_an_execution_whose_lease_lapsed_after_the_stop(monkeypatch) -> None:
    """A daemon that died mid-run also stops renewing its lease, so the run reads
    unresponsive rather than stopping. Once the stop grace has passed, that is
    the same dead end and the delete must still release it."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id, lease_seconds=-1)

        unconfirmed = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert unconfirmed["phase"] == "unresponsive"
        assert unconfirmed["canReportGone"] is False

        _stop_requested_long_ago(app, run["request"]["id"])
        stuck = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert stuck["phase"] == "recovery_required"
        assert stuck["blockingReason"] == "termination_unconfirmed"
        assert stuck["canReportGone"] is True

        assert client.delete(f"/api/v1/threads/{session_id}?stop=true").status_code == 204
        assert client.get(f"/api/v1/threads/{session_id}").status_code == 404
        assert app.state.registry.daemon_store.active_run_request_for_session_any_node(session_id) is None


def test_delete_starts_the_grace_when_no_stop_marker_could_be_recorded(monkeypatch) -> None:
    """The stop marker is only written for a running request. A delete that hits
    a delivered run in any other status must still start the clock itself."""
    from relay.execution import lifecycle as execution_lifecycle

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id, lease_seconds=-1)
        app.state.registry.daemon_store.update_run_request(run["request"]["id"], {"status": "dispatching"})

        assert client.delete(f"/api/v1/threads/{session_id}?stop=true").status_code == 202
        assert "_relay_stop_requested_at" not in (
            app.state.registry.daemon_store.get_run_request(run["request"]["id"]).get("state") or {}
        )

        monkeypatch.setattr(execution_lifecycle, "STOP_GRACE_SECONDS", 0)
        app.state.execution_lifecycle.tick()
        assert client.get(f"/api/v1/threads/{session_id}").status_code == 404
        assert app.state.registry.daemon_store.active_run_request_for_session_any_node(session_id) is None


def test_delete_releases_a_finalization_whose_evidence_was_lost(monkeypatch) -> None:
    """Retrying a save with no exit evidence only re-marks it lost, so the
    retry must not be the only way out; the delete asserts the run gone."""
    from relay.core.daemon_records import TERMINAL_CLAIM_ID_STATE_KEY

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)
        app.state.registry.daemon_store.update_run_request(run["request"]["id"], {
            "status": "finalizing",
            "state": {
                TERMINAL_CLAIM_ID_STATE_KEY: "claim_lost",
                "_relay_recovery_required": True,
                "_relay_recovery_reason": "missing_terminal_evidence",
            },
        })

        stuck = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert stuck["blockingReason"] == "missing_terminal_evidence"
        assert stuck["canRetrySave"] is False
        assert stuck["canReportGone"] is True

        assert client.delete(f"/api/v1/threads/{session_id}?stop=true").status_code == 204
        assert client.get(f"/api/v1/threads/{session_id}").status_code == 404
        assert app.state.registry.daemon_store.active_run_request_for_session_any_node(session_id) is None


@pytest.mark.parametrize("request_deletion", [False, True])
def test_late_terminal_evidence_is_protected_and_can_be_saved(monkeypatch, request_deletion) -> None:
    from relay.core.daemon_records import TERMINAL_CLAIM_ID_STATE_KEY

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)
        registry = app.state.registry
        store = registry.daemon_store
        store.update_run_request(run["request"]["id"], {
            "assignments": [{"assignmentId": "step_1", "executorKind": "claude"}],
            "status": "finalizing", "state": {
                TERMINAL_CLAIM_ID_STATE_KEY: "claim_lost",
                "_relay_recovery_required": True,
                "_relay_recovery_reason": "missing_terminal_evidence",
            },
        })
        event = {
            "type": "run.completed", "commandId": run["command"]["id"],
            "runId": run["command"]["runId"], "sessionId": session_id,
            "agent": "claude", "exitCode": 0, "agentLog": "late successful result",
        }
        assert store.mark_command_completed("sbx_alice", event)
        assert registry._claim_and_advance_run_request(event) is False

        status = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert status["canReportGone"] is False
        assert status["canRetrySave"] is True
        assert status["blockingReason"] == "finalization_failed"
        assert client.post(f"/api/v1/threads/{session_id}/execution/reconcile").status_code == 409
        if request_deletion:
            response = client.delete(f"/api/v1/threads/{session_id}?stop=true")
            assert response.status_code == 202
            assert response.json()["canReportGone"] is False
            assert store.get_run_request(run["request"]["id"])["status"] == "finalizing"

        assert client.post(f"/api/v1/threads/{session_id}/execution/recovery").status_code == 200
        registry.reap_stale_runs()
        session = app.state.session_store.get_session(session_id)
        agent_run = next(r for r in session["agentRuns"] if r["id"] == event["runId"])
        assert agent_run["status"] == "completed"
        assert agent_run["agentLog"] == "late successful result"
        assert not [e for e in session["events"] if e["type"] == "session.execution_reconciled"]
        assert store.active_run_request_for_session_any_node(session_id) is None
        if request_deletion:
            app.state.execution_lifecycle.tick()
            assert client.get(f"/api/v1/threads/{session_id}").status_code == 404


def test_delete_waits_out_the_stop_grace_before_asserting(monkeypatch) -> None:
    """A fresh stop still gets its chance to confirm: the daemon may be slow,
    not dead, so the assertion only stands in once recovery is required."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)

        response = client.delete(f"/api/v1/threads/{session_id}?stop=true")
        assert response.status_code == 202
        assert response.json()["phase"] == "stopping"
        assert client.get(f"/api/v1/threads/{session_id}").status_code == 200

        _stop_requested_long_ago(app, run["request"]["id"])
        app.state.execution_lifecycle.tick()
        assert client.get(f"/api/v1/threads/{session_id}").status_code == 404
        assert app.state.registry.daemon_store.active_run_request_for_session_any_node(session_id) is None


def test_delete_frees_an_orphaned_run_without_a_report(monkeypatch) -> None:
    """A legacy running-agent record with no run behind it blocks deletion the
    same way; the delete asserts it gone too."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        SessionController(app.state.session_store).record_agent_started(session_id, {
            "runId": "run_orphaned", "agent": "claude",
        })
        assert client.get(f"/api/v1/threads/{session_id}/execution").json()["blockingReason"] == "orphaned_run"

        assert client.delete(f"/api/v1/threads/{session_id}?stop=true").status_code == 204
        assert client.get(f"/api/v1/threads/{session_id}").status_code == 404


def test_reconcile_frees_an_orphaned_run_with_no_retained_evidence(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        # A legacy record: a running agent with no run request behind it.
        SessionController(app.state.session_store).record_agent_started(session_id, {
            "runId": "run_orphaned", "agent": "claude",
        })
        assert client.get(f"/api/v1/threads/{session_id}/execution").json()["blockingReason"] == "orphaned_run"

        assert client.post(f"/api/v1/threads/{session_id}/execution/reconcile").json()["canDelete"] is True

        session = client.get(f"/api/v1/threads/{session_id}").json()
        closed = [run for run in session["agentRuns"] if run["id"] == "run_orphaned"]
        assert closed and closed[0]["status"] == "cancelled"
        assert client.delete(f"/api/v1/threads/{session_id}").status_code == 204


def test_reconcile_records_who_asserted_the_execution_was_gone(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        SessionController(app.state.session_store).record_agent_started(session_id, {
            "runId": "run_orphaned", "agent": "claude",
        })

        client.post(f"/api/v1/threads/{session_id}/execution/reconcile")

        session = client.get(f"/api/v1/threads/{session_id}").json()
        asserted = [e for e in session["events"] if e["type"] == "session.execution_reconciled"]
        # Asserted death is a human claim, not observed evidence: it is written
        # to the log with its actor so the record never implies the daemon said so.
        assert len(asserted) == 1
        assert asserted[0]["actorUserId"]
        assert asserted[0]["blockingReason"] == "orphaned_run"


@pytest.mark.parametrize("phase", ["running", "terminal"])
def test_reconcile_refuses_anything_but_a_blocked_execution(monkeypatch, phase) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        if phase == "running":
            _dispatched_run(app, session_id)
        assert client.get(f"/api/v1/threads/{session_id}/execution").json()["phase"] == phase

        response = client.post(f"/api/v1/threads/{session_id}/execution/reconcile")

        # Asserting death for a live agent orphans a real process on someone's
        # machine. Only an execution Relay has already given up on qualifies.
        assert response.status_code == 409
        assert client.get(f"/api/v1/threads/{session_id}/execution").json()["phase"] == phase


def test_reconcile_is_idempotent(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        SessionController(app.state.session_store).record_agent_started(session_id, {
            "runId": "run_orphaned", "agent": "claude",
        })
        assert client.post(f"/api/v1/threads/{session_id}/execution/reconcile").status_code == 200

        # The second press is a no-op, not a second assertion in the log.
        repeat = client.post(f"/api/v1/threads/{session_id}/execution/reconcile")

        assert repeat.status_code == 409
        session = client.get(f"/api/v1/threads/{session_id}").json()
        assert len([e for e in session["events"] if e["type"] == "session.execution_reconciled"]) == 1


def test_reconcile_rejects_a_daemon_node_token(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        app.state.registry.register({
            "sandboxId": "sbx_alice", "userId": "alice", "token": "node_token",
            "protocolVersion": 1, "supportedAgents": ["claude"], "status": "ready",
        })

        # A node token authenticates a runtime, not a person. A daemon must not
        # be able to declare its own execution dead.
        anonymous = TestClient(app)
        response = anonymous.post(
            f"/api/v1/threads/{session_id}/execution/reconcile",
            headers={"Authorization": "Bearer node_token"},
        )

        assert response.status_code == 401


def test_reconcile_denies_an_user_who_does_not_own_the_thread(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        SessionController(app.state.session_store).record_agent_started(session_id, {
            "runId": "run_orphaned", "agent": "claude",
        })
        assert client.post("/api/v1/admin/accounts", json={
            "username": "mallory", "email": "mallory@example.com", "password": "harbour-kestrel-8823",
            "userId": "mallory", "displayName": "Mallory",
        }).status_code == 201
        other = TestClient(app)
        assert other.post("/api/v1/auth/login", json={
            "username": "mallory", "password": "harbour-kestrel-8823",
        }).status_code == 200

        response = other.post(f"/api/v1/threads/{session_id}/execution/reconcile")

        assert response.status_code == 403
        session = client.get(f"/api/v1/threads/{session_id}").json()
        assert not [e for e in session["events"] if e["type"] == "session.execution_reconciled"]


def test_reconcile_cannot_discard_a_retained_terminal_result(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)
        store = app.state.registry.daemon_store
        store.update_run_request(run["request"]["id"], {
            "status": "finalizing", "state": {
                "_relay_recovery_required": True,
                "_relay_terminal_claim_id": "saved-result",
            },
        })
        before = store.get_run_request(run["request"]["id"])
        status = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert status["canRetrySave"] is True
        assert status["canReportGone"] is False
        assert client.post(f"/api/v1/threads/{session_id}/execution/reconcile").status_code == 409
        assert store.get_run_request(run["request"]["id"]) == before


def test_online_heartbeat_is_separate_from_unconfirmed_exit_in_detail_and_list(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)
        _stop_requested_long_ago(app, run["request"]["id"])
        status = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert status["computerOnline"] is True
        assert status["canDelete"] is False
        detail = client.get(f"/api/v1/threads/{session_id}").json()
        assert detail["execution"]["computerOnline"] is True
        response = client.get("/api/v1/threads").json()
        listed = next(session for session in response["sessions"] if session["id"] == session_id)
        assert listed["execution"]["computerOnline"] is True
        assert listed["execution"]["canDelete"] is False


@pytest.mark.parametrize("view", ["summary", "records"])
def test_thread_list_with_offline_online_and_missing_computers(monkeypatch, tmp_path, view):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    path = "/api/v1/threads"
    params = {"view": view}
    assert client.get(path, params=params).status_code == 401
    _bootstrap(client)
    owner_id = client.get("/api/v1/auth/me").json()["user"]["userId"]

    offline, online, missing = [_create_session(client) for _ in range(3)]
    offline_node, online_node, missing_node = [new_database_id() for _ in range(3)]
    _dispatched_run(app, offline, node_id=offline_node, owner_id=owner_id, lease_seconds=1)
    _dispatched_run(app, online, node_id=online_node, owner_id=owner_id, lease_seconds=7200)
    _dispatched_run(app, missing, node_id=missing_node, owner_id=owner_id, lease_seconds=1)
    _clock_after(app, 3600)
    store = app.state.registry.daemon_store
    with store.engine.begin() as conn:
        conn.execute(update(store.nodes).where(store.nodes.c.id == offline_node).values(
            last_seen_at=datetime(2020, 1, 1, tzinfo=UTC),
        ))

    # Remove the Computer after the list has loaded its execution, so the
    # actual liveness query returns no observation for that Computer.
    lookup = store.get_node_liveness

    def lookup_after_removal(node_ids):
        assert missing_node in node_ids
        store.delete_node(missing_node)
        return lookup(node_ids)

    with monkeypatch.context() as scope:
        scope.setattr(store, "get_node_liveness", lookup_after_removal)
        response = client.get(path, params=params)

    assert response.status_code == 200, response.text
    body = response.json()
    ids = [row["id"] for row in body["sessions"]]
    assert set(ids) == {offline, online, missing}
    assert body["nextCursor"] is None
    execution = {row["id"]: row["execution"] for row in body["sessions"]}
    for thread_id, computer_online in ((offline, False), (missing, None)):
        assert execution[thread_id]["computerOnline"] is computer_online
        assert execution[thread_id]["phase"] == "recovery_required"
        assert execution[thread_id]["blockingReason"] == "execution_lost"
    assert execution[online]["computerOnline"] is True
    assert execution[online]["phase"] == "running"

    first = client.get(path, params={**params, "limit": 2})
    assert first.status_code == 200, first.text
    page = first.json()
    assert [row["id"] for row in page["sessions"]] == ids[:2]
    assert page["nextCursor"]
    last = client.get(path, params={**params, "limit": 2, "cursor": page["nextCursor"]})
    assert last.status_code == 200, last.text
    assert [row["id"] for row in last.json()["sessions"]] == ids[2:]
    assert last.json()["nextCursor"] is None


def _clock_after(app, seconds: float) -> None:
    """Advance the lifecycle's view of time past the command's lease."""
    later = datetime.now(UTC) + timedelta(seconds=seconds)
    app.state.execution_lifecycle.clock = lambda: later


def _computer_gone(app) -> None:
    app.state.registry.liveness_timeout_ms = -1


def test_a_dead_computer_run_becomes_reportable_after_the_unresponsive_window(monkeypatch) -> None:
    """A computer that died mid-run never sends exit evidence and never renews
    its lease. Once the lease has been dead long enough, the execution is one
    Relay has given up on, so a person may report it gone; before this, the
    run sat in `unresponsive` forever and reconcile refused it."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)
        _computer_gone(app)
        _clock_after(app, 60 + 11 * 60)

        status = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert status["phase"] == "recovery_required"
        assert status["blockingReason"] == "execution_lost"
        assert status["canReportGone"] is True

        assert client.post(f"/api/v1/threads/{session_id}/execution/reconcile").status_code == 200
        store = app.state.registry.daemon_store
        assert store.active_run_request_for_session_any_node(session_id) is None
        assert store.get_run_request(run["request"]["id"])["status"] == "cancelled"


def test_a_dead_lease_waits_out_the_unresponsive_window(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        _dispatched_run(app, session_id)
        _computer_gone(app)
        _clock_after(app, 60 + 5 * 60)

        status = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert status["phase"] == "unresponsive"
        assert status["canReportGone"] is False


def test_an_online_computer_with_a_dead_lease_stays_unresponsive(monkeypatch) -> None:
    """Liveness alone is not exit evidence: a computer that is still talking
    to Relay may yet report on the run, so it is never offered as gone."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        _dispatched_run(app, session_id)
        _clock_after(app, 60 + 11 * 60)

        status = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert status["phase"] == "unresponsive"
        assert status["canReportGone"] is False
        assert client.post(f"/api/v1/threads/{session_id}/execution/reconcile").status_code == 409


def test_an_unconfirmed_stop_on_a_dead_lease_escalates_after_the_grace(monkeypatch) -> None:
    """The stop grace used to need a live lease, so a stop sent to a computer
    that had already died never escalated."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)
        _stop_requested_long_ago(app, run["request"]["id"])
        _clock_after(app, 120)

        status = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert status["phase"] == "recovery_required"
        assert status["blockingReason"] == "termination_unconfirmed"
        assert status["canReportGone"] is True


def test_delete_releases_a_run_whose_computer_died(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        _dispatched_run(app, session_id)

        response = client.delete(f"/api/v1/threads/{session_id}?stop=true")
        assert response.status_code == 202
        # The computer dies with the stop unacknowledged: the lease lapses
        # and the stop grace runs out with no live lease behind it.
        _computer_gone(app)
        _clock_after(app, 60 + 61)
        app.state.execution_lifecycle.tick()

        assert client.get(f"/api/v1/threads/{session_id}").status_code == 404
        assert app.state.registry.daemon_store.active_run_request_for_session_any_node(session_id) is None


def test_a_restarted_daemon_names_the_run_it_will_not_resume(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        run = _dispatched_run(app, session_id)

        response = TestClient(app).post("/api/v1/daemon-node-registrations", json={
            "sandboxId": "sbx_alice", "token": "node_token", "protocolVersion": 1,
            "supportedAgents": ["claude"], "status": "ready",
            "capabilities": ["execution-journal-report"],
            "journaledCommandIds": [run["command"]["id"]],
        })

        assert response.status_code == 200
        assert response.json()["acknowledgedJournalIds"] == [run["command"]["id"]]
        status = client.get(f"/api/v1/threads/{session_id}/execution").json()
        assert status["blockingReason"] == "execution_interrupted"
        assert status["canReportGone"] is True
