"""Routine rollups: a routine never runs itself, so its runs live in occurrences."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from fastapi.testclient import TestClient

from relay.app import create_app
from relay.persistence.events import relay_event
from relay.sessions.controller import SessionController

from automation_helpers import WEEKLY_TRIGGERS, fire_now

PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def _bootstrap(client: TestClient) -> None:
    assert client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token",
        "username": "admin",
        "password": "kestrel-vault-7719",
    }).status_code == 200
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200


def _admin_user_id(app: Any) -> str:
    # The bootstrapped admin's User row has a random id, not one derived
    # from its handle.
    return app.state.auth_store.resolve_user_id("admin")


def _create_agent(app: Any) -> dict[str, Any]:
    return app.state.agent_store.create_agent(
        _admin_user_id(app),
        {"displayName": "Routine Runner", "executorKind": "claude", "defaultRole": "implementer"},
    )


def _create_routine(client: TestClient, agent_id: str) -> dict[str, Any]:
    response = client.post("/api/v1/tasks", json={
        "title": "Weekly status deck",
        "assignedAgentId": agent_id,
        "isRoutine": True,
        "routineState": "active",
        "routineTriggers": WEEKLY_TRIGGERS,
    })
    assert response.status_code == 201, response.text
    return response.json()


def _promote(app: Any, routine_id: str) -> dict[str, Any]:
    occurrence = fire_now(app.state.task_store, routine_id, run_date="2026-06-25")
    assert occurrence is not None
    return occurrence


def _session_for(app: Any, task_id: str, workspace: str, agent_id: str) -> str:
    controller = SessionController(
        app.state.session_store,
        task_store=app.state.task_store,
        task_id=task_id,
        workspace_path=workspace,
        owner_user_id=_admin_user_id(app),
        owner_agent_id=agent_id,
    )
    return controller.create_session("Weekly status deck", ["human", "claude"])["id"]


def _workspace_artifact(workspace: str, name: str, *, artifact_id: str, created_at: str) -> dict[str, Any]:
    return {
        "id": artifact_id,
        "kind": "workspace_file",
        "title": name,
        "path": str(Path(workspace) / name),
        "createdAt": created_at,
        "bytes": 8,
        "contentType": PPTX_TYPE,
        "workspaceRelativePath": name,
    }


def test_routine_artifacts_roll_up_from_occurrences(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        occurrence = _promote(app, routine["id"])
        session_id = _session_for(app, occurrence["id"], ws, agent["id"])
        deck = _workspace_artifact(ws, "deck.pptx", artifact_id="30000000-0000-4000-8000-000000000001", created_at="2026-06-25T09:00:00.000Z")
        app.state.session_store.append_event(
            session_id, relay_event("artifact.created", session_id, {"artifact": deck})
        )

        response = client.get(f"/api/v1/tasks/{routine['id']}/artifacts")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["taskId"] == routine["id"]
        assert [item["id"] for item in body["artifacts"]] == [deck["id"]]
        # Attribution stays with the occurrence that actually produced the file.
        assert body["artifacts"][0]["taskId"] == occurrence["id"]
        assert body["artifacts"][0]["sessionId"] == session_id


def test_routine_files_exclude_thread_records_in_every_listing(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        occurrence = _promote(app, routine["id"])
        session_id = _session_for(app, occurrence["id"], ws, agent["id"])
        paths = [
            f"artifacts/{occurrence['id']}/daily-update.md",
            f"artifacts/{occurrence['id']}/HANDOFF.md",
            f".relay/threads/{routine['id']}/HANDOFF.md",
            f".relay/threads/{routine['id']}/HANDOFF.json",
            f".threads/{session_id}/HANDOFF.md",
            f"threads/{session_id}/HANDOFF.json",
        ]
        for index, path in enumerate(paths):
            artifact = _workspace_artifact(
                ws, path, artifact_id=f"30000000-0000-4000-8000-{index + 100:012d}",
                created_at="2026-06-25T09:00:00.000Z",
            )
            # The daemon uses the basename for the title, as in the screenshot.
            artifact["title"] = Path(path).name
            app.state.session_store.append_event(
                session_id, relay_event("artifact.created", session_id, {"artifact": artifact})
            )

        for task_id in (routine["id"], occurrence["id"]):
            for suffix in ("", "?versions=all"):
                response = client.get(f"/api/v1/tasks/{task_id}/artifacts{suffix}")
                assert response.status_code == 200, response.text
                assert {item["workspaceRelativePath"] for item in response.json()["artifacts"]} == set(paths[:2])

        runs = client.get(f"/api/v1/tasks/{routine['id']}/runs").json()["runs"]
        assert runs[0]["artifactCount"] == 2
        # Filtering the Files view must preserve the underlying continuity record.
        assert len(app.state.session_store.get_session(session_id)["artifacts"]) == len(paths)


def test_routine_artifacts_dedupe_regenerated_file_across_occurrences(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        first = _promote(app, routine["id"])
        first_session = _session_for(app, first["id"], ws, agent["id"])
        second = fire_now(app.state.task_store, routine["id"], run_date="2026-07-02")
        assert second is not None
        second_session = _session_for(app, second["id"], ws, agent["id"])

        stale = _workspace_artifact(ws, "deck.pptx", artifact_id="30000000-0000-4000-8000-000000000002", created_at="2026-06-25T09:00:00.000Z")
        fresh = _workspace_artifact(ws, "deck.pptx", artifact_id="30000000-0000-4000-8000-000000000003", created_at="2026-07-02T09:00:00.000Z")
        store = app.state.session_store
        store.append_event(first_session, relay_event("artifact.created", first_session, {"artifact": stale}))
        store.append_event(second_session, relay_event("artifact.created", second_session, {"artifact": fresh}))

        artifacts = client.get(f"/api/v1/tasks/{routine['id']}/artifacts").json()["artifacts"]
        assert [item["id"] for item in artifacts] == [fresh["id"]]
        assert artifacts[0]["taskId"] == second["id"]


def test_task_events_default_excludes_occurrence_events(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        occurrence = _promote(app, routine["id"])

        events = client.get(f"/api/v1/tasks/{routine['id']}/events").json()["events"]
        assert {event["taskId"] for event in events} == {routine["id"]}
        assert any(event["type"] == "task.occurrence_created" for event in events)
        assert all(event["taskId"] != occurrence["id"] for event in events)


def test_task_events_include_occurrences_merges_by_timestamp(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        occurrence = _promote(app, routine["id"])
        app.state.task_store.record_activity(occurrence["id"], "Run started")

        response = client.get(
            f"/api/v1/tasks/{routine['id']}/events", params={"include": "occurrences"}
        )
        assert response.status_code == 200, response.text
        events = response.json()["events"]
        assert {event["taskId"] for event in events} == {routine["id"], occurrence["id"]}
        timestamps = [event["timestamp"] for event in events]
        assert timestamps == sorted(timestamps)
        assert any(
            event["taskId"] == occurrence["id"] and event["type"] == "task.activity"
            for event in events
        )


def _runs(client: TestClient, task_id: str, **params: Any) -> list[dict[str, Any]]:
    response = client.get(f"/api/v1/tasks/{task_id}/runs", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["taskId"] == task_id
    return body["runs"]


def test_routine_runs_list_occurrences_newest_first(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        first = _promote(app, routine["id"])
        second = fire_now(app.state.task_store, routine["id"], run_date="2026-07-02")
        assert second is not None
        session_id = _session_for(app, second["id"], ws, agent["id"])
        deck = _workspace_artifact(ws, "deck.pptx", artifact_id="30000000-0000-4000-8000-000000000011", created_at="2026-07-02T09:00:00.000Z")
        app.state.session_store.append_event(
            session_id, relay_event("artifact.created", session_id, {"artifact": deck})
        )

        runs = _runs(client, routine["id"])
        # The ledger reads newest run first, dated by the day it was scheduled for.
        assert [run["taskId"] for run in runs] == [second["id"], first["id"]]
        assert [run["scheduledFor"] for run in runs] == ["2026-07-02", "2026-06-25"]
        assert runs[0]["sessionIds"] == [session_id]
        assert runs[0]["latestSessionId"] == session_id
        assert runs[0]["artifactCount"] == 1
        assert runs[1]["sessionIds"] == []
        assert runs[1]["latestSessionId"] is None
        assert runs[1]["artifactCount"] == 0


def test_routine_run_reports_timing_and_failure(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        occurrence = _promote(app, routine["id"])
        app.state.task_store.update_task(occurrence["id"], {"status": "running"})
        assert client.patch(f"/api/v1/tasks/{occurrence['id']}", json={"status": "blocked", "blockerReason": "Agent failed"}).status_code == 200

        run = _runs(client, routine["id"])[0]
        assert run["status"] == "blocked"
        assert run["startedAt"] is not None
        assert run["endedAt"] is not None
        assert run["endedAt"] >= run["startedAt"]


def test_routine_run_without_terminal_status_has_no_end(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        occurrence = _promote(app, routine["id"])
        app.state.task_store.update_task(occurrence["id"], {"status": "running"})

        run = _runs(client, routine["id"])[0]
        assert run["status"] == "running"
        assert run["startedAt"] is not None
        assert run["endedAt"] is None
        assert run["failureMessage"] is None


def test_runs_limit_caps_the_ledger(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        routine = _create_routine(client, agent["id"])
        _promote(app, routine["id"])
        second = fire_now(app.state.task_store, routine["id"], run_date="2026-07-02")
        assert second is not None

        runs = _runs(client, routine["id"], limit=1)
        assert [run["taskId"] for run in runs] == [second["id"]]


def test_plain_task_runs_is_its_own_single_row(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        agent = _create_agent(app)
        created = client.post("/api/v1/tasks", json={
            "title": "One-off audit",
        })
        assert created.status_code == 201, created.text
        task = created.json()
        session_id = _session_for(app, task["id"], ws, agent["id"])

        runs = _runs(client, task["id"])
        # A plain task never has occurrences, but it still had a run — the
        # ledger stays one component rather than two.
        assert len(runs) == 1
        assert runs[0]["taskId"] == task["id"]
        assert runs[0]["sessionIds"] == [session_id]
