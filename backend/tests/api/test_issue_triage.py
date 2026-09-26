"""An issue outside a project is intake: it can be written but never run."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer


@pytest.fixture
def triage_context(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice_triage", "triage-computer")
    lead = _agent(client, app, node, "Lead", "codex")
    _login_alice(client)
    created = client.post("/api/v1/projects", json={
        "name": "Triage target", "daemonNodeId": node["id"], "leadAgentId": lead["id"],
        "members": [dict(agentId=lead["id"], role="implementer", responsibilities="Deliver", enabled=True)],
    })
    assert created.status_code == 201, created.text
    return app, client, node, created.json()["project"], lead


def _issue(client, **fields) -> dict:
    response = client.post("/api/v1/tasks", json={"title": "Loose end", **fields})
    assert response.status_code == 201, response.text
    return response.json()


def test_projectless_issue_is_created_as_backlog_intake(triage_context):
    _app, client, _node, _project, _lead = triage_context
    issue = _issue(client, priority="high")
    assert issue["status"] == "backlog"
    assert not issue.get("projectId")


@pytest.mark.parametrize("fields", [
    {"status": "assigned"},
    {"assignedAgentId": "__lead__"},
    {"createSession": True},
])
def test_projectless_issue_cannot_be_created_runnable(triage_context, fields):
    _app, client, _node, _project, lead = triage_context
    body = {key: (lead["id"] if value == "__lead__" else value) for key, value in fields.items()}
    response = client.post("/api/v1/tasks", json={"title": "Runnable", **body})
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "issue_needs_project"


@pytest.mark.parametrize("request_kind", ["patch-agent", "patch-ready", "put-assignment", "pickup", "run"])
def test_projectless_issue_cannot_be_assigned_or_started(triage_context, request_kind):
    app, client, node, _project, lead = triage_context
    issue = _issue(client)
    method, path, body = {
        "patch-agent": ("PATCH", f"/api/v1/tasks/{issue['id']}", {"assignedAgentId": lead["id"]}),
        "patch-ready": ("PATCH", f"/api/v1/tasks/{issue['id']}", {"status": "assigned"}),
        "put-assignment": ("PUT", f"/api/v1/tasks/{issue['id']}/assignment", {"agentId": lead["id"]}),
        "pickup": ("POST", f"/api/v1/tasks/{issue['id']}/pickups", {"agentId": lead["id"]}),
        "run": ("POST", f"/api/v1/tasks/{issue['id']}/runs", {}),
    }[request_kind]
    response = client.request(method, path, json=body)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "issue_needs_project"
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


def _legacy_ready(app, lead) -> dict:
    return app.state.task_store.create_task({
        "title": "Legacy ready", "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
        "assignedAgent": "codex", "assignedAgentId": lead["id"], "status": "assigned",
    })


def test_legacy_ready_projectless_issue_is_held_by_the_scheduler(triage_context):
    app, _client, node, _project, lead = triage_context
    legacy = _legacy_ready(app, lead)
    tick = asyncio.run(app.state.task_scheduler.tick())
    assert tick.dispatched == 0
    assert app.state.task_store.get_task(legacy["id"])["status"] == "assigned"
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


def test_triage_moves_an_issue_into_a_project_and_it_can_then_run(triage_context):
    app, client, node, project, lead = triage_context
    issue = _issue(client)
    moved = client.patch(f"/api/v1/tasks/{issue['id']}", json={"projectId": project["id"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["projectId"] == project["id"]
    assert app.state.task_store.get_task(issue["id"])["projectId"] == project["id"]
    events = client.get(f"/api/v1/tasks/{issue['id']}/events").json()["events"]
    assert any(event["type"] == "task.project_set" for event in events)

    assigned = client.patch(f"/api/v1/tasks/{issue['id']}", json={"assignedAgentId": lead["id"], "status": "assigned"})
    assert assigned.status_code == 200, assigned.text
    started = client.post(f"/api/v1/tasks/{issue['id']}/runs", json={})
    assert started.status_code == 202, started.text
    assert started.json()["dispatch"]["state"] == "started", started.text
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert commands[0]["workspaceSubpath"] == project["workspaceSubpath"]


def test_legacy_ready_issue_moves_and_then_dispatches(triage_context):
    app, client, _node, project, lead = triage_context
    legacy = _legacy_ready(app, lead)
    moved = client.patch(f"/api/v1/tasks/{legacy['id']}", json={"projectId": project["id"]})
    assert moved.status_code == 200, moved.text
    tick = asyncio.run(app.state.task_scheduler.tick())
    assert tick.dispatched == 1


def test_project_move_refusals(triage_context):
    app, client, _node, project, _lead = triage_context
    in_project = _issue(client, projectId=project["id"])
    response = client.patch(f"/api/v1/tasks/{in_project['id']}", json={"projectId": project["id"]})
    assert (response.status_code, response.json()["detail"]) == (409, "task_already_in_project")

    loose = _issue(client)
    response = client.patch(f"/api/v1/tasks/{loose['id']}", json={"projectId": "project_missing"})
    assert response.status_code == 404, response.text

    response = client.patch(f"/api/v1/tasks/{loose['id']}", json={"projectId": ""})
    assert response.status_code == 400, response.text

    done = _issue(client)
    app.state.task_store.update_task(done["id"], {"status": "review"})
    response = client.patch(f"/api/v1/tasks/{done['id']}", json={"projectId": project["id"]})
    assert (response.status_code, response.json()["detail"]) == (409, "task_already_started")
    assert not app.state.task_store.get_task(done["id"]).get("projectId")


def test_projectless_routines_still_accept_an_agent(triage_context):
    _app, client, _node, _project, lead = triage_context
    created = client.post("/api/v1/tasks", json={
        "title": "Nightly", "isRoutine": True, "routineCadence": "daily",
        "routineEnabled": True, "assignedAgentId": lead["id"],
    })
    assert created.status_code == 201, created.text


def test_intake_cannot_spoof_a_routine_run_in_create(triage_context):
    _app, client, _node, _project, lead = triage_context
    response = client.post("/api/v1/tasks", json={
        "title": "Spoofed occurrence", "sourceRoutineId": "routine_any",
        "assignedAgentId": lead["id"],
    })
    assert (response.status_code, response.json()["detail"]) == (409, "issue_needs_project")


def test_clearing_legacy_intake_assignment_returns_it_to_backlog(triage_context):
    app, client, _node, _project, lead = triage_context
    issue = _legacy_ready(app, lead)
    response = client.patch(f"/api/v1/tasks/{issue['id']}", json={"assignedAgentId": None})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "backlog"
    assert not response.json().get("assignedAgentId")


def test_intake_cannot_move_to_another_employees_project(triage_context):
    app, client, _node, project, _lead = triage_context
    other = app.state.project_store.create_project("bob", {
        "name": "Private", "computerId": project["computerId"],
        "leadAgentId": project["leadAgentId"], "members": project["members"],
    })
    issue = _issue(client)
    response = client.patch(f"/api/v1/tasks/{issue['id']}", json={"projectId": other["id"]})
    assert response.status_code == 403, response.text
    assert not app.state.task_store.get_task(issue["id"]).get("projectId")
