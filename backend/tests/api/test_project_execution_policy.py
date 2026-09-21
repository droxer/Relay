from __future__ import annotations

import asyncio
from datetime import date

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer


@pytest.fixture
def project_context(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice_project", "project-computer")
    lead = _agent(client, app, node, "Lead", "codex")
    worker = _agent(client, app, node, "Worker", "claude")
    _login_alice(client)
    created = client.post("/api/v1/projects", json={
        "name": "Execution policy", "daemonNodeId": node["id"], "leadAgentId": lead["id"],
        "members": [dict(agentId=agent["id"], role="implementer",
                         responsibilities="Deliver", enabled=True) for agent in [lead, worker]],
    })
    assert created.status_code == 201, created.text
    return app, client, node, created.json()["project"], lead, worker


@pytest.mark.parametrize("entry", ["manual", "scheduler", "routine"])
def test_explicit_project_assignee_runs_without_unavailable_siblings(project_context, entry):
    app, client, node, project, lead, worker = project_context
    created = client.post("/api/v1/tasks", json={
        "title": "Worker only", "projectId": project["id"], "assignedAgentId": worker["id"],
        "status": "assigned",
        **({"isRoutine": True, "routineCadence": "daily", "routineEnabled": True} if entry == "routine" else {}),
    })
    assert created.status_code == 201, created.text
    task = created.json()
    app.state.agent_store.update_agent(lead["id"], {"enabled": False})
    if entry == "scheduler":
        tick = asyncio.run(app.state.task_scheduler.tick())
        assert tick.dispatched == 1
    else:
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202, started.text
        assert started.json()["dispatch"]["state"] == "started", started.text
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert len(commands) == 1
    assert commands[0]["logicalAgentId"] == worker["id"]
    assert commands[0]["workspaceSubpath"] == project["workspaceSubpath"]
    requests = app.state.registry.daemon_store.list_active_run_requests()
    assert [assignment["agentId"] for assignment in requests[0]["assignments"]] == [worker["id"]]


@pytest.mark.parametrize("entry", ["create", "update"])
def test_project_task_cannot_select_a_disabled_project_member(project_context, entry):
    app, client, node, project, lead, worker = project_context
    disabled = [{**member, "enabled": member["agentId"] != worker["id"]} for member in project["members"]]
    assert client.patch(f"/api/v1/projects/{project['id']}", json={"expectedVersion": 1, "members": disabled}).status_code == 200
    if entry == "create":
        response = client.post("/api/v1/tasks", json={"title": "Invalid", "projectId": project["id"], "assignedAgentId": worker["id"]})
    else:
        task = client.post("/api/v1/tasks", json={"title": "Unassigned", "projectId": project["id"]}).json()
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={"assignedAgentId": worker["id"]})
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "project_agent_not_member"


def close_project(client, project, state):
    if state == "archived":
        response = client.post(f"/api/v1/projects/{project['id']}/archive?expectedVersion=1")
    else:
        response = client.patch(f"/api/v1/projects/{project['id']}", json={"expectedVersion": 1, "enabled": False})
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("state", ["disabled", "archived"])
def test_closed_project_blocks_user_writes_but_keeps_history_readable(project_context, state):
    app, client, node, project, lead, worker = project_context
    task = client.post("/api/v1/tasks", json={"title": "History", "projectId": project["id"]}).json()
    close_project(client, project, state)
    requests = [
        ("POST", "/api/v1/tasks", {"title": "New", "projectId": project["id"]}),
        ("POST", "/api/v1/threads", {"taskGoal": "New thread", "projectId": project["id"]}),
        ("PATCH", f"/api/v1/tasks/{task['id']}", {"title": "Changed"}),
        ("PUT", f"/api/v1/tasks/{task['id']}/assignment", {"agentId": worker["id"]}),
        ("POST", f"/api/v1/tasks/{task['id']}/pickups", {"agentId": worker["id"]}),
        ("POST", f"/api/v1/tasks/{task['id']}/runs", {}),
        ("DELETE", f"/api/v1/tasks/{task['id']}", None),
    ]
    before = app.state.task_store.get_task(task["id"])
    for method, path, body in requests:
        response = client.request(method, path, json=body)
        assert response.status_code in (404, 409), (method, path, response.text)
    assert app.state.task_store.get_task(task["id"]) == before
    assert client.get(f"/api/v1/tasks/{task['id']}").status_code == 200
    assert client.get(f"/api/v1/projects/{project['id']}").status_code == 200
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


@pytest.mark.parametrize("state", ["disabled", "archived"])
def test_closed_project_routines_do_not_promote_or_advance_schedule(project_context, state):
    app, client, node, project, lead, worker = project_context
    created = client.post("/api/v1/tasks", json={
        "title": "Daily", "projectId": project["id"], "isRoutine": True,
        "routineCadence": "daily", "routineEnabled": True, "routineNextRunDate": "2026-09-21",
    })
    assert created.status_code == 201, created.text
    routine = created.json()
    close_project(client, project, state)
    promoted, skipped = app.state.task_scheduler._promote_due_routines(date(2026, 9, 21))
    assert (promoted, skipped) == (0, 1)
    started = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})
    assert started.status_code == 409
    after = app.state.task_store.get_task(routine["id"])
    assert after["routineNextRunDate"] == routine["routineNextRunDate"]
    assert after["occurrenceIds"] == []


@pytest.mark.parametrize("state", ["disabled", "archived"])
def test_admitted_project_run_can_record_completion_after_closure(project_context, state):
    app, client, node, project, lead, worker = project_context
    task = client.post("/api/v1/tasks", json={"title": "Finish admitted work", "projectId": project["id"], "assignedAgentId": worker["id"]}).json()
    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert started.json()["dispatch"]["state"] == "started"
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    event = {key: command[key] for key in ("sessionId", "runId", "agent")}
    event.update(commandId=command["id"], **({"leaseId": command["leaseId"]} if command.get("leaseId") else {}))
    path = f"/api/v1/daemon-nodes/{node['id']}/events"
    headers = {"Authorization": f"Bearer token_{node['id']}"}
    assert client.post(path, headers=headers, json={**event, "type": "run.executing"}).status_code == 200
    close_project(client, project, state)
    completed = client.post(path, headers=headers, json={**event, "type": "run.completed", "exitCode": 0, "agentLog": "Delivered"})
    assert completed.status_code == 200, completed.text
    session = app.state.session_store.get_session(command["sessionId"])
    assert any(item["type"] == "agent.completed" for item in session["events"])
    assert app.state.task_store.get_task(task["id"])["status"] == "review"
