"""The notification inbox over HTTP: each person sees and marks only their own."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from user_ids import user_id

API = "/api/v1"
ADMIN_PASSWORD = "kestrel-vault-7719"
USER_PASSWORD = "harbor-lantern-5521"
ADA = user_id("ada")


@pytest.fixture
def admin(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    client = TestClient(create_app(tmp_path / "state"))
    response = client.post(
        f"{API}/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text
    response = client.post(f"{API}/admin/accounts", json={
        "username": "ada", "password": USER_PASSWORD, "role": "user", "userId": "ada",
    })
    assert response.status_code == 201, response.text
    return client


@pytest.fixture
def ada(admin: TestClient) -> TestClient:
    client = TestClient(admin.app)
    response = client.post(f"{API}/auth/login", json={"username": "ada", "password": USER_PASSWORD})
    assert response.status_code == 200, response.text
    return client


def _finish_task(client: TestClient, owner: str) -> str:
    tasks = client.app.state.task_store
    task = tasks.create_task({"title": "Write the report", "ownerUserId": owner})
    tasks.update_task(task["id"], {"status": "review"})
    return task["id"]


def test_a_finished_task_reaches_its_owners_inbox_only(admin: TestClient, ada: TestClient) -> None:
    task_id = _finish_task(ada, ADA)

    inbox = ada.get(f"{API}/notifications").json()
    [notice] = inbox["notifications"]
    assert inbox["unreadCount"] == 1
    assert notice["kind"] == "task_completed"
    assert notice["data"]["taskId"] == task_id
    assert notice["data"]["status"] == "review"
    assert notice["readAt"] is None
    assert admin.get(f"{API}/notifications").json() == {"notifications": [], "unreadCount": 0}


def test_marking_read_by_id_and_all(admin: TestClient, ada: TestClient) -> None:
    _finish_task(ada, ADA)
    _finish_task(ada, ADA)
    first, _ = (item["id"] for item in ada.get(f"{API}/notifications").json()["notifications"])

    # Someone else's id is ignored, never reported.
    assert admin.post(f"{API}/notifications/read", json={"ids": [first]}).json() == {"unreadCount": 0}
    assert ada.post(f"{API}/notifications/read", json={"ids": [first]}).json() == {"unreadCount": 1}
    assert ada.post(f"{API}/notifications/read", json={"all": True}).json() == {"unreadCount": 0}


@pytest.mark.parametrize("body", [{}, {"ids": "x"}, {"ids": [1]}, {"ids": [""]}, {"ids": ["x"] * 101}])
def test_mark_read_rejects_malformed_bodies(ada: TestClient, body: dict) -> None:
    assert ada.post(f"{API}/notifications/read", json=body).status_code == 400


def test_muted_kinds_hide_notices_until_unmuted(ada: TestClient) -> None:
    _finish_task(ada, ADA)

    muted = ada.put(f"{API}/notifications/preferences", json={"mutedKinds": ["task_completed"]})
    assert muted.status_code == 200
    assert muted.json()["mutedKinds"] == ["task_completed"]
    assert ada.get(f"{API}/notifications").json()["unreadCount"] == 0

    ada.put(f"{API}/notifications/preferences", json={"mutedKinds": []})
    assert ada.get(f"{API}/notifications").json()["unreadCount"] == 1
    assert set(ada.get(f"{API}/notifications/preferences").json()["kinds"]) == {
        "task_completed", "permission_requested", "computer_status", "client_outdated",
    }


@pytest.mark.parametrize("muted", ["task_completed", ["billing"], [3]])
def test_preferences_reject_unknown_kinds(ada: TestClient, muted: object) -> None:
    response = ada.put(f"{API}/notifications/preferences", json={"mutedKinds": muted})
    assert response.status_code == 400


def test_the_inbox_requires_a_signed_in_person(admin: TestClient) -> None:
    anonymous = TestClient(admin.app)
    assert anonymous.get(f"{API}/notifications").status_code == 401
