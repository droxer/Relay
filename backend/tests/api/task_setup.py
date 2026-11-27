"""Task setup shared by HTTP tests that need work in Ready."""

from typing import Any

from fastapi.testclient import TestClient


def mark_task_ready(client: TestClient, task: dict[str, Any]) -> dict[str, Any]:
    assert task["status"] == "backlog", task
    response = client.patch(f"/api/v1/tasks/{task['id']}", json={"status": "assigned"})
    assert response.status_code == 200, response.text
    ready = response.json()
    assert ready["status"] == "assigned", ready
    return ready
