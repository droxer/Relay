from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.persistence.store_common import relay_event

from test_project_routes import _bootstrap, _login_alice, _register_computer, _agent


@pytest.fixture
def project_env(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        node = _register_computer(app, "node_delete", "delete-machine")
        # Cleanup support is independently negotiated with the daemon.
        app.state.registry.register({**node, "sandboxId": node["id"], "employeeId": "alice",
            "protocolVersion": 1, "supportedAgents": ["codex", "claude"], "token": f"token_{node['id']}", "capabilities": [*node["capabilities"], "project-workspace-delete"]})
        agent = _agent(client, app, node, "Shared agent", "codex")
        _login_alice(client)
        response = client.post("/api/v1/projects", json={"name": "Delete me", "daemonNodeId": node["id"], "members": [], "leadAgentId": None})
        assert response.status_code == 201, response.text
        project = response.json()["project"]
        task = app.state.task_store.create_task({"title": "Project task", "ownerEmployeeId": "alice", "projectId": project["id"]})
        routine = app.state.task_store.create_task({"title": "Project routine", "ownerEmployeeId": "alice", "projectId": project["id"], "isRoutine": True, "routineEnabled": True, "routineCadence": "daily"})
        session = app.state.session_store.create_session({"taskGoal": "Project thread", "ownerEmployeeId": "alice", "projectId": project["id"], "workspacePath": "/workspace", "workspaceLayout": "project", "workspaceSubpath": project["workspaceSubpath"]})
        app.state.task_store.link_session(task["id"], session["id"])
        yield app, client, node, agent, project, task, routine, session


def test_delete_project_cascades_and_queues_workspace_cleanup(project_env):
    app, client, node, agent, project, task, routine, session = project_env
    other = app.state.task_store.create_task({"title": "Keep", "ownerEmployeeId": "alice"})
    app.state.task_store.link_session(other["id"], session["id"])
    response = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")
    assert response.status_code == 200, response.text
    assert response.json()["deletedProjectId"] == project["id"]
    assert app.state.project_store.get_project(project["id"]) is None
    for store, record, getter in [(app.state.task_store, task, "get_task"), (app.state.task_store, routine, "get_task"), (app.state.session_store, session, "get_session")]:
        with pytest.raises(KeyError):
            getattr(store, getter)(record["id"])
    assert app.state.task_store.get_task(other["id"])["linkedSessionIds"] == []
    assert not app.state.agent_store.get_agent(agent["id"]).get("deletedAt")
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert len(commands) == 1
    assert commands[0]["type"] == "workspace.delete"
    assert commands[0]["workspaceSubpath"] == project["workspaceSubpath"]
    assert commands[0]["sessionId"] == project["id"]
    assert client.get(f"/api/v1/projects/{project['id']}").status_code == 404


@pytest.mark.parametrize("version", [None, "bad", "0"])
def test_delete_project_requires_current_version(project_env, version):
    app, client, node, agent, project, task, routine, session = project_env
    query = f"?expectedVersion={version}" if version else ""
    response = client.delete(f"/api/v1/projects/{project['id']}{query}")
    assert response.status_code == (409 if version == "0" else 400)
    assert app.state.project_store.get_project(project["id"])
    assert app.state.task_store.get_task(task["id"])
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


def test_delete_project_rejects_active_execution_without_partial_cleanup(project_env):
    app, client, node, agent, project, task, routine, session = project_env
    app.state.session_store.append_event(session["id"], relay_event("agent.started", session["id"], {"agent": "codex", "runId": "active-run"}))
    response = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")
    assert response.status_code == 409, response.text
    assert app.state.project_store.get_project(project["id"])
    assert app.state.task_store.get_task(task["id"])
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


def test_delete_project_rolls_back_if_cleanup_cannot_be_queued(project_env, monkeypatch):
    app, client, node, agent, project, task, routine, session = project_env
    def fail(*args, **kwargs):
        raise ValueError("queue full")
    monkeypatch.setattr(app.state.daemon_store, "enqueue_command", fail)
    response = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")
    assert response.status_code == 409
    assert app.state.project_store.get_project(project["id"])
    assert app.state.task_store.get_task(task["id"])["linkedSessionIds"] == [session["id"]]
    assert app.state.session_store.get_session(session["id"])
