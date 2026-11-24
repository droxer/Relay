"""Real registry/API workflow execution, outputs, gates and owner recovery."""
from copy import deepcopy
from uuid import uuid4

import pytest

from relay.persistence.session.reducer import materialize_events
from test_team_workflows import workflow_world


def start(client, payload):
    response = client.post("/api/v1/teams", json=payload)
    assert response.status_code == 201, response.text
    response = client.post(f"/api/v1/teams/{response.json()['team']['id']}/workflow-runs",
                           json={"requestId": str(uuid4()), "taskGoal": "Four steps"})
    assert response.status_code == 201, response.text
    return response.json()


def decision(session, kind):
    run = session["workflowRuns"][-1]  # the live run; a Task started again appends one
    step = run["assignments"][run["currentIndex"]]
    return {**{key: step[key] for key in ("workflowRunId", "workflowStepId", "workflowAttempt", "assignmentId")},
            "kind": kind, "expectedRevision": run["revision"]}


def finish(registry, node, command, outputs, **patch):
    event = {"type": "run.completed", "commandId": command["id"],
             "sessionId": command["sessionId"], "runId": command["runId"], "agent": command["agent"],
             "exitCode": 0, "agentLog": "Done", "leaseId": command.get("leaseId"),
             "roundResult": {"runId": command["runId"], "status": "done", "work": {
                 "status": "done", "evidence": ["Verified"], "outputs": outputs}}, **patch}
    registry.handle_event(node["id"], event, "token_node_here")
    return event


def take(registry, node):
    return registry.take_commands(node["id"], "token_node_here")


def test_four_steps_repeated_agent_outputs_gate_and_replay(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        design, deploy = payload["workflowSteps"]
        build = {**deepcopy(design), "id": "build", "name": "Build", "agentId": payload["memberAgentIds"][1],
                 "expectedOutputs": ["Build"]}
        verify = {**deepcopy(design), "id": "verify", "name": "Verify", "expectedOutputs": ["Tests"]}
        payload["workflowSteps"] = [design, build, verify, deploy]
        session = start(client, payload)
        sid = session["id"]
        registry = app.state.registry
        edited = client.patch(f"/api/v1/teams/{session['teamId']}", json={"workflowSteps": list(reversed(payload["workflowSteps"]))})
        assert edited.status_code == 200, edited.text
        for index, output in enumerate(("Design", "Build", "Tests", "URL")):
            if index == 3:
                assert take(registry, node) == []
                session = app.state.session_store.get_session(sid)
                assert session["workflowRuns"][0]["status"] == "awaiting_approval"
                body = decision(session, "approve")
                response = client.post(f"/api/v1/threads/{sid}/workflow-decisions", json=body)
                assert response.status_code == 200, response.text
                assert client.post(f"/api/v1/threads/{sid}/workflow-decisions", json=body).status_code == 409
            commands = take(registry, node)
            assert len(commands) == 1
            command = commands[0]
            assert command["assignmentId"] == session["workflowRuns"][0]["assignments"][index]["assignmentId"]
            assert command["logicalAgentId"] == session["workflowRuns"][0]["assignments"][index]["agentId"]
            if index:
                assert f"recorded-{index - 1}" in command["state"]["assignment_brief"]
            event = finish(registry, node, command, {output: f"recorded-{index}"})
            registry.handle_event(node["id"], event, "token_node_here")
        session = app.state.session_store.get_session(sid)
        assert session["status"] == "completed"
        assert len(session["agentRuns"]) == 4
        assert [r["status"] for r in session["workflowRuns"][0]["attemptResults"]] == ["succeeded"] * 4
        assert materialize_events(session["events"])["workflowRuns"] == session["workflowRuns"]
        assert take(registry, node) == []


@pytest.mark.parametrize("failure", ["missing", "structured", "exit"])
def test_unsuccessful_step_blocks_successor(monkeypatch, failure):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        command, = take(app.state.registry, node)
        patch = {"roundResult": None} if failure == "missing" else {"exitCode": 1} if failure == "exit" else {
            "roundResult": {"runId": command["runId"], "status": "blocked", "work": {"status": "blocked"}}}
        finish(app.state.registry, node, command, {}, **patch)
        current = app.state.session_store.get_session(session["id"])
        assert current["workflowRuns"][0]["status"] == "blocked"
        assert current["workflowRuns"][0]["currentIndex"] == 0
        app.state.registry.reap_stale_runs()
        assert take(app.state.registry, node) == []
        assert app.state.daemon_store.list_active_runs(node["id"]) == []


def test_owner_retry_allocates_attempt_and_stale_decision_cannot_duplicate(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        sid = session["id"]
        command, = take(app.state.registry, node)
        url = f"/api/v1/threads/{sid}/workflow-decisions"
        assert client.post(url, json=decision(session, "retry")).status_code == 409
        assert len(app.state.daemon_store.list_active_runs(node["id"])) == 1
        finish(app.state.registry, node, command, {})
        session = app.state.session_store.get_session(sid)
        body = decision(session, "retry")
        response = client.post(url, json=body)
        assert response.status_code == 200, response.text
        assert response.json()["execution"]["phase"] == "queued"
        assert client.post(url, json=body).status_code == 409
        retried, = take(app.state.registry, node)
        assert retried["assignmentId"] != command["assignmentId"]
        assert response.json()["workflowRuns"][0]["assignments"][0]["workflowAttempt"] == 2
        finish(app.state.registry, node, retried, {"Design": "retry output"})
        current = app.state.session_store.get_session(sid)
        assert current["workflowRuns"][0]["status"] == "awaiting_approval"
        assert [item["status"] for item in current["workflowRuns"][0]["attemptResults"]] == ["blocked", "succeeded"]


def test_rejected_gate_retry_requires_fresh_attempt_approval(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        payload["workflowSteps"][0]["requiresApproval"] = True
        session = start(client, payload)
        url = f"/api/v1/threads/{session['id']}/workflow-decisions"
        old = decision(session, "approve")
        response = client.post(url, json=decision(session, "reject"))
        assert response.status_code == 200
        response = client.post(url, json=decision(response.json(), "retry"))
        assert response.status_code == 200, response.text
        assert response.json()["workflowRuns"][0]["status"] == "awaiting_approval"
        assert take(app.state.registry, node) == []
        assert client.post(url, json=old).status_code == 409
        approval = decision(response.json(), "approve")
        response = client.post(url, json=approval)
        assert response.status_code == 200, response.text
        assert len(take(app.state.registry, node)) == 1


def test_cancel_preserves_delivered_reservation_until_late_exit(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        command, = take(app.state.registry, node)
        url = f"/api/v1/threads/{session['id']}/workflow-decisions"
        response = client.post(url, json=decision(session, "cancel"))
        assert response.status_code == 200, response.text
        assert response.json()["workflowRuns"][0]["status"] == "cancelled"
        assert len(app.state.daemon_store.list_active_runs(node["id"])) == 1
        assert client.post(url, json=decision(response.json(), "retry")).status_code == 409
        assert all(cmd["type"] == "run.cancel" for cmd in take(app.state.registry, node))
        finish(app.state.registry, node, command, {"Design": "late success"})
        assert app.state.daemon_store.list_active_runs(node["id"]) == []
        assert take(app.state.registry, node) == []
        assert app.state.session_store.get_session(session["id"])["status"] == "cancelled"


def test_reconciliation_is_audited_and_requires_explicit_retry(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        sid = session["id"]
        command, = take(app.state.registry, node)
        app.state.registry.handle_event(node["id"], {
            "type": "run.exit_unconfirmed", "commandId": command["id"], "sessionId": sid,
            "runId": command["runId"], "agent": command["agent"], "reason": "Cannot confirm process exit",
            "leaseId": command.get("leaseId"),
        }, "token_node_here")
        url = f"/api/v1/threads/{sid}/workflow-decisions"
        assert client.post(url, json=decision(session, "retry")).status_code == 409
        assert len(app.state.daemon_store.list_active_runs(node["id"])) == 1
        response = client.post(f"/api/v1/threads/{sid}/execution/reconcile")
        assert response.status_code == 200, response.text
        session = app.state.session_store.get_session(sid)
        assert session["status"] == "running"
        assert session["workflowRuns"][0]["status"] == "blocked"
        assert any(event["type"] == "session.execution_reconciled" and event["actorUserId"] == session["ownerUserId"]
                   for event in session["events"])
        assert take(app.state.registry, node) == []
        response = client.post(url, json=decision(session, "retry"))
        assert response.status_code == 200, response.text
        retried, = take(app.state.registry, node)
        assert retried["assignmentId"] != command["assignmentId"]
        finish(app.state.registry, node, command, {"Design": "stale report"})
        assert len(app.state.daemon_store.list_active_runs(node["id"])) == 1


@pytest.mark.parametrize("change", ["member", "placement", "disabled"])
def test_successor_live_admission_stops_after_roster_change(monkeypatch, change):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        payload["workflowSteps"][1]["requiresApproval"] = False
        session = start(client, payload)
        command, = take(app.state.registry, node)
        agent_id = payload["leadAgentId"]
        if change == "member":
            app.state.project_store.update_project(project["id"], {"members": []}, expected_version=project["version"])
        elif change == "disabled":
            app.state.agent_store.update_agent(agent_id, {"enabled": False})
        else:
            for placement in app.state.agent_placement_store.list_placements(agent_id=agent_id):
                app.state.agent_placement_store.rebind_placement(placement["id"], "node_there", computer_id_value="node:node_there")
        finish(app.state.registry, node, command, {"Design": "recorded"})
        session = app.state.session_store.get_session(session["id"])
        assert session["workflowRuns"][0]["status"] == "blocked"
        assert session["workflowRuns"][0]["currentIndex"] == 1
        assert session["workflowRuns"][0]["admissionError"]
        assert take(app.state.registry, node) == []
        assert client.post(f"/api/v1/threads/{session['id']}/workflow-decisions",
                           json=decision(session, "cancel")).status_code == 200


def test_restart_between_terminal_commit_and_successor_admission(monkeypatch):
    from relay.daemon_registry.registry import DaemonNodeRegistry
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        payload["workflowSteps"][1]["requiresApproval"] = False
        session = start(client, payload)
        command, = take(app.state.registry, node)
        with monkeypatch.context() as patch:
            patch.setattr(app.state.registry, "_resume_workflow_admission", lambda _: None)
            finish(app.state.registry, node, command, {"Design": "durable design"})
        restarted = DaemonNodeRegistry(app.state.session_store, app.state.daemon_store,
                                      project_store=app.state.project_store)
        restarted.logical_assignment_validator = app.state.registry.logical_assignment_validator
        # A fresh authenticated poll revives a stopped observation after restart.
        assert take(restarted, node) == []
        # Recovery leases last five seconds across replicas; advance only its clock.
        from datetime import datetime, UTC, timedelta
        monkeypatch.setattr("relay.persistence.daemon.run_requests.now_iso",
                            lambda: (datetime.now(UTC) + timedelta(seconds=10)).isoformat())
        restarted.reap_stale_runs()
        restarted.reap_stale_runs()
        restored = app.state.session_store.get_session(session["id"])
        assert restored["workflowRuns"][0]["status"] == "ready", restored["workflowRuns"][0].get("admissionError")
        successor, = take(restarted, node)
        assert "durable design" in successor["state"]["assignment_brief"]
        assert len(app.state.session_store.get_session(session["id"])["agentRuns"]) == 2


def test_successor_gate_publication_rollback_and_concurrent_decisions(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi.testclient import TestClient
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        sid = session["id"]
        command, = take(app.state.registry, node)
        finish(app.state.registry, node, command, {"Design": "recorded"})
        session = app.state.session_store.get_session(sid)
        body = decision(session, "approve")
        url = f"/api/v1/threads/{sid}/workflow-decisions"
        def fail(*args, **kwargs):
            raise ValueError("publication interrupted")
        with monkeypatch.context() as patch:
            patch.setattr(app.state.daemon_store, "publish_command", fail)
            assert client.post(url, json=body).status_code == 409
        assert app.state.session_store.get_session(sid) == session
        assert take(app.state.registry, node) == []
        def approve(_):
            peer = TestClient(app)
            peer.cookies.update(client.cookies)
            return peer.post(url, json=body).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(approve, range(2))) == [200, 409]
        assert len(take(app.state.registry, node)) == 1


def test_existing_stop_route_projects_cancel_after_exit(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        sid = session["id"]
        command, = take(app.state.registry, node)
        response = client.post(f"/api/v1/threads/{sid}/cancellations", json={})
        assert response.status_code == 202, response.text
        assert len(app.state.daemon_store.list_active_runs(node["id"])) == 1
        finish(app.state.registry, node, command, {"Design": "late success"})
        session = app.state.session_store.get_session(sid)
        assert session["status"] == "cancelled"
        assert session["workflowRuns"][0]["status"] == "cancelled"
        assert not [command for command in take(app.state.registry, node) if command["type"] == "run.start"]


@pytest.mark.parametrize("kind", ["retry", "cancel"])
def test_recovery_rejects_service_credentials(monkeypatch, kind):
    from fastapi.testclient import TestClient
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        command, = take(app.state.registry, node)
        finish(app.state.registry, node, command, {})
        session = app.state.session_store.get_session(session["id"])
        peer = TestClient(app)
        peer.headers.update({"Authorization": "Bearer chat-test", "x-relay-user-id": session["ownerUserId"]})
        response = peer.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision(session, kind))
        assert response.status_code == 403, response.text
        assert app.state.session_store.get_session(session["id"]) == session


def test_concurrent_retries_dispatch_exactly_one_attempt(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi.testclient import TestClient
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        command, = take(app.state.registry, node)
        finish(app.state.registry, node, command, {})
        session = app.state.session_store.get_session(session["id"])
        body = decision(session, "retry")
        def retry(_):
            peer = TestClient(app)
            peer.cookies.update(client.cookies)
            return peer.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=body).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(retry, range(2))) == [200, 409]
        assert len(take(app.state.registry, node)) == 1


def test_restart_waits_for_live_poll_without_blocking_or_repair(monkeypatch):
    from datetime import datetime, UTC, timedelta
    from relay.daemon_registry.registry import DaemonNodeRegistry
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        payload["workflowSteps"][1]["requiresApproval"] = False
        session = start(client, payload)
        command, = take(app.state.registry, node)
        with monkeypatch.context() as patch:
            patch.setattr(app.state.registry, "_resume_workflow_admission", lambda _: None)
            finish(app.state.registry, node, command, {"Design": "durable output"})
        restarted = DaemonNodeRegistry(app.state.session_store, app.state.daemon_store,
                                      project_store=app.state.project_store)
        restarted.logical_assignment_validator = app.state.registry.logical_assignment_validator
        future = datetime.now(UTC) + timedelta(seconds=10)
        monkeypatch.setattr("relay.persistence.daemon.run_requests.now_iso", lambda: future.isoformat())
        restarted.reap_stale_runs()
        waiting = app.state.session_store.get_session(session["id"])
        assert waiting["status"] == "running"
        assert waiting["workflowRuns"][0]["status"] == "ready"
        assert len(waiting["agentRuns"]) == 1
        assert take(restarted, node) == []
        future += timedelta(seconds=10)
        restarted.reap_stale_runs()
        successor, = take(restarted, node)
        assert "durable output" in successor["state"]["assignment_brief"]


@pytest.mark.parametrize("failure", ["raise", "false"])
def test_successor_publication_failure_in_joined_transaction_leaves_no_command(monkeypatch, failure):
    from relay.persistence.engine import store_transaction
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        payload["workflowSteps"][1]["requiresApproval"] = False
        session = start(client, payload)
        command, = take(app.state.registry, node)
        def refuse(*args, **kwargs):
            if failure == "raise":
                raise ValueError("publication failed")
            return False
        with monkeypatch.context() as patch:
            patch.setattr(app.state.daemon_store, "publish_command", refuse)
            # Durable report ingestion can own an outer database transaction.
            with store_transaction(app.state.daemon_store.engine):
                finish(app.state.registry, node, command, {"Design": "recorded"})
        session = app.state.session_store.get_session(session["id"])
        assert session["workflowRuns"][0]["status"] == "blocked"
        assert len(session["agentRuns"]) == 1
        request = app.state.daemon_store.active_run_request_for_session_any_node(session["id"])
        assert not request.get("currentCommandId")
        assert app.state.daemon_store.pending_command_for_run_request(request["id"]) is None
        assert take(app.state.registry, node) == []


def test_criteria_only_steps_advance_without_named_outputs(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        for step in payload["workflowSteps"]:
            del step["expectedOutputs"]
            step["requiresApproval"] = False
        session = start(client, payload)
        for _ in payload["workflowSteps"]:
            command, = take(app.state.registry, node)
            assert "Required output names:" not in command["state"]["assignment_brief"]
            finish(app.state.registry, node, command, {})
        completed = app.state.session_store.get_session(session["id"])
        assert completed["status"] == "completed"
        assert all(result["status"] == "succeeded" for result in completed["workflowRuns"][0]["attemptResults"])


def ask(registry, node, command, question="Deploy to staging or production?", options=None):
    return finish(registry, node, command, {}, roundResult={
        "runId": command["runId"], "status": "blocked", "note": question,
        **({"options": options} if options else {})})


def answer(session, text):
    return {**decision(session, "answer"), "answer": text}


def test_step_question_waits_for_owner_and_resumes_with_answer(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        session = start(client, payload)
        sid = session["id"]
        url = f"/api/v1/threads/{sid}/workflow-decisions"
        command, = take(app.state.registry, node)
        ask(app.state.registry, node, command, options=["Staging", "Production"])
        session = app.state.session_store.get_session(sid)
        run = session["workflowRuns"][0]
        assert run["status"] == "awaiting_input"
        assert run["currentIndex"] == 0
        assert run["attemptResults"][-1]["status"] == "question"
        assert run["attemptResults"][-1]["question"] == "Deploy to staging or production?"
        assert run["attemptResults"][-1]["options"] == ["Staging", "Production"]
        assert take(app.state.registry, node) == []
        assert client.post(url, json=decision(session, "retry")).status_code == 409
        assert client.post(url, json={**decision(session, "answer"), "answer": "  "}).status_code == 400
        body = answer(session, "Staging")
        response = client.post(url, json=body)
        assert response.status_code == 200, response.text
        assert response.json()["execution"]["phase"] == "queued"
        assert client.post(url, json=body).status_code == 409
        resumed, = take(app.state.registry, node)
        assert resumed["assignmentId"] != command["assignmentId"]
        assert "Deploy to staging or production?" in resumed["state"]["assignment_brief"]
        assert "Staging" in resumed["state"]["assignment_brief"]
        finish(app.state.registry, node, resumed, {"Design": "recorded"})
        session = app.state.session_store.get_session(sid)
        run = session["workflowRuns"][0]
        assert run["currentIndex"] == 1
        assert [item["status"] for item in run["attemptResults"]] == ["question", "succeeded"]
        assert materialize_events(session["events"])["workflowRuns"] == session["workflowRuns"]


def test_answer_resumes_gated_step_without_second_approval(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, _, payload):
        payload["workflowSteps"][0]["requiresApproval"] = True
        session = start(client, payload)
        url = f"/api/v1/threads/{session['id']}/workflow-decisions"
        response = client.post(url, json=decision(session, "approve"))
        assert response.status_code == 200, response.text
        command, = take(app.state.registry, node)
        ask(app.state.registry, node, command)
        session = app.state.session_store.get_session(session["id"])
        response = client.post(url, json=answer(session, "Production, after the smoke test"))
        assert response.status_code == 200, response.text
        assert response.json()["workflowRuns"][0]["status"] == "ready"
        assert len(take(app.state.registry, node)) == 1


def test_question_parks_linked_task_for_its_owner(monkeypatch):
    from relay.daemon_registry.dispatch.workflow_tasks import sync_workflow_task
    calls = []
    monkeypatch.setattr("relay.daemon_registry.dispatch.workflow_tasks.SessionController._update_task_status",
                        lambda self, status, message, extra: calls.append(status))
    registry = type("R", (), {"task_store": type("T", (), {"get_task_record": lambda self, _id: {"status": "assigned", "executionOwner": None}})(),
                               "store": None})()
    monkeypatch.setattr("relay.daemon_registry.dispatch.workflow_tasks.request_execution_owner", lambda request: None)
    sync_workflow_task(registry, {"taskId": "task"}, {"id": "s", "workflowRuns": [{"status": "awaiting_input", "currentIndex": 0,
        "assignments": [{"assignmentId": "a"}], "attemptResults": [{"assignmentId": "a", "runId": "r",
        "status": "question", "question": "Which region?"}]}]})
    assert calls == ["waiting_for_human"]


@pytest.mark.parametrize("exit_kind", ["answer", "cancel"])
def test_workflow_question_projects_task_wait_and_clears_it(monkeypatch, exit_kind):
    from relay.daemon_registry.dispatch.workflow_admission import workflow_request_id
    from relay.daemon_registry.dispatch.workflow_tasks import sync_workflow_task

    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        workflow = client.post("/api/v1/workflows", json={
            "name": "Ship pipeline", "projectId": project["id"],
            "workflowSteps": payload["workflowSteps"],
        }).json()["workflow"]
        response = client.post("/api/v1/tasks", json={
            "title": "Ship workflow", "projectId": project["id"],
            "assignedWorkflowId": workflow["id"],
        })
        assert response.status_code == 201, response.text
        tid = response.json()["id"]
        response = client.post(f"/api/v1/tasks/{tid}/runs", json={})
        assert response.status_code == 202, response.text
        session = response.json()["session"]
        sid = session["id"]
        command, = take(app.state.registry, node)
        ask(app.state.registry, node, command, options=["Staging", "Production"])
        session = app.state.session_store.get_session(sid)
        task = app.state.task_store.get_task(tid)
        wait = task["waitingRequest"]
        assert wait["kind"] == "question"
        assert wait["inputQuestion"] == "Deploy to staging or production?"
        assert wait["inputOptions"] == ["Staging", "Production"]
        assert task["waitingSessionId"] == sid
        # Lists and detail use the same public awaiting projection.
        for url in (f"/api/v1/tasks/{tid}", "/api/v1/tasks?view=summary"):
            response = client.get(url)
            assert response.status_code == 200, response.text
            public = response.json()
            if "tasks" in public:
                public = next(item for item in public["tasks"] if item["id"] == tid)
            assert public["awaiting"]["text"] == wait["inputQuestion"]
            assert public["awaiting"]["options"] == wait["inputOptions"]
            assert public["awaiting"]["questionId"] == wait["questionId"]
        request = app.state.daemon_store.get_run_request(workflow_request_id(session["workflowRuns"][0]))
        before = app.state.task_store.get_task(tid)["events"]
        sync_workflow_task(app.state.registry, request, session)
        assert app.state.task_store.get_task(tid)["events"] == before
        # Repair a same-status projection that has an incomplete wait.
        app.state.task_store.append_event(tid, {
            "type": "task.status", "taskId": tid, "timestamp": before[-1]["timestamp"],
            "status": "waiting_for_human", "sessionId": sid,
            "request": {"kind": "check", "questionId": "legacy"},
        }, execution_owner=task["executionOwner"])
        sync_workflow_task(app.state.registry, request, session)
        assert app.state.task_store.get_task(tid)["waitingRequest"] == wait
        url = f"/api/v1/threads/{sid}/workflow-decisions"
        body = answer(session, "Staging") if exit_kind == "answer" else decision(session, "cancel")
        response = client.post(url, json=body)
        assert response.status_code == 200, response.text
        assert "waitingRequest" not in app.state.task_store.get_task(tid)
        assert client.get(f"/api/v1/tasks/{tid}").json()["awaiting"] is None
        if exit_kind == "answer":
            resumed, = take(app.state.registry, node)
            ask(app.state.registry, node, resumed, question="Which region?")
            next_wait = app.state.task_store.get_task(tid)["waitingRequest"]
            assert next_wait["questionId"] != wait["questionId"]
            assert next_wait["inputQuestion"] == "Which region?"
            assert "inputOptions" not in next_wait
