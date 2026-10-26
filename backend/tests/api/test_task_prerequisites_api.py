"""Task prerequisites over HTTP, and the dispatch queue that honours them."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
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
