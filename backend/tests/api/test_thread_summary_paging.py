from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select, update

from relay.app import create_app
from relay.core.ids import new_database_id
from relay.persistence.events import relay_task_event
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


@pytest.mark.parametrize("view", ["summary", "records"])
def test_project_thread_pages_are_owner_scoped(paged_threads, view):
    client, _alice, _created = paged_threads
    app = client.app
    owner = user_id("alice")
    projects = app.state.project_store
    project = projects.create_project(owner, {"name": "Discussion", "computerId": "local", "members": []})
    foreign = projects.create_project(user_id("bob"), {"name": "Private", "computerId": "local", "members": []})
    discussions = SessionController(app.state.session_store, owner_user_id=owner, project_id=project["id"])
    older = discussions.create_session("First discussion", ["human"])["id"]
    newer = discussions.create_session("Second discussion", ["human"])["id"]
    # Even this owner's Threads cannot make somebody else's Project readable.
    SessionController(app.state.session_store, owner_user_id=owner, project_id=foreign["id"]).create_session(
        "Wrong project", ["human"],
    )
    SessionController(app.state.session_store, owner_user_id=user_id("bob"), project_id=project["id"]).create_session(
        "Wrong owner", ["human"],
    )
    projects.archive_project(project["id"], expected_version=project["version"])
    first_id, second_id = [thread_id for thread_id in _whole_list(client) if thread_id in {older, newer}]
    path = "/api/v1/threads"
    params = {"limit": 1, "view": view, "include": "activity", "projectId": project["id"]}
    first = client.get(path, params=params)
    assert first.status_code == 200, first.text
    body = first.json()
    assert [row["id"] for row in body["sessions"]] == [first_id]
    assert body["nextCursor"]
    assert "homeTaskNeedsYou" not in body
    second = client.get(path, params={**params, "cursor": body["nextCursor"]})
    assert second.status_code == 200, second.text
    assert [row["id"] for row in second.json()["sessions"]] == [second_id]
    assert second.json()["nextCursor"] is None

    if view == "summary":
        assert body["sessions"][0]["taskActivity"] == {"origin": None, "awaitsHuman": False}
        validator = {"If-None-Match": first.headers["etag"]}
        assert client.get(path, params=params, headers=validator).status_code == 304
        assert client.get(path, params={**params, "projectId": foreign["id"]}, headers=validator).status_code == 403
        empty = projects.create_project(owner, {"name": "Empty", "computerId": "local", "members": []})
        empty_page = client.get(path, params={**params, "projectId": empty["id"]}, headers=validator)
        assert empty_page.status_code == 200 and empty_page.json()["sessions"] == []
        discussions.rename_session(first_id, "Updated discussion")
        refreshed = client.get(path, params=params, headers=validator)
        assert refreshed.status_code == 200
        assert refreshed.json()["sessions"][0]["title"] == "Updated discussion"
    assert client.get(path, params={**params, "projectId": foreign["id"]}).status_code == 403
    assert client.get(path, params={**params, "projectId": new_database_id()}).status_code == 404
    assert client.get(path, params={**params, "projectId": ""}).status_code == 400


def test_project_thread_filters_run_before_paging_and_use_visible_task_links(paged_threads):
    client, _alice, _created = paged_threads
    app = client.app
    owner = user_id("alice")
    project = app.state.project_store.create_project(owner, {"name": "Launch", "computerId": "local", "members": []})
    controller = SessionController(app.state.session_store, owner_user_id=owner, project_id=project["id"])
    issue = controller.create_session("Review the 50% rollout", ["human"])["id"]
    chat = controller.create_session("Review the 500-user rollout", ["human"])["id"]
    controller.rename_session(chat, "Deployment")
    tasks = app.state.task_store
    task = tasks.create_task({"title": "Rollout", "ownerUserId": owner, "projectId": project["id"]})
    tasks.link_session(task["id"], issue)
    private = tasks.create_task({"title": "Private", "ownerUserId": user_id("bob")})
    tasks.link_session(private["id"], chat)
    params = {"projectId": project["id"], "view": "summary", "include": "activity", "limit": 1}
    path = "/api/v1/threads"

    matches = client.get(path, params={**params, "q": "50%", "kind": "tasks"})
    assert matches.status_code == 200, matches.text
    body = matches.json()
    assert [row["id"] for row in body["sessions"]] == [issue]
    assert body["sessions"][0]["taskActivity"]["origin"]["taskId"] == task["id"]
    assert body["nextCursor"] is None

    chats = client.get(path, params={**params, "q": "500-USER", "kind": "chats"})
    assert chats.status_code == 200, chats.text
    assert [row["id"] for row in chats.json()["sessions"]] == [chat]
    assert chats.json()["sessions"][0]["taskActivity"]["origin"] is None
    assert client.get(path, params={**params, "q": "50%", "kind": "chats"}).json()["sessions"] == []
    assert client.get(path, params={**params, "kind": "invalid"}).status_code == 400


def test_thread_records_page_without_loading_transcripts(paged_threads):
    client, _alice, created = paged_threads
    store = client.app.state.session_store
    statements = []

    def capture(_conn, _cursor, sql, *_args):
        statements.append(sql)

    event.listen(store.engine, "before_cursor_execute", capture)
    try:
        path = "/api/v1/threads"
        cursor = None
        found = []
        for expected_size in (2, 2, 1):
            params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
            page = client.get(path, params=params).json()
            assert len(page["sessions"]) == expected_size
            assert all("events" not in row and row["eventCount"] > 0 for row in page["sessions"])
            found.extend(row["id"] for row in page["sessions"])
            cursor = page["nextCursor"]
        assert cursor is None and set(found) == set(created) and len(found) == len(created)
        assert not any("FROM session_events" in sql for sql in statements)
    finally:
        event.remove(store.engine, "before_cursor_execute", capture)


def test_thread_summary_reads_linked_computer_liveness_once(paged_threads):
    client, _alice, created = paged_threads
    app = client.app
    owner = user_id("alice")
    for session in created:
        node_id = new_database_id()
        app.state.registry.register({
            "sandboxId": node_id, "token": f"token-{node_id}", "userId": owner,
            "workspaceId": node_id, "protocolVersion": 1, "supportedAgents": ["codex"],
        })
        app.state.daemon_store.create_run_request({
            "nodeId": node_id, "sessionId": session, "taskGoal": "Wait",
            "assignments": [{"executorKind": "codex"}], "state": {},
        })
    reads = []

    def capture(_conn, _cursor, statement, *_args):
        if "FROM daemon_nodes" in statement or "FROM daemon_node_agents" in statement:
            reads.append(statement)

    event.listen(app.state.daemon_store.engine, "before_cursor_execute", capture)
    try:
        response = client.get("/api/v1/threads?view=summary&limit=20")
    finally:
        event.remove(app.state.daemon_store.engine, "before_cursor_execute", capture)
    assert response.status_code == 200
    assert all(row["execution"]["computerOnline"] is True for row in response.json()["sessions"])
    assert len(reads) == 1
    assert reads[0].startswith("SELECT daemon_nodes.id, daemon_nodes.status, daemon_nodes.last_seen_at")


def test_thread_activity_projects_only_the_page_and_counts_snoozed_home_work(paged_threads, monkeypatch):
    client, _alice, _created = paged_threads
    store = client.app.state.task_store
    owner = user_id("alice")
    session_id = _whole_list(client)[0]
    linked = store.create_task({
        "title": "Linked issue", "ownerUserId": owner, "description": "x" * 10_000,
    })
    store.link_session(linked["id"], session_id)
    store.append_events(linked["id"], [relay_task_event("task.status", linked["id"], {
        "status": "waiting_for_human", "sessionId": session_id,
    })])
    review = store.create_task({"title": "Unlinked review", "ownerUserId": owner})
    review = store.append_events(review["id"], [relay_task_event("task.status", review["id"], {"status": "review"})])
    foreign = store.create_task({"title": "Private Task", "ownerUserId": user_id("bob")})
    store.link_session(foreign["id"], session_id)
    store.append_events(foreign["id"], [relay_task_event("task.status", foreign["id"], {"status": "review"})])
    assert client.patch("/api/v1/auth/preferences", json={
        "homeSnoozes": {"snooze": [{"key": f"task:{review['id']}", "stamp": review["updatedAt"]}]},
    }).status_code == 200

    def reject_collection_read(**_kwargs):
        pytest.fail("Thread summaries must use the Task projection")

    monkeypatch.setattr(store, "list_task_summaries", reject_collection_read)
    url = "/api/v1/threads?view=summary&include=activity&limit=1"
    response = client.get(url)
    assert response.status_code == 200
    body = response.json()
    assert body["homeTaskNeedsYou"] == 1
    [row] = body["sessions"]
    assert row["id"] == session_id
    assert row["taskActivity"] == {
        "origin": {"kind": "backlog", "taskId": linked["id"], "ref": f"#{linked['number']}",
                   "title": "Linked issue", "status": "waiting_for_human"},
        "awaitsHuman": True,
    }
    assert len(response.content) < 4_000
    older = client.get(f"{url}&cursor={body['nextCursor']}").json()
    assert "homeTaskNeedsYou" not in older
    assert older["sessions"][0]["taskActivity"] == {"origin": None, "awaitsHuman": False}

    cached = {"If-None-Match": response.headers["etag"]}
    assert client.get(url, headers=cached).status_code == 304
    store.append_events(linked["id"], [
        relay_task_event("task.status", linked["id"], {"status": "done"}),
    ])
    refreshed = client.get(url, headers=cached)
    assert refreshed.status_code == 200
    assert refreshed.json()["homeTaskNeedsYou"] == 0
    assert refreshed.json()["sessions"][0]["taskActivity"]["awaitsHuman"] is False


def test_summary_pages_walk_every_owned_thread_once_in_list_order(paged_threads):
    client, _alice, _created = paged_threads
    whole = _whole_list(client)

    pages = _pages(client, limit=2)

    # Threads created in one clock tick tie on updated_at; the id breaks the
    # tie, so pages must still split the one order without overlap.
    assert [len(page) for page in pages] == [2, 2, 1]
    assert [session_id for page in pages for session_id in page] == whole


def test_thread_activity_reads_one_origin_per_thread_with_many_linked_tasks(paged_threads, monkeypatch):
    client, _alice, _created = paged_threads
    store = client.app.state.task_store
    owner = user_id("alice")
    first, second, *_ = _whole_list(client)
    parent = store.create_task({"title": "Automation title", "ownerUserId": owner, "isRoutine": True})
    candidates = []
    for index in range(40):
        task = store.create_task({"title": f"Occurrence {index}", "ownerUserId": owner, "sourceRoutineId": parent["id"]})
        store.link_session(task["id"], first)
        store.link_session(task["id"], second)
        candidates.append(task["id"])
    waiting = store.create_task({"title": "Needs a reply", "ownerUserId": owner})
    store.append_events(waiting["id"], [relay_task_event("task.status", waiting["id"], {
        "status": "waiting_for_human", "sessionId": second,
    })])
    # When all timestamps tie, both SQL backends must pick the same winner.
    with store.engine.begin() as conn:
        stamp = conn.scalar(select(store.tasks.c.created_at).where(store.tasks.c.id == parent["id"]))
        conn.execute(update(store.tasks).where(store.tasks.c.id.in_(candidates)).values(updated_at=stamp))

    lookup = store.thread_list_task_links
    reads = []
    link_queries = []

    def record_links(_conn, cursor, statement, *_args):
        if statement.startswith("SELECT") and "FROM task_sessions JOIN tasks" in statement:
            link_queries.append(cursor.rowcount)

    def bounded(session_ids, user_id):
        origins, waits = lookup(session_ids, user_id)
        reads.append((len(session_ids), len(origins)))
        return origins, waits

    monkeypatch.setattr(store, "thread_list_task_links", bounded)
    event.listen(store.engine, "after_cursor_execute", record_links)
    try:
        response = client.get("/api/v1/threads?view=summary&include=activity&limit=2")
    finally:
        event.remove(store.engine, "after_cursor_execute", record_links)
    assert response.status_code == 200
    assert reads == [(2, 2)]
    # psycopg reports the rows returned by SELECT, while sqlite3 reports -1.
    assert link_queries == ([2] if store.engine.dialect.name == "postgresql" else [-1])
    rows = response.json()["sessions"]
    winner = store.get_task(max(candidates))
    assert [row["taskActivity"]["origin"] for row in rows] == [
        {"kind": "routine", "taskId": winner["id"], "ref": f"#{winner['number']}",
         "title": parent["title"], "status": "backlog"},
    ] * 2
    assert [row["taskActivity"]["awaitsHuman"] for row in rows] == [False, True]


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
