from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from relay.app import create_app
from relay.core.ids import new_database_id, now_iso
from relay.services.event_notifier import (
    KeyedEventNotifier,
    database_notification_bridge,
)
from relay.sessions import SessionController


@pytest.fixture
def review_app(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    return create_app(tmp_path / "state")


@pytest.fixture
def review_client(review_app):
    client = TestClient(review_app)
    assert (
        client.post(
            "/api/v1/auth/bootstrap",
            json={
                "token": "admin_token",
                "username": "admin",
                "password": "kestrel-vault-7719",
            },
        ).status_code
        == 200
    )
    return client


def test_static_assets_reject_sibling_prefix_and_symlink_escape(
    review_app, monkeypatch, tmp_path
):
    dist = tmp_path / "out"
    dist.mkdir()
    sibling = tmp_path / "out-private"
    sibling.mkdir()
    (sibling / "secret.txt").write_text("private")
    (dist / "escape.txt").symlink_to(sibling / "secret.txt")
    (dist / "public.txt").write_text("public")
    monkeypatch.setenv("RELAY_WEB_UI_DIST_DIR", str(dist))
    client = TestClient(review_app)
    assert client.get("/public.txt").text == "public"
    for path in ("/%2e%2e%2fout-private/secret.txt", "/escape.txt"):
        assert client.get(path).status_code == 404


@pytest.mark.parametrize("content", [b"daemon snapshot", None])
def test_artifact_download_never_reads_backend_host(
    review_app, review_client, tmp_path, content
):
    workspace = tmp_path / "remote-workspace"
    workspace.mkdir()
    host_file = workspace / "report.txt"
    host_file.write_bytes(b"backend host private data")
    session = SessionController(
        review_app.state.session_store,
        workspace_path=str(workspace),
        owner_employee_id="admin",
    ).create_session("Remote report")
    artifact = {
        "id": new_database_id(),
        "kind": "workspace_file",
        "title": "report.txt",
        "path": str(host_file),
        "workspaceRelativePath": "report.txt",
        "createdAt": now_iso(),
        "contentType": "text/plain",
        "bytes": 15,
    }
    review_app.state.session_store.index_workspace_artifact(
        session["id"], artifact, content
    )
    response = review_client.get(
        f"/api/v1/threads/{session['id']}/artifacts/{artifact['id']}"
    )
    assert response.status_code == (200 if content is not None else 404)
    if content is not None:
        assert response.content == content


@pytest.mark.parametrize("content_type", ["text/html", "image/svg+xml"])
def test_artifact_snapshots_download_with_restricted_csp(
    review_app, review_client, content_type
):
    session = SessionController(
        review_app.state.session_store, owner_employee_id="admin"
    ).create_session("Download")
    artifact = {
        "id": new_database_id(),
        "kind": "workspace_file",
        "title": 'report "你好".html',
        "path": "/remote/report.html",
        "workspaceRelativePath": "report.html",
        "createdAt": now_iso(),
        "contentType": content_type,
        "bytes": 25,
    }
    content = b"<script>alert(1)</script>"
    review_app.state.session_store.index_workspace_artifact(
        session["id"], artifact, content
    )
    response = review_client.get(
        f"/api/v1/threads/{session['id']}/artifacts/{artifact['id']}"
    )
    assert response.content == content
    assert response.headers["content-disposition"].startswith("attachment;")
    assert "sandbox" in response.headers["content-security-policy"]
    assert "default-src 'none'" in response.headers["content-security-policy"]


def test_sandbox_provision_checks_existing_owner(review_app, review_client):
    for employee in ("alice", "bob"):
        assert (
            review_client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": employee,
                    "username": employee,
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
    node = review_app.state.registry.register(
        {
            "sandboxId": "review-alice",
            "employeeId": "alice",
            "token": "node_token",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "status": "ready",
        }
    )
    assert (
        review_client.post(
            "/api/v1/auth/login", json={"username": "bob", "password": "userpass"}
        ).status_code
        == 200
    )
    response = review_client.post(
        "/api/v1/sandboxes", json={"employeeId": "bob", "sandboxId": node["id"]}
    )
    assert response.status_code == 403
    assert review_app.state.registry.get(node["id"])["employeeId"] == "alice"
    assert (
        review_client.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
        ).status_code
        == 200
    )
    assert (
        review_client.post(
            "/api/v1/sandboxes", json={"employeeId": "alice", "sandboxId": node["id"]}
        ).status_code
        == 201
    )


def test_notification_bridge_preserves_password():
    engine = create_engine(
        "postgresql+psycopg://review:dummy%40password@localhost/review"
    )
    try:
        bridge = database_notification_bridge(
            SimpleNamespace(engine=engine), KeyedEventNotifier()
        )
        assert bridge is not None
        assert make_url(bridge.database_url).password == "dummy@password"
    finally:
        engine.dispose()


def test_legacy_daemon_completion_does_not_collect_backend_files(review_app, tmp_path):
    workspace = tmp_path / "host-files"
    workspace.mkdir()
    (workspace / "private.pdf").write_bytes(b"backend secret")
    session = SessionController(
        review_app.state.session_store,
        workspace_path=str(workspace),
        owner_employee_id="admin",
    ).create_session("Legacy daemon")
    review_app.state.registry._record_generated_workspace_artifacts(
        {"workspacePath": str(workspace)},
        {"sessionId": session["id"]},
        {"runId": new_database_id()},
        None,
    )
    assert review_app.state.session_store.get_session(session["id"])["artifacts"] == []


@pytest.mark.parametrize(
    "action,session_status,task_status",
    [
        ("mark_done", "completed", "done"),
        ("cancel", "cancelled", "blocked"),
        ("cancellations", "cancelled", "blocked"),
    ],
)
def test_terminal_thread_actions_update_linked_task(
    review_app, review_client, action, session_status, task_status
):
    task = review_client.post(
        "/api/v1/tasks", json={"title": "Linked task", "createSession": True}
    ).json()
    session_id = task["linkedSessionIds"][0]
    review_app.state.task_store.update_task(task["id"], {"status": "waiting_for_human"})
    endpoint = "cancellations" if action == "cancellations" else "decisions"
    response = review_client.post(
        f"/api/v1/threads/{session_id}/{endpoint}", json={"kind": action}
    )
    assert response.status_code in (200, 202)
    assert response.json()["status"] == session_status
    assert review_app.state.task_store.get_task(task["id"])["status"] == task_status


def test_terminal_thread_action_rolls_back_on_task_write_failure(
    review_app, review_client, monkeypatch
):
    task = review_client.post(
        "/api/v1/tasks", json={"title": "Atomic completion", "createSession": True}
    ).json()
    session_id = task["linkedSessionIds"][0]
    session_before = review_app.state.session_store.get_session(session_id)
    task_before = review_app.state.task_store.get_task(task["id"])

    def fail(*args, **kwargs):
        raise RuntimeError("injected task write failure")

    monkeypatch.setattr(review_app.state.task_store, "record_activity", fail)
    with pytest.raises(RuntimeError, match="injected task write failure"):
        review_client.post(
            f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
        )
    assert review_app.state.session_store.get_session(session_id) == session_before
    assert review_app.state.task_store.get_task(task["id"]) == task_before


def test_terminal_occurrence_keeps_routine_schedule_and_deleted_history(
    review_app, review_client
):
    store = review_app.state.task_store
    task = review_client.post(
        "/api/v1/tasks", json={"title": "Occurrence", "createSession": True}
    ).json()
    session_id = task["linkedSessionIds"][0]
    routine = store.create_task(
        {"title": "Schedule", "isRoutine": True, "ownerEmployeeId": "admin"}
    )
    deleted = store.create_task(
        {"title": "Deleted history", "ownerEmployeeId": "admin"}
    )
    for linked in (routine, deleted):
        store.link_session(linked["id"], session_id)
    store.delete_task(deleted["id"])
    routine_before = store.get_task(routine["id"])
    deleted_before = store.get_task(deleted["id"])
    response = review_client.post(
        f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
    )
    assert response.status_code == 200
    assert store.get_task(task["id"])["status"] == "done"
    assert store.get_task(routine["id"]) == routine_before
    assert store.get_task(deleted["id"]) == deleted_before
