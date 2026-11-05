from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from test_tasks import _bootstrap_admin, _create_account, _login
from user_ids import user_id


@pytest.mark.parametrize("view", ["", "summary"])
@pytest.mark.parametrize("username", ["admin", "alice"])
def test_personal_task_lists_are_user_scoped_even_for_admins(monkeypatch, tmp_path, view, username):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    client = TestClient(create_app(str(tmp_path)))
    _bootstrap_admin(client)
    _create_account(client, "alice", user_id="alice")
    _create_account(client, "bob", user_id="bob")
    _login(client, username, "kestrel-vault-7719" if username == "admin" else "userpass")
    store = client.app.state.task_store
    owner = client.get("/api/v1/auth/me").json()["user"]["userId"]
    owned_task = store.create_task({"title": "My task", "ownerUserId": owner})
    store.create_task({
        "title": "Assigned to me", "ownerUserId": user_id("bob"), "assigneeUserId": owner,
    })
    own = store.create_task({
        "title": "My automation", "ownerUserId": owner,
        "assigneeUserId": owner, "isRoutine": True,
    })
    store.create_task({
        "title": "Bob's task", "ownerUserId": user_id("bob"),
        "assigneeUserId": user_id("bob"),
    })
    # Newer foreign automations must not consume the caller's list limit,
    # even when the caller is their assignee or the automation is ownerless.
    for foreign_owner in (user_id("bob"), None):
        store.create_task({
            "title": "Another automation", "ownerUserId": foreign_owner,
            "assigneeUserId": owner, "isRoutine": True,
        })

    response = client.get("/api/v1/tasks", params={"view": view})
    assert response.status_code == 200, response.text
    assert {task["id"] for task in response.json()["tasks"]} == {
        own["id"], owned_task["id"],
    }

    limited = client.get("/api/v1/tasks", params={"view": view, "limit": 1})
    assert limited.status_code == 200, limited.text
    assert [task["id"] for task in limited.json()["tasks"]] == [response.json()["tasks"][0]["id"]]


@pytest.mark.parametrize("username", ["admin", "alice"])
def test_personal_project_lists_are_owner_scoped_even_for_admins(monkeypatch, tmp_path, username):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    client = TestClient(create_app(str(tmp_path)))
    _bootstrap_admin(client)
    admin_id = client.get("/api/v1/auth/me").json()["user"]["userId"]
    _create_account(client, "alice", user_id="alice")
    store = client.app.state.project_store
    projects = {
        name: store.create_project(admin_id if name == "admin" else user_id(name), {
            "name": f"{name}'s project", "computerId": f"device:{name}", "members": [],
        })
        for name in ("admin", "alice")
    }
    _login(client, username, "kestrel-vault-7719" if username == "admin" else "userpass")

    response = client.get("/api/v1/projects")
    assert response.status_code == 200, response.text
    assert [project["id"] for project in response.json()["projects"]] == [projects[username]["id"]]
