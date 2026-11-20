"""Task prerequisites over HTTP, and the dispatch queue that honours them."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from relay.app import create_app
from relay.persistence.events import relay_task_event
from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer


@pytest.fixture
def project_context(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice_prereq", "prereq-computer")
    lead = _agent(client, app, node, "Lead", "codex")
    _login_alice(client)
    created = client.post("/api/v1/projects", json={
        "name": "Ordered work", "daemonNodeId": node["id"], "leadAgentId": lead["id"],
        "members": [dict(agentId=lead["id"], role="implementer", responsibilities="Deliver", enabled=True)],
    })
    assert created.status_code == 201, created.text
    return app, client, created.json()["project"]


def _task(client, project, title: str) -> dict:
    response = client.post("/api/v1/tasks", json={"title": title, "projectId": project["id"]})
    assert response.status_code == 201, response.text
    return response.json()


def _set(client, task, ids):
    return client.put(f"/api/v1/tasks/{task['id']}/prerequisites", json={"prerequisiteTaskIds": ids})


def test_project_scope_filters_summaries_before_limit(project_context):
    _app, client, project = project_context
    first, second = _task(client, project, "Design"), _task(client, project, "Build")
    assert _set(client, second, [first["id"]]).status_code == 200
    intake = client.post("/api/v1/tasks", json={"title": "Unrelated work"}).json()

    global_path = "/api/v1/tasks?view=summary&limit=1"
    scoped_path = f"{global_path}&projectId={project['id']}"
    response = client.get(scoped_path)
    [listed] = response.json()["tasks"]
    assert listed["id"] == second["id"]
    assert [row["id"] for row in listed["waitingOnSummaries"]] == [first["id"]]
    assert client.get(global_path).json()["tasks"][0]["id"] == intake["id"]
    assert client.get(scoped_path, headers={"If-None-Match": response.headers["etag"]}).status_code == 304
    assert client.get(f"{global_path}&projectId=invalid").json()["tasks"] == []


def test_home_projects_count_all_issues_but_load_only_inbox_candidates(project_context):
    app, client, project = project_context
    store = app.state.task_store
    dormant = _task(client, project, "Quiet issue")
    deadline = _task(client, project, "Due soon")
    store.update_task(deadline["id"], {"dueDate": "2099-01-02", "description": "Details that Home does not render"})
    blocked = _task(client, project, "Has a prerequisite")
    assert _set(client, blocked, [dormant["id"]]).status_code == 200
    finished = [_task(client, project, f"Finished {i}") for i in range(7)]
    for task in finished:
        store.update_task(task["id"], {"status": "done"})

    response = client.get("/api/v1/tasks?view=summary&scope=home")
    assert response.status_code == 200, response.text
    data = response.json()
    rows = {task["id"]: task for task in data["tasks"]}
    assert set(rows) == {deadline["id"], blocked["id"], *(task["id"] for task in finished[-5:])}
    assert rows[deadline["id"]]["description"] == ""
    assert rows[blocked["id"]]["waitingOnSummaries"][0]["id"] == dormant["id"]
    counts = data["homeProjects"][project["id"]]
    assert counts["total"] == 10
    assert counts["progress"] == {"done": 7, "review": 0, "running": 0, "blocked": 0}
    assert counts["updatedAt"]
    assert {task["id"] for task in client.get("/api/v1/tasks?view=summary").json()["tasks"]} >= {dormant["id"], finished[0]["id"]}


def test_activity_pages_preserve_status_context_and_skip_task_replay(project_context, monkeypatch):
    app, client, project = project_context
    task = _task(client, project, "Activity pages")
    store = app.state.task_store
    for status in ("running", "waiting_for_human", "running", "review"):
        store.append_event(task["id"], relay_task_event("task.status", task["id"], {"status": status}))
    route = f"/api/v1/tasks/{task['id']}/events"
    complete = client.get(route).json()["events"]
    assert len(complete) > 3

    def no_replay(*_args, **_kwargs):
        pytest.fail("The activity page must not replay the event log")

    monkeypatch.setattr(store, "get_task", no_replay)
    first = client.get(route, params={"view": "activity", "limit": 2}).json()
    assert [event["status"] for event in first["events"]] == ["running", "review"]
    assert first["previousStatus"] == "waiting_for_human"
    second = client.get(route, params={"view": "activity", "limit": 2, "before": first["nextBefore"]}).json()
    assert [event["status"] for event in second["events"]] == ["running", "waiting_for_human"]
    assert second["previousStatus"] == "backlog"
    assert TestClient(app).get(route, params={"view": "activity"}).status_code == 401


def test_set_read_and_clear_prerequisites(project_context):
    _app, client, project = project_context
    first, second = _task(client, project, "Design"), _task(client, project, "Build")

    response = _set(client, second, [first["id"]])

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["prerequisiteTaskIds"] == [first["id"]]
    assert body["waitingOn"] == [first["id"]]
    assert client.get(f"/api/v1/tasks/{first['id']}").json()["unblocks"] == [second["id"]]
    listed = {task["id"]: task for task in client.get("/api/v1/tasks").json()["tasks"]}
    assert listed[second["id"]]["waitingOn"] == [first["id"]]
    assert listed[first["id"]]["waitingOn"] == []

    cleared = _set(client, second, [])
    assert cleared.status_code == 200
    assert "prerequisiteTaskIds" not in cleared.json()
    assert client.get(f"/api/v1/tasks/{first['id']}").json()["unblocks"] == []


def test_cycle_self_and_scope_are_refused(project_context):
    _app, client, project = project_context
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200

    cycle = _set(client, first, [second["id"]])
    assert (cycle.status_code, cycle.json()["detail"]) == (409, "task_prerequisite_cycle")
    own = _set(client, first, [first["id"]])
    assert (own.status_code, own.json()["detail"]) == (400, "task_prerequisite_self")
    intake = client.post("/api/v1/tasks", json={"title": "Loose"}).json()
    scope = _set(client, first, [intake["id"]])
    assert (scope.status_code, scope.json()["detail"]) == (409, "task_prerequisite_scope")
    bad = client.put(f"/api/v1/tasks/{first['id']}/prerequisites", json={"prerequisiteTaskIds": "x"})
    assert bad.status_code == 400


def test_dispatch_queue_holds_a_task_until_its_prerequisite_is_done(project_context):
    app, client, project = project_context
    store = app.state.task_store
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200
    for task in (first, second):
        store.update_task(task["id"], {"status": "assigned"})

    queued = {task["id"] for task in store.list_dispatchable_tasks()}
    assert first["id"] in queued and second["id"] not in queued

    store.update_task(first["id"], {"status": "done"})
    assert second["id"] in {task["id"] for task in store.list_dispatchable_tasks()}


def test_deleting_a_prerequisite_releases_its_dependent(project_context):
    app, client, project = project_context
    store = app.state.task_store
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200
    store.update_task(second["id"], {"status": "assigned"})

    store.delete_task(first["id"])

    assert second["id"] in {task["id"] for task in store.list_dispatchable_tasks()}
    assert client.get(f"/api/v1/tasks/{second['id']}").json()["waitingOn"] == []


def test_manual_start_is_refused_while_waiting(project_context):
    _app, client, project = project_context
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200

    response = client.post(f"/api/v1/tasks/{second['id']}/runs", json={})

    assert (response.status_code, response.json()["detail"]) == (409, "task_prerequisites_open")


def test_pickup_and_claim_refuse_a_waiting_task(project_context):
    app, client, project = project_context
    store = app.state.task_store
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200
    store.update_task(second["id"], {"status": "assigned", "assignedAgent": "codex"})

    pickup = client.post(f"/api/v1/tasks/{second['id']}/pickups", json={"agentId": "x"})

    assert (pickup.status_code, pickup.json()["detail"]) == (409, "task_prerequisites_open")
    assert store.claim_task_for_dispatch(second["id"], "codex") is None


def test_list_dependency_summary_respects_project_access(project_context, monkeypatch):
    app, client, project = project_context
    store = app.state.task_store
    bob = app.state.auth_store.ensure_user("bob", display_name="Sam Lee")
    upstream = store.create_task({"title": "Bob's upstream work", "description": "private evidence", "ownerUserId": bob["id"], "assigneeUserId": bob["id"], "projectId": project["id"]})
    dependent = _task(client, project, "Alice's dependent work")
    assert _set(client, dependent, [upstream["id"]]).status_code == 200
    rows = {t["id"]: t for t in client.get("/api/v1/tasks?view=summary").json()["tasks"]}
    assert upstream["id"] not in rows
    assert rows[dependent["id"]]["waitingOnSummaries"] == []
    assert client.get(f"/api/v1/tasks/{upstream['id']}").status_code == 403

    # An accessible task alone does not grant the project's private metadata.
    monkeypatch.setattr(app.state.project_store, "get_project", lambda _id: {**project, "ownerUserId": "bob"})
    hidden_rows = {t["id"]: t for t in client.get("/api/v1/tasks?view=summary").json()["tasks"]}
    assert hidden_rows[dependent["id"]]["waitingOnSummaries"] == []


def test_list_reuses_prerequisites_already_in_the_task_page(project_context, monkeypatch):
    app, client, project = project_context
    upstream = _task(client, project, "Design")
    dependent = _task(client, project, "Build")
    assert _set(client, dependent, [upstream["id"]]).status_code == 200
    store = app.state.task_store
    list_summaries = store.list_task_summaries
    extra_reads = []

    def record_lookup(**options):
        if options.get("task_ids"):
            extra_reads.append(options["task_ids"])
        return list_summaries(**options)

    monkeypatch.setattr(store, "list_task_summaries", record_lookup)
    path = "/api/v1/tasks?view=summary"
    full = {task["id"]: task for task in client.get(path).json()["tasks"]}
    expected = full[dependent["id"]]["waitingOnSummaries"]
    assert [summary["id"] for summary in expected] == [upstream["id"]]
    assert extra_reads == []

    [limited] = client.get(f"{path}&limit=1").json()["tasks"]
    assert limited["id"] == dependent["id"]
    assert limited["waitingOnSummaries"] == expected
    assert extra_reads == [[upstream["id"]]]


def test_task_record_view_omits_history_and_preserves_prerequisites(project_context, monkeypatch):
    app, client, project = project_context
    upstream = _task(client, project, "Design")
    dependent = _task(client, project, "Build")
    assert _set(client, dependent, [upstream["id"]]).status_code == 200
    store = app.state.task_store
    for index in range(20):
        store.update_task(dependent["id"], {"description": f"Revision {index}: " + "x" * 1000})

    path = f"/api/v1/tasks/{dependent['id']}"
    full = client.get(path)
    assert full.status_code == 200
    assert len(full.json()["events"]) > 20
    assert full.json()["waitingOn"] == [upstream["id"]]

    def reject_history_read(*_args):
        raise AssertionError("the record view should read the current snapshot")

    monkeypatch.setattr(store, "_events_for_task", reject_history_read)
    response = client.get(f"{path}?view=record")
    assert response.status_code == 200
    result = response.json()
    assert "events" not in result
    assert "activity" not in result
    assert result["eventCount"] == len(full.json()["events"])
    assert result["description"] == full.json()["description"]
    assert result["waitingOn"] == [upstream["id"]]
    assert len(response.content) < len(full.content) // 4
    assert TestClient(app).get(f"{path}?view=record").status_code == 401


def test_task_record_view_rebuilds_a_legacy_snapshot(project_context):
    app, client, project = project_context
    task = _task(client, project, "Before editing")
    store = app.state.task_store
    latest = store.update_task(task["id"], {"title": "Edited"})
    with store.engine.begin() as conn:
        conn.execute(update(store.tasks).where(store.tasks.c.id == task["id"]).values(snapshot={
            **{key: value for key, value in task.items() if key != "eventCount"},
        }))
    response = client.get(f"/api/v1/tasks/{task['id']}?view=record")
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Edited"
    assert body["eventCount"] == len(latest["events"])
    assert "events" not in body
