from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from fastapi.testclient import TestClient

from relay.app import create_app
from relay.persistence.stores import relay_event
from relay.sessions import SessionController


def _bootstrap(client: TestClient) -> None:
    assert client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token",
        "username": "admin",
        "password": "kestrel-vault-7719",
    }).status_code == 200
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200


def _create_task_with_session(client: TestClient, workspace_path: str, *, title: str = "Ship the quarterly deck") -> dict[str, Any]:
    response = client.post("/api/v1/tasks", json={
        "title": title,
        "createSession": True,
        "workspacePath": workspace_path,
    })
    assert response.status_code == 201, response.text
    return response.json()


def _workspace_artifact(workspace: str, name: str, *, artifact_id: str, created_at: str, content_type: str) -> dict[str, Any]:
    path = Path(workspace) / name
    return {
        "id": artifact_id,
        "kind": "workspace_file",
        "title": name,
        "path": str(path),
        "createdAt": created_at,
        "bytes": 8,
        "contentType": content_type,
        "workspaceRelativePath": name,
    }


PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def test_task_artifacts_lists_generated_files_from_linked_sessions(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, ws)
        session_id = task["linkedSessionIds"][0]

        deck = _workspace_artifact(ws, "deck.pptx", artifact_id="20000000-0000-4000-8000-000000000001", created_at="2026-06-30T00:00:00.000Z", content_type=PPTX_TYPE)
        doc = _workspace_artifact(ws, "notes.docx", artifact_id="20000000-0000-4000-8000-000000000002", created_at="2026-07-01T00:00:00.000Z", content_type=DOCX_TYPE)
        store = app.state.session_store
        store.append_event(session_id, relay_event("artifact.created", session_id, {"artifact": deck}))
        store.append_event(session_id, relay_event("artifact.created", session_id, {"artifact": doc}))

        response = client.get(f"/api/v1/tasks/{task['id']}/artifacts")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["taskId"] == task["id"]
        assert [item["id"] for item in body["artifacts"]] == ["20000000-0000-4000-8000-000000000002", "20000000-0000-4000-8000-000000000001"]
        item = body["artifacts"][1]
        assert item["sessionId"] == session_id
        assert item["taskId"] == task["id"]
        assert item["contentType"] == PPTX_TYPE
        assert item["workspacePath"] == ws


def test_task_artifacts_dedupes_regenerated_file_across_sessions(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, ws)
        first_session = task["linkedSessionIds"][0]
        agent = app.state.agent_store.create_agent(
            "admin", {"displayName": "Artifact Reviewer", "executorKind": "claude", "defaultRole": "implementer"}
        )

        # A second linked thread regenerates deck.pptx in a new session.
        controller = SessionController(
            app.state.session_store,
            task_store=app.state.task_store,
            task_id=task["id"],
            workspace_path=ws,
            owner_employee_id="admin",
            owner_agent_id=agent["id"],
        )
        second_session = controller.create_session(task["title"], ["human", "claude"])[
            "id"
        ]

        stale = _workspace_artifact(ws, "deck.pptx", artifact_id="20000000-0000-4000-8000-000000000003", created_at="2026-06-29T00:00:00.000Z", content_type=PPTX_TYPE)
        fresh = _workspace_artifact(ws, "deck.pptx", artifact_id="20000000-0000-4000-8000-000000000004", created_at="2026-07-02T00:00:00.000Z", content_type=PPTX_TYPE)
        store = app.state.session_store
        store.append_event(first_session, relay_event("artifact.created", first_session, {"artifact": stale}))
        store.append_event(second_session, relay_event("artifact.created", second_session, {"artifact": fresh}))

        response = client.get(f"/api/v1/tasks/{task['id']}/artifacts")
        assert response.status_code == 200, response.text
        artifacts = response.json()["artifacts"]
        assert len(artifacts) == 1
        assert artifacts[0]["id"] == "20000000-0000-4000-8000-000000000004"
        assert artifacts[0]["sessionId"] == second_session

        history = client.get(f"/api/v1/tasks/{task['id']}/artifacts?versions=all")
        assert history.status_code == 200
        assert [item["id"] for item in history.json()["artifacts"]] == [fresh["id"], stale["id"]]


def test_task_artifacts_ignores_non_workspace_artifacts(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, ws)
        session_id = task["linkedSessionIds"][0]
        log = {
            "id": "20000000-0000-4000-8000-000000000005",
            "kind": "agent_output",
            "title": "claude output",
            "path": str(Path(ws) / "output.txt"),
            "createdAt": "2026-06-30T00:00:00.000Z",
        }
        app.state.session_store.append_event(session_id, relay_event("artifact.created", session_id, {"artifact": log}))

        response = client.get(f"/api/v1/tasks/{task['id']}/artifacts")
        assert response.status_code == 200, response.text
        assert response.json()["artifacts"] == []


def test_task_artifacts_empty_for_task_without_sessions(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        response = client.post("/api/v1/tasks", json={"title": "No sessions yet"})
        assert response.status_code == 201, response.text
        task_id = response.json()["id"]

        listing = client.get(f"/api/v1/tasks/{task_id}/artifacts")
        assert listing.status_code == 200, listing.text
        assert listing.json() == {"taskId": task_id, "artifacts": []}


def test_task_artifacts_unknown_task_is_404(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        assert (
            client.get(
                "/api/v1/tasks/11111111-1111-4111-8111-111111111111/artifacts"
            ).status_code
            == 404
        )


def test_task_artifacts_denied_for_other_employee(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, ws)

        assert client.post("/api/v1/admin/users", json={
            "username": "worker",
            "password": "kestrel-vault-7719",
            "employeeId": "emp_worker",
        }).status_code == 201
        worker = TestClient(app)
        assert worker.post("/api/v1/auth/login", json={"username": "worker", "password": "kestrel-vault-7719"}).status_code == 200

        response = worker.get(f"/api/v1/tasks/{task['id']}/artifacts")
        assert response.status_code == 403


def test_historical_artifact_download_prefers_retained_content_over_live_file(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, ws)
        session_id = task["linkedSessionIds"][0]
        artifact = _workspace_artifact(ws, "report.pdf", artifact_id="20000000-0000-4000-8000-000000000099",
                                      created_at="2026-07-01T00:00:00.000Z", content_type="application/pdf")
        Path(artifact["path"]).write_bytes(b"later project edits")
        app.state.session_store.index_workspace_artifact(session_id, artifact, b"original task output")
        response = client.get(f"/api/v1/threads/{session_id}/artifacts/{artifact['id']}")
        assert response.status_code == 200
        assert response.content == b"original task output"
