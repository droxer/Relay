"""Task starts recover from unavailable projects and idle precreated threads."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.sessions import SessionController

from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice", "machine-a")
    app.state.registry.update_status(node["id"], {"capabilities": [*node["capabilities"], "task-workspaces"]})
    agent = _agent(client, app, node, "Builder", "codex")
    _login_alice(client)
    response = client.post(
        "/api/v1/projects",
        json={
            "name": "Recoverable project",
            "daemonNodeId": node["id"],
            "leadAgentId": agent["id"],
            "members": [
                {
                    "agentId": agent["id"],
                    "role": "implementer",
                    "responsibilities": "Deliver work",
                }
            ],
        },
    )
    assert response.status_code == 201, response.text
    return app, client, node, agent, response.json()["project"]


@pytest.mark.parametrize("failure", ["computer", "executor"])
def test_queued_project_start_retries_when_runtime_recovers(setup, failure):
    app, client, node, _, project = setup
    task = client.post(
        "/api/v1/tasks",
        json={
            "title": "Recover project start",
            "projectId": project["id"],
        },
    ).json()
    patch = (
        {"status": "failed"}
        if failure == "computer"
        else {"agents": {"codex": "unavailable"}}
    )
    app.state.registry.update_status(node["id"], patch)
    result = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert result.status_code == 202, result.text
    assert result.json()["dispatch"]["state"] == "queued"
    assert result.json()["dispatch"]["code"] == (
        "project_computer_offline" if failure == "computer" else "agent_offline"
    )
    assert result.json()["task"]["status"] == "assigned"
    _register_computer(app, node["id"], "machine-a")
    assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 1
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert command["workspaceSubpath"] == project["workspaceSubpath"]


@pytest.mark.parametrize("scope", ["agent", "project"])
def test_precreated_idle_thread_can_start_without_duplicate_execution(setup, scope):
    app, client, node, agent, project = setup
    if scope == "agent":
        task = app.state.task_store.create_task({
            "title": "Start precreated thread",
            "sourceRoutineId": "routine_nightly",
            "ownerEmployeeId": "alice",
            "assigneeEmployeeId": "alice",
            "assignedAgentId": agent["id"],
            "assignedAgent": agent["executorKind"],
        })
        controller = SessionController(
            app.state.session_store, task_store=app.state.task_store,
            task_id=task["id"], owner_employee_id="alice", owner_agent_id=agent["id"],
        )
        controller.create_session(task["title"], ["human", "codex"])
        task = app.state.task_store.get_task(task["id"])
    else:
        response = client.post("/api/v1/tasks", json={
            "title": "Start precreated thread", "createSession": True,
            "projectId": project["id"],
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
    binding = app.state.task_store.get_task(task["id"])["workspaceBinding"]
    assert binding["computerId"] == computer_id(node)
    assert "unbound" not in binding
    if scope == "agent":
        assert command["sessionId"] == original_session_id
    assert app.state.session_store.get_session(original_session_id)


@pytest.mark.parametrize("scope", ["agent", "project", "routine"])
def test_explicit_start_retries_blocked_dispatch_without_automatic_retry(setup, monkeypatch, scope):
    app, client, node, agent, project = setup
    assignment = {"projectId": project["id"]} if scope == "project" else {"assignedAgentId": agent["id"], "projectId": project["id"]}
    if scope == "routine":
        assignment.pop("projectId", None)
        assignment.update(isRoutine=True, routineCadence="weekly", routineEnabled=True,
                          routineNextRunDate=app.state.today().isoformat())
    created = client.post("/api/v1/tasks", json={"title": "Retry failed work", **assignment})
    assert created.status_code == 201, created.text
    task = created.json()
    original_run = app.state.backend.run

    async def unavailable(*args, **kwargs):
        raise ValueError("capacity_exhausted: fixture computer is full")

    monkeypatch.setattr(app.state.backend, "run", unavailable)
    failed = client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()
    assert failed["task"]["status"] == "blocked", failed
    failed_id = failed["task"]["id"]
    monkeypatch.setattr(app.state.backend, "run", original_run)
    assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 0
    assert app.state.task_store.get_task(failed_id)["status"] == "blocked"

    retried = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert retried.status_code == 202, retried.text
    result = retried.json()
    assert result["dispatch"]["state"] == "started", result
    assert result["task"]["id"] == failed_id
    assert not result["task"].get("blockerReason")
    again = client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()
    assert again["dispatch"]["code"] == (
        "already_started" if scope == "routine" else "task_execution_active"
    ), again
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert len([command for command in commands if command["type"] == "run.start"]) == 1


def test_explicit_start_does_not_unblock_owned_execution(setup):
    app, client, node, agent, project = setup
    task = client.post("/api/v1/tasks", json={"title": "Already admitted", "projectId": project["id"], "assignedAgentId": agent["id"]}).json()
    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()
    assert started["dispatch"]["state"] == "started", started
    app.state.task_store.update_task(task["id"], {"status": "blocked", "blockerReason": "Waiting for reconciliation"})
    result = client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()
    assert result["dispatch"]["code"] == "task_execution_active", result
    assert result["task"]["status"] == "blocked"
    assert result["task"]["blockerReason"] == "Waiting for reconciliation"
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert len([command for command in commands if command["type"] == "run.start"]) == 1
