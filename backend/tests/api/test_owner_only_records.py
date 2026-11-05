from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.sessions.controller import SessionController
from test_tasks import _bootstrap_admin, _create_account, _login
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
