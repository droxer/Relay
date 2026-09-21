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
        "members": [dict(agentId=agent["id"], role="implementer", functionTitle=agent["displayName"],
                         responsibilities="Deliver", enabled=True) for agent in [lead, worker]],
    })
    assert created.status_code == 201, created.text
    return app, client, node, created.json()["project"], lead, worker


@pytest.mark.parametrize("entry", ["manual", "scheduler", "routine"])
def test_explicit_project_assignee_runs_without_unavailable_siblings(project_context, entry):
    app, client, node, project, lead, worker = project_context
    created = client.post("/api/v1/tasks", json={
        "title": "Worker only", "projectId": project["id"], "assignedAgentId": worker["id"],
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
