from __future__ import annotations

from tempfile import TemporaryDirectory

from fastapi import HTTPException
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.persistence.stores import relay_event
from relay.services.produced_files import (
    file_currency,
    listing_directories,
    live_status,
)

from .test_task_artifacts import (
    _bootstrap,
    _create_task_with_session,
    _workspace_artifact,
)


def test_currency_compares_the_record_against_the_live_entry() -> None:
    artifact = {
        "workspaceRelativePath": "report.md",
        "bytes": 8,
        "createdAt": "2026-07-01T00:00:00.000Z",
    }
    listings = {
        "": {
            "report.md": {
                "bytes": 8,
                "updatedAt": "2026-07-01T00:00:00.000Z",
            }
        }
    }
    assert file_currency(artifact, listings) == "current"

    listings[""]["report.md"]["bytes"] = 99
    assert file_currency(artifact, listings) == "changed-since"

    listings[""]["report.md"] = {
        "bytes": 8,
        "updatedAt": "2026-07-09T00:00:00.000Z",
    }
    assert file_currency(artifact, listings) == "changed-since"
    assert file_currency(artifact, {"": {}}) == "deleted"
    assert file_currency(artifact, {}) == "unknown"


def test_live_status_normalises_daemon_reasons_into_client_vocabulary() -> None:
    assert live_status(HTTPException(409, {"reason": "workspace-not-created"})) == (
        "not-created"
    )
    assert live_status(HTTPException(503, {"reason": "computer-offline"})) == (
        "offline"
    )
    assert live_status(HTTPException(503, {"reason": "workspace-unsupported"})) == (
        "unsupported"
    )
    assert live_status(HTTPException(403, "nope")) == "denied"
    assert live_status(HTTPException(502, "something else")) == "unavailable"


def test_listing_directories_covers_root_and_caps_the_rest() -> None:
    artifacts = [{"workspaceRelativePath": f"pkg{i}/mod.py"} for i in range(12)]

    directories = listing_directories(artifacts, root="", limit=8)

    assert directories[0] == ""
    assert len(directories) == 8
    assert len(set(directories)) == 8


def test_task_files_returns_produced_records_when_computer_is_down(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as workspace:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, workspace)
        session_id = task["linkedSessionIds"][0]
        report = _workspace_artifact(
            workspace,
            "report.md",
            artifact_id="20000000-0000-4000-8000-000000000001",
            created_at="2026-07-01T00:00:00.000Z",
            content_type="text/markdown",
        )
        app.state.session_store.append_event(
            session_id,
            relay_event("artifact.created", session_id, {"artifact": report}),
        )

        response = client.get(f"/api/v1/tasks/{task['id']}/files")

        assert response.status_code == 200, response.text
        body = response.json()
        assert [item["title"] for item in body["produced"]] == ["report.md"]
        assert body["produced"][0]["currency"] == "unknown"
        assert body["live"]["status"] != "ok"
        assert body["live"]["entries"] == []


def test_task_files_reports_snapshot_reason_on_live_only_row(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as workspace:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, workspace)
        session_id = task["linkedSessionIds"][0]
        source = {
            **_workspace_artifact(
                workspace,
                "main.py",
                artifact_id="20000000-0000-4000-8000-000000000002",
                created_at="2026-07-02T00:00:00.000Z",
                content_type="text/x-python",
            ),
            "workspaceRelativePath": "src/main.py",
            "snapshotSkipped": "not-snapshotable-type",
        }
        app.state.session_store.append_event(
            session_id,
            relay_event("artifact.created", session_id, {"artifact": source}),
        )

        response = client.get(f"/api/v1/tasks/{task['id']}/files")

        assert response.status_code == 200, response.text
        assert response.json()["produced"][0]["snapshotSkipped"] == (
            "not-snapshotable-type"
        )
