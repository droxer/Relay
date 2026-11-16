"""Production first-step gate staging, with no daemon execution authority."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from relay.persistence.session.reducer import materialize_events
from test_team_workflows import workflow_world
from test_team_computer import _admin_id


def setup_gate(app, client, payload):
    payload["workflowSteps"][0]["requiresApproval"] = True
    response = client.post("/api/v1/teams", json=payload)
    assert response.status_code == 201, response.text
    team = response.json()["team"]
    return team, f"/api/v1/teams/{team['id']}/workflow-gates", {
        "requestId": str(uuid4()), "taskGoal": "Design then deploy",
    }


def assert_undelivered(app, here, sid):
    assert app.state.registry.take_commands(here["id"], "token_node_here") == []
    pending = app.state.daemon_store.active_run_request_for_session_any_node(sid)
    assert pending is None or (pending["status"] == "prepared" and not pending.get("currentCommandId"))
    assert app.state.session_store.get_session(sid)["agentRuns"] == []


def test_owner_stages_real_frozen_gate_and_decides_it(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        team, url, body = setup_gate(app, client, payload)
        response = client.post(url, json=body)
        assert response.status_code == 201, response.text
        session = response.json()
        assert session["ownerUserId"] == project["ownerUserId"]
        assert session["teamId"] == team["id"]
        assert session["projectId"] == project["id"]
        assert session["computerId"] == project["computerId"]
        assert session["workspaceLayout"] == "project"
        assert session["workspaceSubpath"] == project["workspaceSubpath"]
        run = session["workflowRuns"][0]
        assert run["status"] == "awaiting_approval"
        assert run["teamSnapshot"] == app.state.team_store.get_team(team["id"])
        assert [a["workflowStepId"] for a in run["assignments"]] == ["design", "deploy"]
        assert run["assignments"][0]["agentId"] == run["assignments"][1]["agentId"]
        assert run["assignments"][0]["placementId"]
        assert materialize_events(session["events"])["workflowRuns"] == session["workflowRuns"]
        event = next(e for e in session["events"] if e["type"] == "workflow.started")
        assert event["actorUserId"] == _admin_id(app)
        first = run["assignments"][0]
        decision = {key: first[key] for key in ("workflowRunId", "workflowStepId", "workflowAttempt", "assignmentId")}
        response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json={
            **decision, "kind": "approve", "expectedRevision": 0,
        })
        assert response.status_code == 200, response.text
        assert response.json()["workflowRuns"][0]["status"] == "ready"
        assert len(app.state.registry.take_commands(here["id"], "token_node_here")) == 1


def test_request_replay_preserves_original_snapshot(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, here, _, _, payload):
        team, url, body = setup_gate(app, client, payload)
        first = client.post(url, json=body)
        assert first.status_code == 201, first.text
        changed = client.patch(f"/api/v1/teams/{team['id']}", json={"name": "Changed"})
        assert changed.status_code == 200
        again = client.post(url, json=body)
        assert again.status_code == 201, again.text
        assert again.json() == first.json()
        assert_undelivered(app, here, first.json()["id"])
        conflict = client.post(url, json={**body, "taskGoal": "Different goal"})
        assert conflict.status_code == 409, conflict.text
        assert app.state.session_store.get_session(first.json()["id"]) == first.json()


@pytest.mark.parametrize("credential", ["anonymous", "chat", "chat_cookie", "node", "admin_token", "other_admin"])
def test_only_owner_session_can_stage(monkeypatch, credential):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        _, url, body = setup_gate(app, client, payload)
        stranger = TestClient(app)
        if credential in ("chat", "chat_cookie"):
            stranger.headers.update({"Authorization": "Bearer chat-test", "x-relay-user-id": _admin_id(app)})
            if credential == "chat_cookie":
                stranger.cookies.update(client.cookies)
        elif credential in ("node", "admin_token"):
            stranger.headers.update({"Authorization": "Bearer " + ("token_node_here" if credential == "node" else "admin_token")})
        elif credential == "other_admin":
            app.state.auth_store.create_account("other", "kestrel-vault-8820", role="admin", email="other@example.com")
            assert stranger.post("/api/v1/auth/login", json={"username": "other", "password": "kestrel-vault-8820"}).status_code == 200
        before = app.state.session_store.list_sessions()
        response = stranger.post(url, json=body)
        assert response.status_code in (401, 403), response.text
        assert app.state.session_store.list_sessions() == before


@pytest.mark.parametrize("patch", [
    {"requestId": None}, {"requestId": ""}, {"requestId": "not-a-uuid"},
    {"taskGoal": ""}, {"taskGoal": []}, {"taskGoal": "x" * 20001},
    {"actorUserId": "spoofed"}, {"assignments": []}, {"teamSnapshot": {}},
])
def test_invalid_input_creates_no_thread(monkeypatch, patch):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        _, url, body = setup_gate(app, client, payload)
        before = app.state.session_store.list_sessions()
        response = client.post(url, json={**body, **patch})
        assert response.status_code == 400, response.text
        assert app.state.session_store.list_sessions() == before


@pytest.mark.parametrize("invalid", ["disabled_project", "archived_project", "disabled_team", "removed_member", "disabled_agent", "removed_placement"])
def test_invalid_live_admission_leaves_no_thread(monkeypatch, invalid):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        team, url, body = setup_gate(app, client, payload)
        if invalid == "disabled_project":
            app.state.project_store.update_project(project["id"], {"enabled": False}, expected_version=project["version"])
        elif invalid == "archived_project":
            app.state.project_store.archive_project(project["id"], expected_version=project["version"])
        elif invalid == "disabled_team":
            app.state.team_store.update_team(team["id"], {"enabled": False})
        elif invalid == "removed_member":
            app.state.project_store.update_project(project["id"], {"members": project["members"][1:]}, expected_version=project["version"])
        elif invalid == "disabled_agent":
            app.state.agent_store.update_agent(team["leadAgentId"], {"enabled": False})
        elif invalid == "removed_placement":
            for item in app.state.agent_placement_store.list_placements(agent_id=team["leadAgentId"]):
                app.state.agent_placement_store.update_placement(item["id"], {"desiredState": "removed"})
        else:
            app.state.team_store.update_team(team["id"], {"workflowSteps": [
                {**step, "requiresApproval": False} for step in team["workflowSteps"]
            ]})
        before = app.state.session_store.list_sessions()
        response = client.post(url, json=body)
        assert response.status_code in (404, 409), response.text
        assert app.state.session_store.list_sessions() == before


def test_duplicate_concurrent_staging_creates_one_ledger(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, here, _, _, payload):
        _, url, body = setup_gate(app, client, payload)
        def stage(_):
            peer = TestClient(app)
            peer.cookies.update(client.cookies)
            return peer.post(url, json=body)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(stage, range(2)))
        assert [r.status_code for r in responses] == [201, 201], [r.text for r in responses]
        assert responses[0].json() == responses[1].json()
        session = responses[0].json()
        assert sum(e["type"] == "workflow.started" for e in session["events"]) == 1
        assert_undelivered(app, here, session["id"])


def test_start_event_failure_rolls_back_thread(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        _, url, body = setup_gate(app, client, payload)
        before = app.state.session_store.list_sessions()
        append = app.state.session_store.append_event
        def fail_start(sid, event, **kwargs):
            if event["type"] == "workflow.started":
                raise ValueError("test_start_rejected")
            return append(sid, event, **kwargs)
        monkeypatch.setattr(app.state.session_store, "append_event", fail_start)
        response = client.post(url, json=body)
        assert response.status_code == 409, response.text
        assert app.state.session_store.list_sessions() == before


def test_legacy_team_cannot_stage_workflow_gate(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        payload.pop("projectId")
        payload.pop("workflowSteps")
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        before = app.state.session_store.list_sessions()
        response = client.post(f"/api/v1/teams/{team['id']}/workflow-gates", json={
            "requestId": str(uuid4()), "taskGoal": "A legacy Team",
        })
        assert response.status_code == 409, response.text
        assert app.state.session_store.list_sessions() == before


@pytest.mark.parametrize("action", ["cancel", "delete_with_stop", "delete"])
@pytest.mark.parametrize("credential", ["chat_cookie", "other_admin"])
def test_staged_workflow_stop_requires_owner_login(monkeypatch, action, credential):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        _, url, body = setup_gate(app, client, payload)
        response = client.post(url, json=body)
        assert response.status_code == 201, response.text
        session = response.json()
        stranger = TestClient(app)
        if credential == "chat_cookie":
            stranger.cookies.update(client.cookies)
            stranger.headers.update({"Authorization": "Bearer chat-test", "x-relay-user-id": _admin_id(app)})
        else:
            app.state.auth_store.create_account("other", "kestrel-vault-8820", role="admin", email="other@example.com")
            assert stranger.post("/api/v1/auth/login", json={"username": "other", "password": "kestrel-vault-8820"}).status_code == 200
        if action == "cancel":
            response = stranger.post(f"/api/v1/threads/{session['id']}/cancellations", json={})
        else:
            response = stranger.delete(f"/api/v1/threads/{session['id']}" + ("?stop=true" if action == "delete_with_stop" else ""))
        assert response.status_code == 403, response.text
        assert app.state.session_store.get_session(session["id"]) == session


def test_owner_can_cancel_staged_thread_without_reservation(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, here, _, _, payload):
        _, url, body = setup_gate(app, client, payload)
        response = client.post(url, json=body)
        assert response.status_code == 201, response.text
        sid = response.json()["id"]
        cancelled = client.post(f"/api/v1/threads/{sid}/cancellations", json={})
        assert cancelled.status_code == 202, cancelled.text
        assert cancelled.json()["status"] == "cancelled"
        replay = client.post(url, json=body)
        assert replay.status_code == 201, replay.text
        assert replay.json()["status"] == "cancelled"
        assert_undelivered(app, here, sid)
