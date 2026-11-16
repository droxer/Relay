"""Real owner API -> durable command admission for the frozen first step."""
from uuid import uuid4

import pytest

from test_team_workflows import workflow_world


def test_start_waits_for_poll_node_scope_without_holding_database_writer(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import contextmanager
    from threading import Event
    from fastapi.testclient import TestClient
    from relay.api.agents import workflow_gates

    with workflow_world(monkeypatch) as (app, client, here, _, _, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        node_requested, writer_acquired = Event(), Event()
        registry = app.state.registry
        original_scope = registry.dispatch_scope
        original_transaction = workflow_gates.resource_transaction

        @contextmanager
        def observed_scope(ids):
            node_requested.set()
            with original_scope(ids):
                yield

        @contextmanager
        def observed_transaction(*args):
            with original_transaction(*args) as connection:
                writer_acquired.set()
                yield connection

        monkeypatch.setattr(registry, "dispatch_scope", observed_scope)
        monkeypatch.setattr(workflow_gates, "resource_transaction", observed_transaction)

        def start():
            peer = TestClient(app)
            peer.cookies.update(client.cookies)
            return peer.post(f"/api/v1/teams/{team['id']}/workflow-runs", json={
                "requestId": str(uuid4()), "taskGoal": "Start while a poll writes",
            })

        with ThreadPoolExecutor(max_workers=1) as pool:
            # A poll owns the node first, then writes liveness. A start must
            # wait for that scope before reserving SQLite's sole writer.
            with original_scope([here["id"]]):
                future = pool.submit(start)
                assert node_requested.wait(3), "Start did not reach the node scope"
                assert not writer_acquired.is_set(), "Start blocks the poll's database write"
                app.state.daemon_store.update_node_display_name(here["id"], "Poll remained writable")
            response = future.result(timeout=5)
        assert response.status_code == 201, response.text


def test_older_round_result_client_cannot_start_a_workflow(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, here, _, _, payload):
        app.state.registry.register({
            **here, "sandboxId": here["id"], "token": "token_node_here",
            "protocolVersion": 1, "supportedAgents": ["codex", "claude"],
            "capabilities": [item for item in here["capabilities"] if item != "workflow-results"],
        })
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        response = client.post(f"/api/v1/teams/{team['id']}/workflow-runs", json={
            "requestId": str(uuid4()), "taskGoal": "Must wait for client update",
        })
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == "workflow_result_client_update_required"
        assert app.state.registry.take_commands(here["id"], "token_node_here") == []


@pytest.mark.parametrize("gated", [False, True])
def test_first_step_admission(monkeypatch, gated):
    with workflow_world(monkeypatch) as (app, client, here, _, _, payload):
        payload["workflowSteps"][0]["requiresApproval"] = gated
        created = client.post("/api/v1/teams", json=payload)
        assert created.status_code == 201, created.text
        team = created.json()["team"]
        url = f"/api/v1/teams/{team['id']}/workflow-runs"
        body = {"requestId": str(uuid4()), "taskGoal": "Design and deploy"}
        response = client.post(url, json=body)
        assert response.status_code == 201, response.text
        session = response.json()
        request = app.state.daemon_store.active_run_request_for_session_any_node(session["id"])
        assert request is not None
        if gated:
            assert app.state.registry.take_commands(here["id"], "token_node_here") == []
            first = session["workflowRuns"][0]["assignments"][0]
            decision = {key: first[key] for key in ("workflowRunId", "workflowStepId", "workflowAttempt", "assignmentId")}
            decision.update(kind="approve", expectedRevision=0)
            response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision)
            assert response.status_code == 200, response.text
            assert client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision).status_code == 409
        commands = app.state.registry.take_commands(here["id"], "token_node_here")
        assert len(commands) == 1
        assert commands[0]["type"] == "run.start"
        assert commands[0]["assignmentId"] == session["workflowRuns"][0]["assignments"][0]["assignmentId"]
        request = app.state.daemon_store.active_run_request_for_session_any_node(session["id"])
        assert request["currentCommandId"] == commands[0]["id"]
        replay = client.post(url, json=body)
        assert replay.status_code == 201, replay.text
        assert len(app.state.session_store.get_session(session["id"])["agentRuns"]) == 1


def test_concurrent_approval_restart_and_missing_result_blocks(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi.testclient import TestClient
    from relay.daemon_registry.registry import DaemonNodeRegistry
    from test_workflow_decisions import waiting_gate, endpoint

    with waiting_gate(monkeypatch) as (app, client, here, _, sid, body):
        def approve(_):
            peer = TestClient(app)
            peer.cookies.update(client.cookies)
            return peer.post(endpoint(sid), json=body).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(approve, range(2))) == [200, 409]
        restarted = DaemonNodeRegistry(app.state.session_store, app.state.daemon_store,
                                      project_store=app.state.project_store)
        restarted.reap_stale_runs()
        commands = restarted.take_commands(here["id"], "token_node_here")
        assert len(commands) == 1
        # A linked request is idempotent even in a new registry with no live callbacks.
        restarted.admit_workflow_first_step(sid, validate=lambda _: pytest.fail("duplicate re-admitted"))
        assert len(app.state.session_store.get_session(sid)["agentRuns"]) == 1
        command = commands[0]
        event = {"type": "run.completed", "commandId": command["id"],
                 "sessionId": sid, "runId": command["runId"], "agent": command["agent"],
                 "exitCode": 0, "agentLog": "Done", "leaseId": command.get("leaseId")}
        restarted.handle_event(here["id"], event, "token_node_here")
        restarted.reap_stale_runs()
        assert restarted.take_commands(here["id"], "token_node_here") == []
        request = app.state.daemon_store.active_run_request_for_session_any_node(sid)
        assert request["currentIndex"] == 0
        assert request.get("currentCommandId") is None
        assert app.state.session_store.get_session(sid)["workflowRuns"][0]["status"] == "blocked"


@pytest.mark.parametrize("change", ["binding", "assignment", "index", "cancelled"])
def test_mismatched_durable_request_cannot_approve(monkeypatch, change):
    from test_workflow_decisions import waiting_gate, endpoint
    with waiting_gate(monkeypatch) as (app, client, here, _, sid, body):
        request = app.state.daemon_store.active_run_request_for_session_any_node(sid)
        patch = {"binding": {"state": {}}, "index": {"currentIndex": 1},
                 "cancelled": {"status": "cancelled"},
                 "assignment": {"assignments": list(reversed(request["assignments"]))}}[change]
        app.state.daemon_store.update_run_request(request["id"], patch)
        before = app.state.session_store.get_session(sid)
        response = client.post(endpoint(sid), json=body)
        assert response.status_code == 409, response.text
        assert app.state.session_store.get_session(sid) == before
        assert app.state.registry.take_commands(here["id"], "token_node_here") == []


def test_publication_failure_rolls_back_decision_and_command(monkeypatch):
    from test_workflow_decisions import waiting_gate, endpoint
    with waiting_gate(monkeypatch) as (app, client, here, _, sid, body):
        before = app.state.session_store.get_session(sid)
        def fail(*args, **kwargs):
            raise ValueError("injected publication failure")
        with monkeypatch.context() as patch:
            patch.setattr(app.state.daemon_store, "publish_command", fail)
            response = client.post(endpoint(sid), json=body)
        assert response.status_code == 409
        assert app.state.session_store.get_session(sid) == before
        request = app.state.daemon_store.active_run_request_for_session_any_node(sid)
        assert request["status"] == "prepared"
        assert not request.get("currentCommandId")
        assert app.state.daemon_store.pending_command_for_run_request(request["id"]) is None
        assert app.state.registry.take_commands(here["id"], "token_node_here") == []
        assert client.post(endpoint(sid), json=body).status_code == 200
        assert len(app.state.registry.take_commands(here["id"], "token_node_here")) == 1


def test_pending_gate_cannot_admit_or_expire_on_restart(monkeypatch):
    from relay.daemon_registry.registry import DaemonNodeRegistry
    from test_workflow_decisions import waiting_gate
    with waiting_gate(monkeypatch) as (app, _, here, _, sid, _):
        request = app.state.daemon_store.active_run_request_for_session_any_node(sid)
        restarted = DaemonNodeRegistry(app.state.session_store, app.state.daemon_store,
                                      project_store=app.state.project_store)
        with pytest.raises(ValueError, match="workflow_gate_closed"):
            restarted.admit_workflow_first_step(sid, validate=lambda _: pytest.fail("unapproved admission"))
        # An arbitrarily expired legacy admission lease must not close an owner gate.
        restarted._recover_prepared_request_unlocked({**request, "updatedAt": "2000-01-01T00:00:00Z"})
        assert app.state.daemon_store.get_run_request(request["id"])["status"] == "prepared"
        assert restarted.take_commands(here["id"], "token_node_here") == []
        assert app.state.daemon_store.list_active_runs(here["id"]) == []


def test_changed_assignee_computer_refuses_approval(monkeypatch):
    from test_workflow_decisions import waiting_gate, endpoint
    with waiting_gate(monkeypatch) as (app, client, here, project, sid, body):
        for placement in app.state.agent_placement_store.list_placements(agent_id=project["members"][0]["agentId"]):
            app.state.agent_placement_store.rebind_placement(
                placement["id"], "node_there", computer_id_value="node:node_there",
            )
        before = app.state.session_store.get_session(sid)
        response = client.post(endpoint(sid), json=body)
        assert response.status_code == 409, response.text
        assert app.state.session_store.get_session(sid) == before
        assert app.state.registry.take_commands(here["id"], "token_node_here") == []
