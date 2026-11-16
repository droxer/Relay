"""Authenticated workflow gates against real stores; no runtime adapter implied."""
from contextlib import contextmanager
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from relay.collaboration.workflow_compilation import compile_workflow
from relay.persistence.events import relay_event
from relay.persistence.session.reducer import materialize_events
from test_team_workflows import workflow_world
from test_team_computer import _admin_id
from issue_projects import project_for_agents


@contextmanager
def waiting_gate(monkeypatch, *, invalid_scope=None):
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        payload["workflowSteps"][0]["requiresApproval"] = True
        response = client.post("/api/v1/teams", json=payload)
        assert response.status_code == 201, response.text
        team = response.json()["team"]
        if invalid_scope == "computer":
            team["computerId"] = "wrong"
        elif invalid_scope == "foreign_owner":
            project = project_for_agents(app.state.project_store, "foreign", [
                app.state.agent_store.get_agent(aid) for aid in team["memberAgentIds"]
            ], name="Foreign")
            team["projectId"] = project["id"]
        assignments = compile_workflow(team, [{"agentId": aid, "executorKind": "codex"}
                                             for aid in team["memberAgentIds"]], run_id="workflow-api")
        session = app.state.session_store.create_session({
            "workspacePath": "/workspace/node_here", "taskGoal": "Workflow API",
            "ownerUserId": team["ownerUserId"], "projectId": project["id"],
            "teamId": team["id"], "computerId": team["computerId"],
        })
        sid = session["id"]
        app.state.session_store.append_event(sid, relay_event("workflow.started", sid, {"assignments": assignments}))
        if invalid_scope is None:
            staged = client.post(f"/api/v1/teams/{team['id']}/workflow-runs", json={
                "requestId": str(uuid4()), "taskGoal": "Workflow API",
            })
            assert staged.status_code == 201, staged.text
            sid = staged.json()["id"]
            assignments = staged.json()["workflowRuns"][0]["assignments"]
        first = assignments[0]
        body = {key: first[key] for key in ("workflowRunId", "workflowStepId", "workflowAttempt", "assignmentId")}
        body.update(kind="approve", expectedRevision=0)
        yield app, client, here, project, sid, body


def endpoint(sid):
    return f"/api/v1/threads/{sid}/workflow-decisions"


@pytest.mark.parametrize("kind, status", [("approve", "ready"), ("reject", "blocked")])
def test_owner_records_bound_gate_once(monkeypatch, kind, status):
    with waiting_gate(monkeypatch) as (app, client, here, _, sid, body):
        body["kind"] = kind
        response = client.post(endpoint(sid), json=body)
        assert response.status_code == 200, response.text
        session = app.state.session_store.get_session(sid)
        run = session["workflowRuns"][0]
        assert run["status"] == status
        assert run["gateDecisions"][0]["actorUserId"] == _admin_id(app)
        assert materialize_events(session["events"])["workflowRuns"] == session["workflowRuns"]
        assert client.post(endpoint(sid), json=body).status_code == 409
        assert app.state.session_store.get_session(sid) == session
        assert len(app.state.registry.take_commands(here["id"], "token_node_here")) == (1 if run["status"] == "ready" else 0)


@pytest.mark.parametrize("credential", ["anonymous", "chat", "chat_cookie", "node", "admin_token", "other_admin"])
def test_only_owner_user_session_may_decide(monkeypatch, credential):
    with waiting_gate(monkeypatch) as (app, client, _, _, sid, body):
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
        before = app.state.session_store.get_session(sid)
        response = stranger.post(endpoint(sid), json=body)
        assert response.status_code in (401, 403), response.text
        assert app.state.session_store.get_session(sid) == before


@pytest.mark.parametrize("change, code", [
    ({"workflowRunId": "other"}, 409), ({"workflowStepId": "deploy"}, 409),
    ({"workflowAttempt": 2}, 409), ({"assignmentId": "other"}, 409),
    ({"expectedRevision": 1}, 409), ({"expectedRevision": False}, 400),
    ({"workflowAttempt": True}, 400), ({"kind": "mark_done"}, 400),
    ({"actorUserId": "fake"}, 400), ({"type": "session.status"}, 400),
    ({"timestamp": "fake"}, 400), ({"workflowStepId": None}, 400),
])
def test_stale_or_malformed_gate_preserves_event_log(monkeypatch, change, code):
    with waiting_gate(monkeypatch) as (app, client, _, _, sid, body):
        before = app.state.session_store.get_session(sid)
        response = client.post(endpoint(sid), json={**body, **change})
        assert response.status_code == code, response.text
        assert app.state.session_store.get_session(sid) == before


@pytest.mark.parametrize("invalid", ["disabled_project", "removed_member", "disabled_agent", "removed_placement", "archived_project"])
def test_live_changes_refuse_approval_without_mutation(monkeypatch, invalid):
    with waiting_gate(monkeypatch) as (app, client, _, project, sid, body):
        if invalid == "disabled_agent":
            app.state.agent_store.update_agent(project["members"][0]["agentId"], {"enabled": False})
        elif invalid == "removed_placement":
            for placement in app.state.agent_placement_store.list_placements(agent_id=project["members"][0]["agentId"]):
                app.state.agent_placement_store.update_placement(placement["id"], {"desiredState": "removed"})
        elif invalid == "archived_project":
            app.state.project_store.archive_project(project["id"], expected_version=project["version"])
        else:
            patch = {
                "disabled_project": {"enabled": False}, "removed_member": {"members": project["members"][1:]},
            }[invalid]
            app.state.project_store.update_project(project["id"], patch, expected_version=project["version"])
        before = app.state.session_store.get_session(sid)
        response = client.post(endpoint(sid), json=body)
        assert response.status_code in (403, 409), response.text
        assert app.state.session_store.get_session(sid) == before


@pytest.mark.parametrize("invalid_scope", ["computer", "foreign_owner"])
def test_imported_wrong_scope_is_refused(monkeypatch, invalid_scope):
    with waiting_gate(monkeypatch, invalid_scope=invalid_scope) as (app, client, _, _, sid, body):
        before = app.state.session_store.get_session(sid)
        response = client.post(endpoint(sid), json=body)
        assert response.status_code in (403, 409), response.text
        assert app.state.session_store.get_session(sid) == before


def test_definition_edit_does_not_reinterpret_waiting_gate(monkeypatch):
    with waiting_gate(monkeypatch) as (app, client, _, _, sid, body):
        before = app.state.session_store.get_session(sid)
        snapshot = before["workflowRuns"][0]["teamSnapshot"]
        response = client.patch(f"/api/v1/teams/{snapshot['id']}", json={
            "workflowSteps": list(reversed(snapshot["workflowSteps"])),
        })
        assert response.status_code == 200, response.text
        response = client.post(endpoint(sid), json=body)
        assert response.status_code == 200, response.text
        assert response.json()["workflowRuns"][0]["teamSnapshot"] == snapshot


def test_rejection_remains_possible_when_assignee_disabled(monkeypatch):
    with waiting_gate(monkeypatch) as (app, client, _, project, sid, body):
        app.state.agent_store.update_agent(project["members"][0]["agentId"], {"enabled": False})
        response = client.post(endpoint(sid), json={**body, "kind": "reject"})
        assert response.status_code == 200, response.text
        assert response.json()["workflowRuns"][0]["status"] == "blocked"


@pytest.mark.parametrize("missing", ["workflowRunId", "workflowStepId", "workflowAttempt", "assignmentId", "expectedRevision", "kind"])
def test_missing_binding_is_refused(monkeypatch, missing):
    with waiting_gate(monkeypatch) as (app, client, _, _, sid, body):
        before = app.state.session_store.get_session(sid)
        del body[missing]
        assert client.post(endpoint(sid), json=body).status_code == 400
        assert app.state.session_store.get_session(sid) == before


def test_terminal_session_cannot_be_approved(monkeypatch):
    with waiting_gate(monkeypatch) as (app, client, _, _, sid, body):
        before = app.state.session_store.append_event(sid, relay_event(
            "session.status", sid, {"status": "cancelled", "phase": "cancelled"},
        ))
        response = client.post(endpoint(sid), json=body)
        assert response.status_code == 409, response.text
        assert app.state.session_store.get_session(sid) == before


def test_competing_http_decisions_record_one_outcome(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    with waiting_gate(monkeypatch) as (app, client, here, _, sid, body):
        def decide(kind):
            caller = TestClient(app)
            caller.cookies.update(client.cookies)
            return caller.post(endpoint(sid), json={**body, "kind": kind}).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(decide, ["approve", "reject"])) == [200, 409]
        session = app.state.session_store.get_session(sid)
        assert len(session["workflowRuns"][0]["gateDecisions"]) == 1
        assert sum(event["type"] == "workflow.gate_decided" for event in session["events"]) == 1
        assert len(app.state.registry.take_commands(here["id"], "token_node_here")) == (1 if session["workflowRuns"][0]["status"] == "ready" else 0)
