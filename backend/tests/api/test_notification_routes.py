"""The notification inbox over HTTP: each person sees and marks only their own."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.persistence.notification import store as notification_rows

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
        json={"token": "admin_token", "username": "admin", "email": "admin@example.com", "password": ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text
    response = client.post(f"{API}/admin/accounts", json={
        "username": "ada", "email": "ada@example.com", "password": USER_PASSWORD, "role": "user", "userId": "ada",
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


def test_count_projection_skips_inbox_rows_and_respects_preferences(
    admin: TestClient, ada: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _finish_task(ada, ADA)
    _finish_task(ada, ADA)
    first, second = (item["id"] for item in ada.get(f"{API}/notifications").json()["notifications"])

    def unexpected_list(*_args: object, **_kwargs: object) -> None:
        pytest.fail("Count-only operations must not read the inbox rows")

    monkeypatch.setattr(ada.app.state.context.notification_store, "list_for_user", unexpected_list)
    endpoint = f"{API}/notifications?view=count&limit=1"
    assert ada.get(endpoint).json() == {"unreadCount": 2}
    assert admin.get(endpoint).json() == {"unreadCount": 0}
    assert TestClient(admin.app).get(endpoint).status_code == 401
    assert ada.post(f"{API}/notifications/read", json={"ids": [first]}).json() == {"unreadCount": 1}
    assert ada.put(f"{API}/notifications/preferences", json={"mutedKinds": ["task_completed"]}).status_code == 200
    assert ada.get(endpoint).json() == {"unreadCount": 0}
    assert ada.put(f"{API}/notifications/preferences", json={"mutedKinds": []}).status_code == 200
    assert ada.post(f"{API}/notifications/clear", json={"ids": [second]}).json() == {"unreadCount": 0}
    assert ada.get(endpoint).json() == {"unreadCount": 0}


def test_marking_read_by_id_and_all(admin: TestClient, ada: TestClient) -> None:
    _finish_task(ada, ADA)
    _finish_task(ada, ADA)
    first, _ = (item["id"] for item in ada.get(f"{API}/notifications").json()["notifications"])

    # Someone else's id is ignored, never reported.
    assert admin.post(f"{API}/notifications/read", json={"ids": [first]}).json() == {"unreadCount": 0}
    assert ada.post(f"{API}/notifications/read", json={"ids": [first]}).json() == {"unreadCount": 1}
    assert ada.post(f"{API}/notifications/read", json={"all": True}).json() == {"unreadCount": 0}


def test_inbox_revalidates_without_building_unchanged_details(
    admin: TestClient, ada: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _finish_task(ada, ADA)
    path = f"{API}/notifications?limit=50"
    first = ada.get(path)
    validator = {"If-None-Match": first.headers.get("etag", "")}
    def unexpected_projection(_row: object) -> None:
        pytest.fail("An unchanged inbox must skip projecting the detail rows")

    with monkeypatch.context() as scoped:
        scoped.setattr(notification_rows, "_public", unexpected_projection)
        unchanged = ada.get(path, params={"relayRevision": validator["If-None-Match"]})
    assert unchanged.status_code == 304
    assert unchanged.content == b""
    assert first.headers["cache-control"] == "no-store"
    assert admin.get(path, headers=validator).json()["notifications"] == []
    assert TestClient(admin.app).get(path, headers=validator).status_code == 401

    first_id = first.json()["notifications"][0]["id"]
    assert ada.post(f"{API}/notifications/read", json={"ids": [first_id]}).status_code == 200
    changed = ada.get(path, headers=validator)
    assert changed.status_code == 200
    assert changed.json()["unreadCount"] == 0


@pytest.mark.parametrize("body", [{}, {"ids": "x"}, {"ids": [1]}, {"ids": [""]}, {"ids": ["x"] * 101}])
def test_mark_read_rejects_malformed_bodies(ada: TestClient, body: dict) -> None:
    assert ada.post(f"{API}/notifications/read", json=body).status_code == 400


def test_clearing_by_id_and_all(admin: TestClient, ada: TestClient) -> None:
    _finish_task(ada, ADA)
    _finish_task(ada, ADA)
    first, second = (item["id"] for item in ada.get(f"{API}/notifications").json()["notifications"])

    # Someone else's id is ignored, never reported.
    assert admin.post(f"{API}/notifications/clear", json={"ids": [first]}).json() == {"unreadCount": 0}
    assert ada.post(f"{API}/notifications/clear", json={"ids": [first]}).json() == {"unreadCount": 1}
    assert [item["id"] for item in ada.get(f"{API}/notifications").json()["notifications"]] == [second]
    assert ada.post(f"{API}/notifications/clear", json={"all": True}).json() == {"unreadCount": 0}
    assert ada.get(f"{API}/notifications").json() == {"notifications": [], "unreadCount": 0}


@pytest.mark.parametrize("body", [{}, {"ids": "x"}, {"ids": [1]}, {"ids": [""]}, {"ids": ["x"] * 101}])
def test_clear_rejects_malformed_bodies(ada: TestClient, body: dict) -> None:
    assert ada.post(f"{API}/notifications/clear", json=body).status_code == 400


def test_muted_kinds_hide_notices_until_unmuted(ada: TestClient) -> None:
    _finish_task(ada, ADA)

    muted = ada.put(f"{API}/notifications/preferences", json={"mutedKinds": ["task_completed"]})
    assert muted.status_code == 200
    assert muted.json()["mutedKinds"] == ["task_completed"]
    assert ada.get(f"{API}/notifications").json()["unreadCount"] == 0

    ada.put(f"{API}/notifications/preferences", json={"mutedKinds": []})
    assert ada.get(f"{API}/notifications").json()["unreadCount"] == 1
    assert set(ada.get(f"{API}/notifications/preferences").json()["kinds"]) == {
        "task_completed", "approval_requested", "permission_requested", "computer_status", "client_outdated", "computer_transport",
    }


@pytest.mark.parametrize("muted", ["task_completed", ["billing"], [3]])
def test_preferences_reject_unknown_kinds(ada: TestClient, muted: object) -> None:
    response = ada.put(f"{API}/notifications/preferences", json={"mutedKinds": muted})
    assert response.status_code == 400


def test_the_inbox_requires_a_signed_in_person(admin: TestClient) -> None:
    anonymous = TestClient(admin.app)
    assert anonymous.get(f"{API}/notifications").status_code == 401
