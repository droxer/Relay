from __future__ import annotations

import asyncio
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.sessions import SessionController

ADMIN_PASSWORD = "kestrel-vault-7719"


def _bootstrap(client: TestClient) -> None:
    assert (
        client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "password": ADMIN_PASSWORD},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "alice",
                "username": "alice",
                "password": "userpass",
                "displayName": "Alice",
            },
        ).status_code
        == 201
    )


def _login_alice(client: TestClient) -> None:
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"username": "alice", "password": "userpass"},
        ).status_code
        == 200
    )


def _register_node(app, node_id: str, machine_id: str, capabilities: list[str]) -> dict:
    return app.state.registry.register(
        {
            "sandboxId": node_id,
            "employeeId": "alice",
            "token": f"token_{node_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": capabilities,
            "status": "ready",
            "workspacePath": "/workspace/relay",
            "workspaceId": machine_id,
        }
    )


def _agent(client: TestClient, node: dict, name: str = "Runner") -> dict:
    # The node is already live, so declaring the agent auto-places it. This
    # route requires an admin session; the bearer admin token works
    # regardless of which employee's cookie the client currently carries.
    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorEmployeeId": "alice",
            "displayName": name,
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": computer_id(node),
        },
        headers={"Authorization": "Bearer admin_token"},
    )
    assert response.status_code == 201, response.text
    return response.json()["agent"]


async def _stub_dispatch(_ctx: Any, node: dict, command: dict) -> dict:
    if command["type"] == "workspace.list":
        return {
            "type": "workspace.listing",
            "path": command["path"],
            "exists": True,
            "entries": [],
        }
    return {
        "type": "workspace.file",
        "path": command["path"],
        "bytes": 5,
        "isBinary": False,
        "truncated": False,
        "contentBase64": "aGVsbG8=",
    }


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setattr("relay.api.task_routes.dispatch_workspace_command", _stub_dispatch)
    with TemporaryDirectory() as root:
        app = create_app(root)
        test_client = TestClient(app)
        _bootstrap(test_client)
        _login_alice(test_client)
        yield test_client


@pytest.fixture
def other_employee(client: TestClient):
    app = client.app
    assert (
        client.post(
            "/api/v1/admin/users",
            json={
                "username": "worker",
                "password": "userpass",
                "role": "user",
                "employeeId": "worker",
            },
            headers={"Authorization": "Bearer admin_token"},
        ).status_code
        == 201
    )
    worker_client = TestClient(app)
    assert (
        worker_client.post(
            "/api/v1/auth/login",
            json={"username": "worker", "password": "userpass"},
        ).status_code
        == 200
    )
    token = worker_client.cookies.get("relay_session")
    return SimpleNamespace(headers={"Cookie": f"relay_session={token}"})


@pytest.fixture
def task_with_run(client: TestClient):
    app = client.app

    def _make(*, capabilities: list[str]) -> tuple[dict, dict]:
        node = _register_node(app, "node_alice", "machine-alice", capabilities)
        agent = _agent(client, node)
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Ship the report",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "status": "assigned",
            },
        )
        assert created.status_code == 201, created.text
        result = asyncio.run(app.state.task_scheduler.tick())
        assert result.dispatched == 1
        task = client.get(f"/api/v1/tasks/{created.json()['id']}").json()
        return task, node

    return _make


@pytest.fixture
def backlog_task(client: TestClient):
    created = client.post(
        "/api/v1/tasks",
        json={
            "title": "Not started yet",
            "ownerEmployeeId": "alice",
            "assigneeEmployeeId": "alice",
        },
    )
    assert created.status_code == 201, created.text
    return created.json()


@pytest.fixture
def routine_with_occurrence(client: TestClient):
    app = client.app

    def _make(*, capabilities: list[str]) -> tuple[dict, dict, dict]:
        node = _register_node(app, "node_alice_routine", "machine-alice-routine", capabilities)
        agent = _agent(client, node, name="Routine Runner")
        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Weekly report",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agent["id"],
                "isRoutine": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "routineEnabled": True,
            },
        )
        assert created.status_code == 201, created.text
        start = client.post(f"/api/v1/tasks/{created.json()['id']}/runs", json={})
        assert start.status_code == 202, start.text
        occurrence = start.json()["task"]
        routine = client.get(f"/api/v1/tasks/{created.json()['id']}").json()
        return routine, occurrence, node

    return _make


def test_owner_lists_the_task_workspace(client, task_with_run):
    task, node = task_with_run(capabilities=["task-workspaces", "workspace-read-shared"])
    response = client.get(f"/api/v1/tasks/{task['id']}/workspace/files")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["taskId"] == task["id"]
    assert body["nodeId"] == node["id"]
    assert body["scope"] == "shared"


def test_another_employee_cannot_read_the_task_workspace(client, task_with_run, other_employee):
    task, _ = task_with_run(capabilities=["task-workspaces", "workspace-read-shared"])
    response = client.get(
        f"/api/v1/tasks/{task['id']}/workspace/files",
        headers=other_employee.headers,
    )
    assert response.status_code == 403


def test_node_without_shared_read_reports_placement_unavailable(client, task_with_run):
    task, _ = task_with_run(capabilities=["task-workspaces"])
    response = client.get(f"/api/v1/tasks/{task['id']}/workspace/files")
    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "placement-unavailable"


def test_task_that_never_dispatched_reports_placement_unavailable(client, backlog_task):
    response = client.get(f"/api/v1/tasks/{backlog_task['id']}/workspace/files")
    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "placement-unavailable"


def test_routine_lists_its_occurrence_directories(client, routine_with_occurrence):
    routine, occurrence, node = routine_with_occurrence(
        capabilities=["task-workspaces", "workspace-read-shared"]
    )
    response = client.get(f"/api/v1/tasks/{routine['id']}/workspace/files")
    assert response.status_code == 200, response.text
    assert response.json()["taskId"] == routine["id"]
    assert response.json()["nodeId"] == node["id"]


def test_reads_a_file_from_the_task_workspace(client, task_with_run):
    task, _ = task_with_run(capabilities=["task-workspaces", "workspace-read-shared"])
    response = client.get(
        f"/api/v1/tasks/{task['id']}/workspace/file", params={"path": "report.md"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["taskId"] == task["id"]


def test_project_task_browses_the_recorded_project_workspace(
    client, backlog_task, monkeypatch
):
    app = client.app
    node = _register_node(
        app,
        "node_alice_project",
        "machine-alice-project",
        ["project-workspaces", "workspace-read-shared"],
    )
    controller = SessionController(
        app.state.session_store,
        task_store=app.state.task_store,
        task_id=backlog_task["id"],
        workspace_path=node["workspacePath"],
        owner_employee_id="alice",
        project_id="prj_launch",
        workspace_layout="project",
        workspace_subpath="projects/prj_launch",
        daemon_node_id=node["id"],
    )
    controller.create_session(backlog_task["title"], ["human", "codex"])
    captured: dict[str, Any] = {}

    async def capture_dispatch(_ctx: Any, _node: dict, command: dict) -> dict:
        captured.update(command)
        return {
            "type": "workspace.listing",
            "path": command["path"],
            "exists": True,
            "entries": [],
        }

    monkeypatch.setattr(
        "relay.api.task_routes.dispatch_workspace_command", capture_dispatch
    )

    response = client.get(
        f"/api/v1/tasks/{backlog_task['id']}/workspace/files"
    )

    assert response.status_code == 200, response.text
    assert captured["workspaceLayout"] == "project"
    assert captured["workspaceSubpath"] == "projects/prj_launch"


def test_task_workspace_rejects_a_daemon_that_lost_task_workspace_support(
    client, backlog_task
):
    app = client.app
    node = _register_node(
        app,
        "node_alice_downgraded",
        "machine-alice-downgraded",
        ["task-workspaces", "workspace-read-shared"],
    )
    controller = SessionController(
        app.state.session_store,
        task_store=app.state.task_store,
        task_id=backlog_task["id"],
        workspace_path=node["workspacePath"],
        owner_employee_id="alice",
        workspace_layout="task",
        workspace_subpath=f"tasks/{backlog_task['id']}",
        daemon_node_id=node["id"],
    )
    controller.create_session(backlog_task["title"], ["human", "codex"])
    _register_node(
        app,
        node["id"],
        "machine-alice-downgraded",
        ["workspace-read-shared"],
    )

    response = client.get(
        f"/api/v1/tasks/{backlog_task['id']}/workspace/files"
    )

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "placement-unavailable"


def test_newest_workspace_session_does_not_fall_back_to_an_older_node(
    client, backlog_task
):
    app = client.app
    capabilities = ["task-workspaces", "workspace-read-shared"]
    older = _register_node(
        app, "node_alice_older", "machine-alice-older", capabilities
    )
    newest = _register_node(
        app, "node_alice_newest", "machine-alice-newest", capabilities
    )
    for node in (older, newest):
        controller = SessionController(
            app.state.session_store,
            task_store=app.state.task_store,
            task_id=backlog_task["id"],
            workspace_path=node["workspacePath"],
            owner_employee_id="alice",
            workspace_layout="task",
            workspace_subpath=f"tasks/{backlog_task['id']}",
            daemon_node_id=node["id"],
        )
        controller.create_session(backlog_task["title"], ["human", "codex"])
    app.state.registry.delete(newest["id"])

    response = client.get(
        f"/api/v1/tasks/{backlog_task['id']}/workspace/files"
    )

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "placement-unavailable"


def test_falls_back_to_an_older_session_when_the_newest_was_deleted(client, task_with_run):
    # The newest linked session is hard-deleted without unlinking (the path a
    # direct store deletion takes, as opposed to the API's unlink-aware
    # delete). The task's linkedSessionIds still names it, so resolving the
    # workspace node must skip the now-missing session rather than 500.
    task, node = task_with_run(capabilities=["task-workspaces", "workspace-read-shared"])
    app = client.app
    older_session_id = task["linkedSessionIds"][0]

    controller = SessionController(
        app.state.session_store,
        task_store=app.state.task_store,
        task_id=task["id"],
        workspace_path=node["workspacePath"],
        owner_employee_id="alice",
        workspace_layout="task",
        daemon_node_id=node["id"],
    )
    newest_session_id = controller.create_session(task["title"], ["human", "codex"])["id"]
    app.state.session_store.delete_session(newest_session_id)

    task = client.get(f"/api/v1/tasks/{task['id']}").json()
    assert newest_session_id in task["linkedSessionIds"]
    assert older_session_id in task["linkedSessionIds"]

    response = client.get(f"/api/v1/tasks/{task['id']}/workspace/files")
    assert response.status_code == 200, response.text
    assert response.json()["nodeId"] == node["id"]


def test_reports_placement_unavailable_when_only_deleted_sessions_remain(client, task_with_run):
    task, node = task_with_run(capabilities=["task-workspaces", "workspace-read-shared"])
    app = client.app
    only_session_id = task["linkedSessionIds"][0]
    app.state.session_store.delete_session(only_session_id)

    response = client.get(f"/api/v1/tasks/{task['id']}/workspace/files")
    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "placement-unavailable"


def test_reports_placement_unavailable_when_session_layout_is_not_task(client, task_with_run):
    # A session recorded under a non-"task" layout (a legacy task, or a
    # dispatch that degraded because the node lacked task-workspaces) would
    # source a node whose files live elsewhere. Browsing must not claim the
    # task's workspace is empty in that case.
    task, node = task_with_run(capabilities=["task-workspaces", "workspace-read-shared"])
    app = client.app
    # The dispatched session already carries the "task" layout; replace it
    # with a "thread"-layout one so no eligible session remains, matching a
    # task whose only recorded session predates or degraded from that layout.
    app.state.session_store.delete_session(task["linkedSessionIds"][0])

    controller = SessionController(
        app.state.session_store,
        task_store=app.state.task_store,
        task_id=task["id"],
        workspace_path=node["workspacePath"],
        owner_employee_id="alice",
        workspace_layout="thread",
        daemon_node_id=node["id"],
    )
    controller.create_session(task["title"], ["human", "codex"])

    response = client.get(f"/api/v1/tasks/{task['id']}/workspace/files")
    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "placement-unavailable"


def test_browse_uses_recorded_subpath_after_daemon_replacement(client, backlog_task, monkeypatch):
    app = client.app
    old = _register_node(app, "old-runtime", "stable-machine", ["task-workspaces", "workspace-read-shared"])
    controller = SessionController(app.state.session_store, task_store=app.state.task_store,
        task_id=backlog_task["id"], owner_employee_id="alice", workspace_path=old["workspacePath"],
        workspace_layout="task", workspace_subpath="tasks/original-location", daemon_node_id=old["id"],
        computer_id=computer_id(old))
    controller.create_session("Keep files", ["human", "codex"])
    app.state.registry.delete(old["id"])
    new = _register_node(app, "new-runtime", "stable-machine", ["task-workspaces", "workspace-read-shared"])
    captured = {}
    async def dispatch(ctx, node, command):
        captured.update(command)
        return {"type": "workspace.listing", "path": "", "exists": True, "entries": []}
    monkeypatch.setattr("relay.api.task_routes.dispatch_workspace_command", dispatch)
    response = client.get(f"/api/v1/tasks/{backlog_task['id']}/workspace/files")
    assert response.status_code == 200, response.text
    assert response.json()["nodeId"] == new["id"]
    assert captured["workspaceSubpath"] == "tasks/original-location"
