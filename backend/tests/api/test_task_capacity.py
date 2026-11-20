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
            json={"token": "capacity-admin-token", "username": "admin", "email": "admin@example.com", "password": "kestrel-vault-7719"},
        ).status_code
        == 200
    )
    return client


def create_user(client, **fields):
    response = client.post(
        "/api/v1/admin/users",
        json={"userId": "alice", "username": "alice", "email": "alice@example.com", "password": "a-strong-capacity-password", **fields},
    )
    assert response.status_code == 201, response.text
    return response.json()["user"]


def claim(store, task):
    return store.append_event(
        task["id"],
        relay_task_event("task.execution.claimed", task["id"], {"requestId": task["id"], "expectedRevision": 0}),
    )


def test_admin_user_pages_include_only_their_computers_and_search_the_full_roster(client, monkeypatch):
    ctx = client.app.state.context
    for i in range(31):
        ctx.auth_store.ensure_user(f"page-{i}", display_name=f"Team member {i:02}")
    target = ctx.auth_store.ensure_user("target-user", display_name="ZZZ target")
    target_id = target["id"]
    monkeypatch.setattr(ctx.registry, "monitor_nodes", lambda: [
        {"id": "remote-a", "displayName": "Build host Ä", "userId": target_id,
         "status": "running", "stale": False, "online": True, "nodeLocation": "user-device",
         "activeRuns": [{"taskTitle": "private transcript"}], "nodeToken": "not-in-the-roster"},
        {"id": "remote-b", "displayName": "Second workstation", "userId": target_id,
         "status": "ready", "stale": True, "online": False, "nodeLocation": "user-device"},
    ])
    path = "/api/v1/admin/users"
    first = client.get(path, params={"view": "web", "sort": "user"})
    assert first.status_code == 200
    payload = first.json()
    assert len(payload["users"]) == 25
    assert payload["nodes"] == []
    assert payload["userCount"] == 33
    assert payload["page"] == {"page": 1, "total": 33}
    assert payload["counts"] == {"all": 33, "running": 1, "ready": 0, "failed": 1, "idle": 0, "unassigned": 32}
    assert client.get(path, params={"view": "web", "sort": "user"}, headers={
        "If-None-Match": first.headers["etag"],
    }).status_code == 304
    last = client.get(path, params={"view": "web", "sort": "user", "page": 99}).json()
    assert last["page"] == {"page": 2, "total": 33}
    assert last["users"][-1]["id"] == target_id
    scoped = client.get(path, params={"view": "web", "q": "BUILD HOST Ä", "filter": "failed"}).json()
    assert scoped["page"] == {"page": 1, "total": 1}
    assert [user["id"] for user in scoped["users"]] == [target_id]
    assert [node["id"] for node in scoped["nodes"]] == ["remote-a", "remote-b"]
    assert scoped["users"][0]["localComputerCount"] == 2
    assert not {"nodeToken", "activeRuns"} & scoped["nodes"][0].keys()
    assert len(client.get(path).json()["users"]) == 33


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
            "email": "bad-limit@example.com", "password": "a-strong-capacity-password",
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
