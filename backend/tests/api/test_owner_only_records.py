from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.sessions.controller import SessionController
from test_tasks import _bootstrap_admin, _create_account, _login
from test_auth import _add_workspace_file_artifact
from user_ids import user_id


@pytest.fixture
def owned_records(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    app = create_app(str(tmp_path))
    admin = TestClient(app)
    _bootstrap_admin(admin)
    admin_id = admin.get("/api/v1/auth/me").json()["user"]["userId"]
    _create_account(admin, "alice", user_id="alice")
    task = app.state.task_store.create_task({
        "title": "Alice private task", "ownerUserId": user_id("alice"), "assigneeUserId": admin_id,
    })
    routine = app.state.task_store.create_task({
        "title": "Alice private automation", "ownerUserId": user_id("alice"),
        "isRoutine": True, "routineTriggers": [{"kind": "webhook"}], "routineState": "paused",
    })
    thread = SessionController(app.state.session_store, owner_user_id=user_id("alice")).create_session("Private", ["human"])
    project = app.state.project_store.create_project(user_id("alice"), {
        "name": "Alice private project", "computerId": "private-computer", "members": [],
    })
    return admin, app, {"task": task["id"], "routine": routine["id"], "thread": thread["id"], "project": project["id"]}


@pytest.mark.parametrize("method,path", [
    ("GET", "/tasks/{task}"), ("GET", "/tasks/{task}/events"),
    ("GET", "/tasks/{task}/review"), ("GET", "/tasks/{task}/artifacts"),
    ("GET", "/tasks/{task}/files"), ("PATCH", "/tasks/{task}"),
    ("DELETE", "/tasks/{task}"), ("POST", "/tasks/{task}/runs"),
    ("PUT", "/tasks/{task}/assignment"), ("PUT", "/tasks/{task}/prerequisites"),
    ("GET", "/tasks/{routine}"), ("POST", "/tasks/{routine}/automation/resume"),
    ("GET", "/tasks/{routine}/automation/webhook-secret"),
    ("POST", "/tasks/{routine}/automation/webhook-secret"),
    ("GET", "/threads/{thread}"), ("GET", "/threads/{thread}/artifacts/missing"),
    ("POST", "/threads/{thread}/permission-requests/missing"),
    ("GET", "/projects/{project}"), ("GET", "/projects/{project}/workspace/files"),
    ("GET", "/workspace/brief?projectId={project}"),
    ("GET", "/workspace/brief?userId=" + user_id("alice")),
    ("GET", "/artifacts?userId=" + user_id("alice")),
])
def test_admin_cannot_read_or_mutate_another_users_records_by_id(owned_records, method, path):
    admin, _app, ids = owned_records
    response = admin.request(method, "/api/v1" + path.format(**ids), **({"json": {}} if method != "GET" else {}))
    assert response.status_code == 403, response.text


def test_owner_still_reads_records_and_assignee_does_not_gain_visibility(owned_records):
    admin, app, ids = owned_records
    listed = admin.get("/api/v1/tasks").json()["tasks"]
    assert ids["task"] not in {task["id"] for task in listed}
    owner = TestClient(app)
    _login(owner, "alice")
    for path in ("/tasks/{task}", "/tasks/{routine}", "/threads/{thread}", "/projects/{project}"):
        response = owner.get("/api/v1" + path.format(**ids))
        assert response.status_code == 200, response.text


def test_owned_task_does_not_expose_a_foreign_linked_thread(owned_records, monkeypatch):
    admin, app, ids = owned_records
    owner = admin.get("/api/v1/auth/me").json()["user"]["userId"]
    own_task = app.state.task_store.create_task({"title": "Mine", "ownerUserId": owner})
    app.state.task_store.link_session(own_task["id"], ids["thread"])
    _add_workspace_file_artifact(app, ids["thread"], "private.txt", "/private/private.txt")

    async def dispatch(*_args):
        pytest.fail("A foreign Thread must not supply the task's live file root")

    monkeypatch.setattr("relay.api.tasks.workspace_files.dispatch_workspace_command", dispatch)
    artifacts = admin.get(f"/api/v1/tasks/{own_task['id']}/artifacts")
    assert artifacts.status_code == 200
    assert artifacts.json()["artifacts"] == []
    files = admin.get(f"/api/v1/tasks/{own_task['id']}/workspace/files")
    assert files.status_code == 403, files.text


def test_agent_run_cannot_reopen_someone_elses_thread(owned_records):
    admin, _app, ids = owned_records
    response = admin.post("/api/v1/agent-runs", json={
        "sessionId": ids["thread"], "taskGoal": "Do not reopen", "assignments": [{"agentId": "missing"}],
    })
    assert response.status_code == 403, response.text


@pytest.mark.parametrize("operation", ["create", "update", "start"])
def test_private_task_cannot_be_dispatched_as_another_user(owned_records, operation):
    admin, app, _ids = owned_records
    owner = admin.get("/api/v1/auth/me").json()["user"]["userId"]
    if operation == "create":
        response = admin.post("/api/v1/tasks", json={"title": "Private", "assigneeUserId": user_id("alice")})
    else:
        task = app.state.task_store.create_task({
            "title": "Private", "ownerUserId": owner, "assigneeUserId": user_id("alice") if operation == "start" else owner,
            "status": "assigned", "sourceRoutineId": "legacy-routine",
        })
        response = (admin.patch(f"/api/v1/tasks/{task['id']}", json={"assigneeUserId": user_id("alice")})
                    if operation == "update" else admin.post(f"/api/v1/tasks/{task['id']}/runs", json={}))
    assert response.status_code == 403, response.text
