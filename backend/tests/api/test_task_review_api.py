"""Authorized review reads and acceptance of the exact displayed revision."""

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.persistence.events import relay_event


@pytest.fixture
def review_app(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    assert client.post("/api/v1/auth/bootstrap", json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"}).status_code == 200
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200
    owner = app.state.auth_store.resolve_user_id("admin")
    task = app.state.task_store.create_task({"title": "Fix export", "ownerUserId": owner, "status": "review"})
    thread = app.state.session_store.create_session({"workspacePath": "/workspace", "taskGoal": "Fix export", "participants": ["human"], "ownerUserId": owner})
    app.state.task_store.link_session(task["id"], thread["id"])
    return app, client, task["id"], thread["id"]


def test_review_requires_authentication(review_app):
    app, _, task_id, _ = review_app
    assert TestClient(app).get(f"/api/v1/tasks/{task_id}/review").status_code == 401


def test_current_review_can_be_accepted(review_app):
    app, client, task_id, _ = review_app
    response = client.get(f"/api/v1/tasks/{task_id}/review")
    assert response.status_code == 200, response.text
    review = response.json()
    assert review["taskId"] == task_id
    assert review["canAccept"] is True
    response = client.patch(f"/api/v1/tasks/{task_id}", json={"status": "done", "reviewRevision": review["revision"]})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "done"
    assert any(event.get("reviewRevision") == review["revision"] for event in app.state.task_store.get_task(task_id)["events"])
    repeated = client.patch(f"/api/v1/tasks/{task_id}", json={"status": "done", "reviewRevision": review["revision"]})
    assert repeated.status_code == 409


@pytest.mark.parametrize("change", ["requirements", "artifact", "round"])
def test_superseded_review_is_refused(review_app, change):
    app, client, task_id, thread_id = review_app
    review = client.get(f"/api/v1/tasks/{task_id}/review").json()
    if change == "requirements":
        app.state.task_store.update_task(task_id, {"description": "Changed requirement"})
    elif change == "artifact":
        app.state.session_store.append_event(thread_id, relay_event("artifact.created", thread_id, {"artifact": {
            "id": "30000000-0000-4000-8000-000000000001", "kind": "workspace_file", "title": "new.csv", "path": "/workspace/new.csv", "createdAt": "2026-11-02T00:00:00Z"}}))
    else:
        app.state.session_store.append_event(thread_id, relay_event("collaboration.round.started", thread_id, {"manifest": {
            "roundId": "new-round", "workScope": {"kind": "task", "taskId": task_id}, "assignments": []}}))
    response = client.patch(f"/api/v1/tasks/{task_id}", json={"status": "done", "reviewRevision": review.get("revision", "missing")})
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "task_review_changed"
    assert app.state.task_store.get_task(task_id)["status"] == "review"


def test_invalid_review_revision_is_not_silently_ignored(review_app):
    _, client, task_id, _ = review_app
    response = client.patch(f"/api/v1/tasks/{task_id}", json={"status": "done", "reviewRevision": 42})
    assert response.status_code == 400, response.text


def test_another_user_cannot_read_or_accept_the_review(review_app):
    app, _, task_id, _ = review_app
    app.state.auth_store.create_account("other", "kestrel-vault-7719")
    other = TestClient(app)
    assert other.post("/api/v1/auth/login", json={"username": "other", "password": "kestrel-vault-7719"}).status_code == 200
    assert other.get(f"/api/v1/tasks/{task_id}/review").status_code == 403
    assert other.patch(f"/api/v1/tasks/{task_id}", json={"status": "done", "reviewRevision": "a" * 64}).status_code == 403


def test_deleted_thread_is_not_replaced_with_an_older_review(review_app):
    app, client, task_id, thread_id = review_app
    app.state.session_store.delete_session(thread_id)
    review = client.get(f"/api/v1/tasks/{task_id}/review").json()
    assert review["sessionId"] is None
    assert "thread" in review["missing"]


def test_review_cannot_hide_requirement_edits_in_an_acceptance(review_app):
    _, client, task_id, _ = review_app
    review = client.get(f"/api/v1/tasks/{task_id}/review").json()
    response = client.patch(f"/api/v1/tasks/{task_id}", json={"status": "done", "reviewRevision": review["revision"], "description": "Different outcome"})
    assert response.status_code == 400


def test_review_attributes_recorded_reports_to_the_logical_agent(review_app):
    app, client, task_id, thread_id = review_app
    owner = app.state.auth_store.resolve_user_id("admin")
    agent = app.state.agent_store.create_agent(owner, {"displayName": "James", "executorKind": "codex", "defaultRole": "implementer"})
    run_id = "30000000-0000-4000-8000-000000000002"
    store = app.state.session_store
    store.append_event(thread_id, relay_event("collaboration.round.started", thread_id, {"manifest": {
        "roundId": "delivery-round", "workScope": {"kind": "task", "taskId": task_id},
        "assignments": [{"assignmentId": "build", "agentId": agent["id"]}]}}))
    store.append_event(thread_id, relay_event("agent.started", thread_id, {
        "runId": run_id, "agent": "codex", "logicalAgentId": agent["id"], "assignmentId": "build"}))
    store.append_event(thread_id, relay_event("agent.completed", thread_id, {
        "runId": run_id, "agent": "codex", "status": "completed", "exitCode": 0,
        "workResult": {"status": "done", "note": "Fixed export", "evidence": ["CSV checked"], "findings": []}}))
    review = client.get(f"/api/v1/tasks/{task_id}/review").json()
    assert review["roundId"] == "delivery-round"
    assert review["reports"][0]["agentName"] == "James"
    assert review["reports"][0]["evidence"] == ["CSV checked"]
    assert review["verification"] == "not_recorded"


@pytest.mark.parametrize("saved", [False, True])
def test_review_output_link_never_falls_back_to_live_workspace(review_app, monkeypatch, saved):
    app, client, _, thread_id = review_app
    artifact_id = "30000000-0000-4000-8000-000000000001"
    artifact = {
        "id": artifact_id, "kind": "workspace_file", "title": "export.csv", "path": "/workspace/export.csv",
        "workspaceRelativePath": "export.csv", "createdAt": "2026-11-02T00:00:00Z"}
    app.state.session_store.index_workspace_artifact(thread_id, artifact, b"recorded version" if saved else None)
    async def unexpected_live_read(*args):
        pytest.fail("A recorded review must never read the live workspace")
    monkeypatch.setattr("relay.api.threads.artifacts._live_artifact_content", unexpected_live_read)
    response = client.get(f"/api/v1/threads/{thread_id}/artifacts/{artifact_id}?snapshot=1")
    assert response.status_code == (200 if saved else 404), response.text
    if saved:
        assert response.content == b"recorded version"
    else:
        assert response.json()["detail"] == "artifact_snapshot_unavailable"
