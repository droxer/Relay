"""Task starts recover from unavailable projects and idle precreated threads."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice", "machine-a")
    agent = _agent(client, app, node, "Builder", "codex")
    _login_alice(client)
    response = client.post("/api/v1/projects", json={
        "name": "Recoverable project", "daemonNodeId": node["id"],
        "leadAgentId": agent["id"], "members": [{
            "agentId": agent["id"], "role": "implementer",
            "functionTitle": "Builder", "responsibilities": "Deliver work",
        }],
    })
    assert response.status_code == 201, response.text
    return app, client, node, agent, response.json()["project"]


@pytest.mark.parametrize("failure", ["computer", "executor"])
def test_queued_project_start_retries_when_runtime_recovers(setup, failure):
    app, client, node, _, project = setup
    task = client.post("/api/v1/tasks", json={
        "title": "Recover project start", "projectId": project["id"],
    }).json()
    patch = {"status": "failed"} if failure == "computer" else {"disabledAgents": ["codex"]}
    app.state.registry.update_status(node["id"], patch)
    result = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert result.status_code == 202, result.text
    assert result.json()["dispatch"]["state"] == "queued"
    assert result.json()["task"]["status"] == "assigned"
    app.state.registry.update_status(node["id"], {"status": "ready", "disabledAgents": []})
    assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 1
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert command["workspaceSubpath"] == project["workspaceSubpath"]


@pytest.mark.parametrize("scope", ["agent", "project"])
def test_precreated_idle_thread_can_start_without_duplicate_execution(setup, scope):
    app, client, node, agent, project = setup
    assignment = {"assignedAgentId": agent["id"]} if scope == "agent" else {"projectId": project["id"]}
    response = client.post("/api/v1/tasks", json={
        "title": "Start precreated thread", "createSession": True, **assignment,
    })
    assert response.status_code == 201, response.text
    task = response.json()
    [original_session_id] = task["linkedSessionIds"]
    assert not app.state.daemon_store.active_run_request_for_task(task["id"])
    result = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert result.status_code == 202, result.text
    assert result.json()["dispatch"]["state"] == "started", result.json()
    again = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert again.json()["dispatch"]["code"] == "task_execution_active"
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert command["type"] == "run.start"
    assert app.state.session_store.get_session(original_session_id)
