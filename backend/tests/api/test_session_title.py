from __future__ import annotations

from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.app import create_app


def _bootstrap(client: TestClient) -> None:
    response = client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token",
        "username": "admin",
        "email": "admin@example.com", "password": "kestrel-vault-7719",
    })
    assert response.status_code == 200
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    assert response.status_code == 200


def _create_session(client: TestClient) -> str:
    response = client.post("/api/v1/threads", json={
        "taskGoal": "demo task",
        "assignments": [{"agent": "claude"}],
        "workspacePath": "/workspace",
    })
    assert response.status_code == 201
    return response.json()["id"]


def test_rename_endpoint_sets_title(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        session_id = _create_session(client)

        # Fresh session has no title; label falls back to taskGoal.
        snapshot = client.get(f"/api/v1/threads/{session_id}").json()
        assert snapshot.get("title") is None

        response = client.patch(f"/api/v1/threads/{session_id}", json={"title": "Auth bug"})
        assert response.status_code == 200
        assert response.json()["title"] == "Auth bug"

        # Title persists through replay (read back from a fresh materialization).
        reread = client.get(f"/api/v1/threads/{session_id}").json()
        assert reread["title"] == "Auth bug"


def test_rename_rejects_empty_title(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        session_id = _create_session(client)

        response = client.patch(f"/api/v1/threads/{session_id}", json={"title": "   "})
        assert response.status_code == 400


def test_rename_requires_known_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)

        response = client.patch("/api/v1/threads/sess_unknown", json={"title": "x"})
        assert response.status_code == 404
