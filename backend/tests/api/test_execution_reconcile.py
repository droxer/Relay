"""An unrecoverable execution must have a way out that a person can reach.

Deletion waits for exit evidence, and evidence only ever arrived from the
daemon. When the machine is gone, nothing produces it. Two assertions release
such an execution: deleting the thread asserts it for the thread (the delete
completes once recovery is required), and the reconcile endpoint asserts it
for the node, whose deletion the stuck request would otherwise block as
active work. These tests pin both paths and their limits.
"""
from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.persistence.store_common import new_database_id
from relay.sessions.controller import SessionController


def _bootstrap(client: TestClient) -> None:
    response = client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token",
        "username": "admin",
        "password": "kestrel-vault-7719",
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


def _dispatched_run(app, session_id: str) -> dict:
    """A run the daemon took and never reported back on."""
    registry = app.state.registry
    registry.register({
        "sandboxId": "sbx_alice", "employeeId": "alice", "token": "node_token",
        "protocolVersion": 1, "supportedAgents": ["claude"], "status": "ready",
    })
    request = registry.daemon_store.create_run_request({
        "nodeId": "sbx_alice", "sessionId": session_id, "taskGoal": "work",
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
    registry.daemon_store.enqueue_command("sbx_alice", command)
    registry.daemon_store.take_queued_commands("sbx_alice", lease_seconds=60)
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
        assert asserted[0]["actorEmployeeId"]
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
            "sandboxId": "sbx_alice", "employeeId": "alice", "token": "node_token",
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


def test_reconcile_denies_an_employee_who_does_not_own_the_thread(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        SessionController(app.state.session_store).record_agent_started(session_id, {
            "runId": "run_orphaned", "agent": "claude",
        })
        assert client.post("/api/v1/admin/users", json={
            "username": "mallory", "password": "harbour-kestrel-8823",
            "employeeId": "mallory", "displayName": "Mallory",
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


def _clock_after(app, seconds: float) -> None:
    """Advance the lifecycle's view of time past the command's lease."""
    from datetime import datetime, timedelta, timezone

    later = datetime.now(timezone.utc) + timedelta(seconds=seconds)
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
