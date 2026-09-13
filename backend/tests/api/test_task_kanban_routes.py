import pytest
from fastapi.testclient import TestClient
from relay.app import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "test-kanban-token")
    client = TestClient(create_app(str(tmp_path)))
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={
            "token": "test-kanban-token",
            "username": "admin",
            "password": "test-kanban-password",
        },
    )
    assert response.status_code == 200
    return client


def test_new_tasks_require_review_and_cannot_fabricate_execution(client):
    task = client.post("/api/v1/tasks", json={"title": "Deliver"}).json()
    assert task["acceptancePolicy"] == "human"
    for state in ["running", "review", "done", "waiting_for_human"]:
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={"status": state})
        assert response.status_code == 409
    for state in ["running", "review", "done"]:
        assert (
            client.post(
                "/api/v1/tasks", json={"title": "Invalid", "status": state}
            ).status_code
            == 400
        )


def test_review_acceptance_and_block_restore(client):
    task = client.post("/api/v1/tasks", json={"title": "Deliver"}).json()
    store = client.app.state.task_store
    store.update_task(task["id"], {"status": "running"})
    store.update_task(task["id"], {"status": "review"})
    url = f"/api/v1/tasks/{task['id']}"
    assert client.patch(url, json={"status": "blocked"}).status_code == 400
    blocked = client.patch(
        url, json={"status": "blocked", "blockerReason": "Need approval"}
    ).json()
    assert blocked["workflowStage"] == "review"
    restored = client.patch(url, json={"action": "unblock"}).json()
    assert restored["status"] == "review"
    accepted = client.patch(url, json={"status": "done"}).json()
    assert accepted["finishedAt"]
    assert accepted["status"] == "done"


def test_acceptance_policy_validation(client):
    assert (
        client.post(
            "/api/v1/tasks", json={"title": "Invalid", "acceptancePolicy": "anything"}
        ).status_code
        == 400
    )
    task = client.post(
        "/api/v1/tasks", json={"title": "Automated", "acceptancePolicy": "automatic"}
    ).json()
    assert task["acceptancePolicy"] == "automatic"


def test_policy_locks_after_work_starts_and_rework_preserves_age(client):
    task = client.post("/api/v1/tasks", json={"title": "Deliver"}).json()
    store = client.app.state.task_store
    started = store.update_task(task["id"], {"status": "running"})
    url = f"/api/v1/tasks/{task['id']}"
    assert client.patch(url, json={"acceptancePolicy": "automatic"}).status_code == 409
    assert client.patch(url, json={"status": "backlog"}).status_code == 409
    assert client.patch(url, json={"status": "done"}).status_code == 409
    blocked = client.patch(
        url, json={"status": "blocked", "blockerReason": "Missing credentials"}
    ).json()
    assert blocked["workflowStage"] == "running"
    restored = client.patch(url, json={"action": "unblock"}).json()
    assert restored["status"] == "waiting_for_human"
    assert restored["workflowStage"] == "running"
    assert restored["startedAt"] == started["startedAt"]
    assert client.patch(url, json={"action": "unblock"}).status_code == 409
    assert client.patch(url, json={"action": "fake"}).status_code == 400
    assert client.patch(url, json={"status": "review"}).status_code == 200
    assert client.patch(url, json={"status": "done"}).status_code == 200
    assert (
        client.patch(url, json={"status": "blocked", "blockerReason": "No"}).status_code
        == 409
    )


def test_flow_policy_is_visible_without_exposing_other_employees_tasks(client):
    response = client.get("/api/v1/tasks?view=summary").json()
    assert response["flowPolicy"] == {"wipLimit": 5, "scope": "employee"}
