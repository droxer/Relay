from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.sessions.controller import SessionController
from test_tasks import _bootstrap_admin, _create_account, _login
from user_ids import user_id


@pytest.fixture
def paged_threads(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap_admin(client)
    admin_id = client.get("/api/v1/auth/me").json()["user"]["userId"]
    _create_account(client, "alice", user_id="alice")
    alice = SessionController(app.state.session_store, owner_user_id=user_id("alice"))
    created = [alice.create_session(f"thread {index}", ["human"])["id"] for index in range(5)]
    SessionController(app.state.session_store, owner_user_id=admin_id).create_session(
        "admin's thread", ["human"],
    )
    _login(client, "alice", "userpass")
    return client, alice, created


def _pages(client: TestClient, limit: int) -> list[list[str]]:
    pages: list[list[str]] = []
    cursor: str | None = None
    while True:
        query = f"/api/v1/threads?view=summary&limit={limit}" + (f"&cursor={cursor}" if cursor else "")
        response = client.get(query)
        assert response.status_code == 200, response.text
        body = response.json()
        pages.append([row["id"] for row in body["sessions"]])
        cursor = body["nextCursor"]
        if cursor is None:
            return pages


def _whole_list(client: TestClient) -> list[str]:
    body = client.get("/api/v1/threads?view=summary&limit=20").json()
    assert body["nextCursor"] is None
    return [row["id"] for row in body["sessions"]]


def test_summary_last_page_has_no_cursor(paged_threads):
    client, _alice, created = paged_threads

    assert sorted(_whole_list(client)) == sorted(created)


def test_summary_pages_walk_every_owned_thread_once_in_list_order(paged_threads):
    client, _alice, _created = paged_threads
    whole = _whole_list(client)

    pages = _pages(client, limit=2)

    # Threads created in one clock tick tie on updated_at; the id breaks the
    # tie, so pages must still split the one order without overlap.
    assert [len(page) for page in pages] == [2, 2, 1]
    assert [session_id for page in pages for session_id in page] == whole


def test_summary_thread_moved_to_top_is_not_served_twice(paged_threads):
    client, alice, _created = paged_threads
    whole = _whole_list(client)
    first = client.get("/api/v1/threads?view=summary&limit=2").json()
    oldest = whole[-1]

    alice.rename_session(oldest, "renamed after the first page")
    rest = client.get(f"/api/v1/threads?view=summary&limit=10&cursor={first['nextCursor']}").json()

    assert [row["id"] for row in rest["sessions"]] == whole[2:-1]


@pytest.mark.parametrize("cursor", ["not-a-cursor", "e30", "eyJ1IjoieCIsImkiOiJ5In0"])
def test_summary_rejects_a_malformed_cursor(paged_threads, cursor):
    client, _alice, _created = paged_threads

    response = client.get(f"/api/v1/threads?view=summary&cursor={cursor}")

    assert response.status_code == 400
