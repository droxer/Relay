"""Admin user capacity controls the same cross-project WIP admission boundary."""

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.persistence.events import relay_task_event


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "capacity-admin-token")
    client = TestClient(create_app(str(tmp_path)))
    assert (
        client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "capacity-admin-token", "username": "admin", "password": "kestrel-vault-7719"},
        ).status_code
        == 200
    )
    return client


def create_user(client, **fields):
    response = client.post(
        "/api/v1/admin/users",
        json={"userId": "alice", "username": "alice", "password": "a-strong-capacity-password", **fields},
    )
    assert response.status_code == 201, response.text
    return response.json()["user"]


def claim(store, task):
    return store.append_event(
        task["id"],
        relay_task_event("task.execution.claimed", task["id"], {"requestId": task["id"], "expectedRevision": 0}),
    )


def test_default_capacity_is_five_and_admin_can_change_it(client):
    user = create_user(client)
    assert user["effectiveMaxConcurrentTasks"] == 5
    response = client.patch(f"/api/v1/admin/users/{user['id']}", json={"maxConcurrentTasks": 2})
    assert response.status_code == 200
    assert response.json()["user"]["maxConcurrentTasks"] == 2
    for invalid in (0, 101, True, "2"):
        assert (
            client.patch(f"/api/v1/admin/users/{user['id']}", json={"maxConcurrentTasks": invalid}).status_code == 400
        )
    store = client.app.state.task_store
    tasks = [store.create_task({"title": str(i), "ownerUserId": user["id"]}) for i in range(3)]
    claim(store, tasks[0])
    claim(store, tasks[1])
    with pytest.raises(ValueError, match="task_wip_limit"):
        claim(store, tasks[2])
    client.patch(f"/api/v1/admin/users/{user['id']}", json={"maxConcurrentTasks": 3})
    assert claim(store, tasks[2])["startedAt"]
    # Reductions do not cancel previously admitted work.
    client.patch(f"/api/v1/admin/users/{user['id']}", json={"maxConcurrentTasks": 1})
    assert store.count_wip(user["id"]) == 3
    assert (
        store.append_event(
            tasks[0]["id"],
            relay_task_event(
                "task.execution.claimed", tasks[0]["id"], {"requestId": "continuation", "expectedRevision": 1}
            ),
        )["executionOwner"]["revision"]
        == 2
    )
    cleared = client.patch(f"/api/v1/admin/users/{user['id']}", json={"maxConcurrentTasks": None}).json()["user"]
    assert cleared["maxConcurrentTasks"] is None
    assert cleared["effectiveMaxConcurrentTasks"] == 5
    # A user's own flow response uses the persisted setting, not an admin's capacity.
    client.patch(f"/api/v1/admin/users/{user['id']}", json={"maxConcurrentTasks": 7})
    client.post("/api/v1/auth/logout")
    assert (
        client.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "a-strong-capacity-password"}
        ).status_code
        == 200
    )
    assert client.get("/api/v1/tasks?view=summary").json()["flowPolicy"]["wipLimit"] == 7
    assert client.patch(f"/api/v1/admin/users/{user['id']}", json={"maxConcurrentTasks": 99}).status_code == 403


@pytest.mark.parametrize("value", [0, -1, 101, True, 1.5, "2"])
def test_capacity_validation_rejects_invalid_values_without_creating_users(client, value):
    response = client.post(
        "/api/v1/admin/users",
        json={
            "userId": "bad-limit",
            "username": "bad-limit",
            "password": "a-strong-capacity-password",
            "maxConcurrentTasks": value,
        },
    )
    assert response.status_code == 400
    assert not any(u.get("handle") == "bad-limit" for u in client.get("/api/v1/admin/users").json()["users"])


def test_capacity_can_be_set_at_user_creation_and_other_users_keep_the_default(client):
    user = create_user(client, maxConcurrentTasks=1)
    assert user["maxConcurrentTasks"] == 1
    assert user["effectiveMaxConcurrentTasks"] == 1
    users = client.get("/api/v1/admin/users").json()["users"]
    assert next(u for u in users if u["id"] != user["id"])["effectiveMaxConcurrentTasks"] == 5
