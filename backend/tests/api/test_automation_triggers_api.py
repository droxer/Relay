from __future__ import annotations

from datetime import date
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.app import create_app

from test_tasks import _bootstrap_admin, _create_agent, _create_user

WEBHOOK = {"kind": "webhook"}
ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


def _client(monkeypatch, root: str) -> tuple[TestClient, dict]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    client = TestClient(create_app(root))
    _bootstrap_admin(client)
    _create_user(client, "alice", employee_id="alice")
    return client, _create_agent(client, "alice")


def _routine(client: TestClient, agent: dict, **extra) -> dict:
    response = client.post("/api/v1/tasks", json={
        "title": "Triage failures", "description": "Look into it.",
        "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
        "assignedAgentId": agent["id"], "isRoutine": True, "routineEnabled": True,
        "routineCadence": "weekly", **extra,
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_event_trigger_round_trips_and_clears_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent, routineTrigger=ON_BLOCKED)
        assert created["routineTrigger"] == ON_BLOCKED
        assert "routineNextRunDate" not in created
        assert client.app.state.task_store.list_due_routines("2099-01-01") == []


def test_routine_without_trigger_reads_as_schedule(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent)
        assert "routineTrigger" not in created
        assert created["routineNextRunDate"]


def test_switching_trigger_kind_moves_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent)
        to_webhook = client.patch(f"/api/v1/tasks/{created['id']}", json={"routineTrigger": WEBHOOK})
        assert to_webhook.status_code == 200, to_webhook.text
        assert "routineNextRunDate" not in to_webhook.json()
        back = client.patch(f"/api/v1/tasks/{created['id']}", json={"routineTrigger": {"kind": "schedule"}})
        assert back.json()["routineTrigger"] == {"kind": "schedule"}
        assert back.json()["routineNextRunDate"] > date.today().isoformat()


def test_invalid_trigger_is_a_400(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        response = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
            "routineTrigger": {"kind": "task_event", "on": "completed"},
        })
        assert response.status_code == 400
        missing = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
            "routineTrigger": {"kind": "task_event", "on": "created", "filters": {"projectId": "nope"}},
        })
        assert missing.status_code == 400
        assert "projectId" in missing.json()["detail"]
