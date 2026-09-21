from tempfile import TemporaryDirectory

import pytest
from sqlalchemy import select
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.persistence.store_common import relay_event

from test_project_routes import _bootstrap, _login_alice, _register_computer, _agent


@pytest.fixture(params=["file", "database"])
def project_env(monkeypatch, request):
    monkeypatch.setenv("RELAY_DAEMON_STORE", request.param)
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
        response = client.post("/api/v1/projects", json={"name": "Delete me", "daemonNodeId": node["id"], "members": [{"agentId": agent["id"], "role": "planner", "responsibilities": "Plan"}], "leadAgentId": agent["id"]})
        assert response.status_code == 201, response.text
        project = response.json()["project"]
        task = app.state.task_store.create_task({"title": "Project task", "ownerEmployeeId": "alice", "projectId": project["id"]})
        routine = app.state.task_store.create_task({"title": "Project routine", "ownerEmployeeId": "alice", "projectId": project["id"], "isRoutine": True, "routineEnabled": True, "routineCadence": "daily"})
        session = app.state.session_store.create_session({"taskGoal": "Project thread", "ownerEmployeeId": "alice", "projectId": project["id"], "workspacePath": "/workspace", "workspaceLayout": "project", "workspaceSubpath": project["workspaceSubpath"]})
        app.state.task_store.link_session(task["id"], session["id"])
        yield app, client, node, agent, project, task, routine, session


def test_delete_project_cascades_and_queues_workspace_cleanup(project_env):
    app, client, node, agent, project, task, routine, session = project_env
    other_project = client.post("/api/v1/projects", json={"name": "Keep project", "daemonNodeId": node["id"], "members": [], "leadAgentId": None}).json()["project"]
    other = app.state.task_store.create_task({"title": "Keep", "ownerEmployeeId": "alice", "projectId": other_project["id"]})
    occurrence = app.state.task_store.create_routine_occurrence(routine["id"], "2026-09-22")
    assert occurrence is not None
    app.state.task_store.link_session(other["id"], session["id"])
    app.state.session_store.create_artifact(session["id"], {"kind": "document", "title": "Owned artifact", "body": "Project content", "extension": "md"})
    response = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")
    assert response.status_code == 200, response.text
    assert response.json()["deletedProjectId"] == project["id"]
    assert app.state.project_store.get_project(project["id"]) is None
    with app.state.project_store.engine.connect() as conn:
        for table, column, ids in [
            (app.state.project_store.members, "project_id", [project["id"]]),
            (app.state.project_store.events_table, "project_id", [project["id"]]),
            (app.state.task_store.events, "task_id", [task["id"], routine["id"]]),
            (app.state.task_store.task_sessions, "task_id", [task["id"], routine["id"]]),
            (app.state.session_store.events, "session_id", [session["id"]]),
            (app.state.session_store.artifacts, "session_id", [session["id"]]),
        ]:
            assert conn.execute(select(table).where(table.c[column].in_(ids))).first() is None
    for store, record, getter in [(app.state.task_store, task, "get_task"), (app.state.task_store, routine, "get_task"), (app.state.session_store, session, "get_session")]:
        with pytest.raises(KeyError):
            getattr(store, getter)(record["id"])
    with pytest.raises(KeyError):
        app.state.task_store.get_task(occurrence["id"])
    assert app.state.project_store.get_project(other_project["id"]) == other_project
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


def test_delete_archived_project_and_acknowledge_cleanup(project_env):
    app, client, node, agent, project, task, routine, session = project_env
    archived = client.post(f"/api/v1/projects/{project['id']}/archive?expectedVersion=1")
    assert archived.status_code == 200
    deleted = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=2")
    assert deleted.status_code == 200, deleted.text
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    response = client.post(f"/api/v1/daemon-nodes/{node['id']}/events",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={"type": "workspace.deleted", "commandId": command["id"], "leaseId": command["leaseId"], "path": ""})
    assert response.status_code == 200, response.text
    assert app.state.daemon_store.get_command(command["id"])["status"] == "completed"


def test_delete_project_cannot_be_used_by_another_employee(project_env):
    app, client, node, agent, project, task, routine, session = project_env
    client.post("/api/v1/auth/logout")
    assert client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1").status_code == 401
    client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    client.post("/api/v1/admin/employees", json={"employeeId": "bob", "username": "bob", "password": "userpass", "displayName": "Bob"})
    client.post("/api/v1/auth/logout")
    client.post("/api/v1/auth/login", json={"username": "bob", "password": "userpass"})
    assert client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1").status_code == 403
    assert app.state.project_store.get_project(project["id"])


def test_local_cleanup_command_is_not_delivered_after_transaction_rollback(project_env, monkeypatch):
    app, client, node, agent, project, task, routine, session = project_env
    enqueue = app.state.daemon_store.enqueue_command
    def enqueue_then_fail(*args, **kwargs):
        enqueue(*args, **kwargs)
        raise ValueError("Simulated failure after durable local enqueue")
    monkeypatch.setattr(app.state.daemon_store, "enqueue_command", enqueue_then_fail)
    response = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")
    assert response.status_code == 409
    assert app.state.project_store.get_project(project["id"])
    assert app.state.task_store.get_task(task["id"])["linkedSessionIds"] == [session["id"]]
    assert app.state.session_store.get_session(session["id"])
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


def test_project_deletion_defers_cleanup_until_daemon_upgrade(project_env):
    app, client, node, agent, project, task, routine, session = project_env
    old_node = _register_computer(app, node["id"], "delete-machine")
    response = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")
    assert response.status_code == 200, response.text
    assert response.json()["workspaceCleanup"] == "waiting_for_upgrade"
    assert app.state.project_store.get_project(project["id"]) is None
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}", lease_seconds=0) == []
    assert app.state.daemon_store.get_command(response.json()["cleanupCommandId"])["status"] != "completed"
    app.state.registry.register({
        **old_node, "sandboxId": node["id"], "employeeId": "alice",
        "protocolVersion": 1, "supportedAgents": ["codex"],
        "token": f"token_{node['id']}",
        "capabilities": [*old_node["capabilities"], "project-workspace-delete"],
    })
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert command["id"] == response.json()["cleanupCommandId"]
    assert command["type"] == "workspace.delete"


def test_project_deletion_preserves_records_when_computer_is_missing(project_env):
    app, client, node, agent, project, task, routine, session = project_env
    app.state.registry.delete(node["id"])
    response = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")
    assert response.status_code == 409
    assert response.json()["detail"] == "project_cleanup_unavailable"
    assert app.state.project_store.get_project(project["id"])
