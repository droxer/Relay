from __future__ import annotations

from dataclasses import replace

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from issue_projects import routine_run_with_session

from app_state_helpers import replace_app_context
from relay.app import create_app
from relay.core.ids import new_database_id, now_iso
from relay.services.event_notifier import (
    KeyedEventNotifier,
    database_notification_bridge,
)
from relay.sessions.controller import SessionController
from user_ids import user_id


def _admin_id(app) -> str:
    # The bootstrapped admin's User row has a random id, not one derived
    # from its handle.
    return app.state.auth_store.resolve_user_id("admin")


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
    # The web UI directory is read once at startup (core/settings.py).
    replace_app_context(review_app, settings=replace(review_app.state.settings, web_ui_dist_dir=dist))
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
        owner_user_id="admin",
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
        review_app.state.session_store, owner_user_id="admin"
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
    for user in ("alice", "bob"):
        assert (
            review_client.post(
                "/api/v1/admin/users",
                json={
                    "userId": user,
                    "username": user,
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
    node = review_app.state.registry.register(
        {
            "sandboxId": "review-alice",
            "userId": user_id("alice"),
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
        "/api/v1/sandboxes", json={"userId": user_id("bob"), "sandboxId": node["id"]}
    )
    assert response.status_code == 403
    assert review_app.state.registry.get(node["id"])["userId"] == user_id("alice")
    assert (
        review_client.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
        ).status_code
        == 200
    )
    assert (
        review_client.post(
            "/api/v1/sandboxes", json={"userId": user_id("alice"), "sandboxId": node["id"]}
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
        owner_user_id="admin",
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
        ("mark_done", "completed", "waiting_for_human"),
        ("cancel", "cancelled", "waiting_for_human"),
        ("cancellations", "cancelled", "waiting_for_human"),
    ],
)
def test_terminal_thread_actions_leave_linked_task_unchanged(
    review_app, review_client, action, session_status, task_status
):
    task = routine_run_with_session(review_app, "Linked task")
    session_id = task["linkedSessionIds"][0]
    review_app.state.task_store.update_task(task["id"], {"status": "waiting_for_human"})
    endpoint = "cancellations" if action == "cancellations" else "decisions"
    response = review_client.post(
        f"/api/v1/threads/{session_id}/{endpoint}", json={"kind": action}
    )
    assert response.status_code in (200, 202)
    assert response.json()["status"] == session_status
    assert review_app.state.task_store.get_task(task["id"])["status"] == task_status


def test_terminal_thread_action_does_not_write_linked_tasks(
    review_app, review_client, monkeypatch
):
    task = routine_run_with_session(review_app, "Atomic completion")
    session_id = task["linkedSessionIds"][0]
    task_before = review_app.state.task_store.get_task(task["id"])

    def fail(*args, **kwargs):
        raise RuntimeError("injected task write failure")

    monkeypatch.setattr(review_app.state.task_store, "record_activity", fail)
    response = review_client.post(
        f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert review_app.state.task_store.get_task(task["id"]) == task_before


def test_terminal_occurrence_keeps_routine_schedule_and_deleted_history(
    review_app, review_client
):
    store = review_app.state.task_store
    task = routine_run_with_session(review_app, "Occurrence")
    session_id = task["linkedSessionIds"][0]
    routine = store.create_task(
        {"title": "Schedule", "isRoutine": True, "ownerUserId": "admin"}
    )
    deleted = store.create_task(
        {"title": "Deleted history", "ownerUserId": "admin"}
    )
    for linked in (routine, deleted):
        store.link_session(linked["id"], session_id)
    store.delete_task(deleted["id"])
    routine_before = store.get_task(routine["id"])
    deleted_before = store.get_task(deleted["id"])
    task_before = store.get_task(task["id"])
    response = review_client.post(
        f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
    )
    assert response.status_code == 200
    assert store.get_task(task["id"]) == task_before
    assert store.get_task(routine["id"]) == routine_before
    assert store.get_task(deleted["id"]) == deleted_before


def _undelivered_task_round(app, title: str) -> tuple[dict, dict]:
    """A task round its thread admitted that no daemon has received yet."""
    app.state.registry.register({
        "sandboxId": "node_admin", "userId": "admin", "workspaceId": "machine-admin",
        "token": "node_token", "workspacePath": "/workspace/admin",
        "protocolVersion": 1, "supportedAgents": ["codex"],
        "capabilities": ["thread-workspaces"], "status": "ready",
    })
    task = app.state.task_store.create_task({
        "title": title, "ownerUserId": "admin", "acceptancePolicy": "automatic",
        "assignedAgent": "codex", "assignedAgentId": "agt_codex", "status": "assigned",
    })
    session = SessionController(
        app.state.session_store, workspace_path="/workspace/admin",
        owner_user_id="admin",
    ).create_session(title, ["human"])
    request = app.state.registry.daemon_store.create_run_request({
        "nodeId": "node_admin", "sessionId": session["id"], "taskId": task["id"],
        "taskGoal": title, "assignments": [{"executorKind": "codex", "mode": "action"}],
        "state": {"_relay_task_source_revision": 0, "_relay_task_source_status": "assigned"},
        "status": "prepared",
    })
    app.state.registry.ensure_task_execution_claim(request)
    return app.state.task_store.get_task(task["id"]), session


@pytest.mark.parametrize(
    "endpoint,body,session_status,task_status",
    [
        ("cancellations", {}, "cancelled", "blocked"),
        ("decisions", {"kind": "cancel"}, "cancelled", "blocked"),
        ("decisions", {"kind": "mark_done"}, "completed", "done"),
    ],
)
def test_stopping_an_undelivered_task_round_settles_its_task(
    review_app, review_client, endpoint, body, session_status, task_status
):
    task, session = _undelivered_task_round(review_app, "Queued work")

    response = review_client.post(f"/api/v1/threads/{session['id']}/{endpoint}", json=body)

    assert response.status_code in (200, 202)
    assert response.json()["status"] == session_status
    store = review_app.state.task_store
    assert store.get_task(task["id"])["status"] == task_status
    # The scheduler must not start the work the person just stopped.
    assert task["id"] not in [item["id"] for item in store.list_dispatchable_tasks()]


@pytest.mark.parametrize(
    "kind,session_status,task_status",
    [("cancel", "cancelled", "blocked"), ("mark_done", "completed", "done")],
)
def test_thread_decision_on_awaiting_task_round_speaks_for_its_task(
    review_app, review_client, kind, session_status, task_status
):
    """A thread parked on its human belongs to the task its active round scopes."""
    app = review_app
    task = app.state.task_store.create_task({
        "title": "Asked a question", "ownerUserId": "admin",
        "acceptancePolicy": "automatic",
    })
    controller = SessionController(
        app.state.session_store, task_store=app.state.task_store, task_id=task["id"],
        workspace_path="/workspace", owner_user_id="admin",
    )
    session = controller.create_session("Asked a question", ["human"])
    controller.record_collaboration_round_started(session["id"], {
        "roundId": "round_1", "workScope": {"kind": "task", "taskId": task["id"]},
    })
    controller.complete_session(
        session["id"], "The round reported it is blocked. Which branch?",
        task_status="waiting_for_human", work_outcome="blocked",
    )
    assert app.state.task_store.get_task(task["id"])["status"] == "waiting_for_human"

    response = review_client.post(
        f"/api/v1/threads/{session['id']}/decisions", json={"kind": kind}
    )

    assert response.status_code == 200
    assert response.json()["status"] == session_status
    assert app.state.task_store.get_task(task["id"])["status"] == task_status


@pytest.mark.parametrize("kind", ["rerun", "handoff"])
def test_dispatching_decisions_are_refused_without_a_dispatch(review_client, review_app, kind):
    session = SessionController(
        review_app.state.session_store, workspace_path="/workspace",
        owner_user_id="admin",
    ).create_session("Finished", ["human"])
    SessionController(review_app.state.session_store).complete_session(session["id"], "Done.")

    response = review_client.post(
        f"/api/v1/threads/{session['id']}/decisions",
        json={"kind": kind, "targetAgent": "codex"},
    )

    assert response.status_code == 400
    assert review_app.state.session_store.get_session(session["id"])["status"] == "completed"


@pytest.mark.parametrize("kind", ["cancel", "mark_done"])
def test_old_round_cannot_settle_newer_task_execution(review_app, review_client, kind):
    from relay.persistence.store_common import relay_task_event

    app = review_app
    task = app.state.task_store.create_task({"title": "Shared task", "ownerUserId": "admin"})
    task = app.state.task_store.append_event(task["id"], relay_task_event(
        "task.execution.claimed", task["id"], {"requestId": "old_request", "expectedRevision": 0},
    ))
    controller = SessionController(app.state.session_store, task_store=app.state.task_store,
                                   task_id=task["id"], task_execution_owner=task["executionOwner"],
                                   owner_user_id="admin")
    session = controller.create_session("Old thread")
    controller.record_collaboration_round_started(session["id"], {
        "roundId": "old_round", "workScope": {"kind": "task", "taskId": task["id"]},
    })
    controller.complete_session(session["id"], "Question?", task_status="waiting_for_human", work_outcome="blocked")
    app.state.task_store.append_event(task["id"], relay_task_event(
        "task.execution.claimed", task["id"], {"requestId": "new_request", "expectedRevision": 1},
    ))
    app.state.task_store.append_event(task["id"], relay_task_event("task.status", task["id"], {"status": "running"}))
    before = app.state.task_store.get_task(task["id"])
    response = review_client.post(f"/api/v1/threads/{session['id']}/decisions", json={"kind": kind})
    assert response.status_code == 200
    assert app.state.task_store.get_task(task["id"]) == before


def _blocked_task_thread(app, *, policy: str = "automatic"):
    """A task round that stopped to ask, parked on its thread's human."""
    task = app.state.task_store.create_task({
        "title": "Asked a question", "ownerUserId": "admin",
        "acceptancePolicy": policy,
    })
    controller = SessionController(
        app.state.session_store, task_store=app.state.task_store, task_id=task["id"],
        workspace_path="/workspace", owner_user_id="admin",
    )
    session = controller.create_session("Asked a question", ["human"])
    controller.record_collaboration_round_started(session["id"], {
        "roundId": "round_1", "workScope": {"kind": "task", "taskId": task["id"]},
    })
    return task, session, controller


def test_thread_decisions_record_who_decided(review_app, review_client):
    _task, session, controller = _blocked_task_thread(review_app)
    controller.complete_session(
        session["id"], "The round reported it is blocked. Which branch?",
        task_status="waiting_for_human", work_outcome="blocked",
        input_request={"inputQuestion": "Which branch?"},
    )

    response = review_client.post(
        f"/api/v1/threads/{session['id']}/decisions", json={"kind": "reject"}
    )

    assert response.status_code == 200
    [decision] = response.json()["decisions"]
    assert decision["kind"] == "reject"
    assert decision["actorUserId"] == _admin_id(review_app)


def test_cancel_decision_records_who_cancelled(review_app, review_client):
    session = SessionController(
        review_app.state.session_store, workspace_path="/workspace",
        owner_user_id=_admin_id(review_app),
    ).create_session("Long job", ["human"])

    response = review_client.post(
        f"/api/v1/threads/{session['id']}/decisions", json={"kind": "cancel"}
    )

    assert response.status_code == 200
    assert response.json()["decisions"][-1]["actorUserId"] == _admin_id(review_app)


def test_reject_keeps_the_question_the_thread_waits_on(review_app, review_client):
    task, session, controller = _blocked_task_thread(review_app)
    request = {"inputQuestion": "Which branch?", "inputOptions": ["main", "dev"]}
    controller.complete_session(
        session["id"], "The round reported it is blocked. Which branch?",
        task_status="waiting_for_human", work_outcome="blocked", input_request=request,
    )

    response = review_client.post(
        f"/api/v1/threads/{session['id']}/decisions", json={"kind": "reject"}
    )

    assert response.status_code == 200
    rejected = response.json()
    assert rejected["status"] == "waiting_for_human"
    assert rejected["inputQuestion"] == "Which branch?"
    assert rejected["inputOptions"] == ["main", "dev"]
    waiting = review_app.state.task_store.get_task(task["id"])
    assert waiting["status"] == "waiting_for_human"
    assert waiting["waitingSessionId"] == session["id"]


def test_reject_is_refused_while_the_thread_runs(review_app, review_client):
    session = SessionController(
        review_app.state.session_store, workspace_path="/workspace",
        owner_user_id="admin",
    ).create_session("Still running", ["human"])
    SessionController(review_app.state.session_store).continue_session(session["id"])
    review_app.state.session_store.append_event(session["id"], {
        "type": "session.status", "sessionId": session["id"], "id": "evt_run",
        "timestamp": now_iso(), "status": "running", "phase": "running",
    })

    response = review_client.post(
        f"/api/v1/threads/{session['id']}/decisions", json={"kind": "reject"}
    )

    assert response.status_code == 409
    assert review_app.state.session_store.get_session(session["id"])["status"] == "running"


def test_reject_is_refused_while_the_threads_task_awaits_review(review_app, review_client):
    task, session, controller = _blocked_task_thread(review_app, policy="human")
    controller.complete_session(session["id"], "Done.", work_outcome="needs_review")
    assert review_app.state.task_store.get_task(task["id"])["status"] == "review"

    response = review_client.post(
        f"/api/v1/threads/{session['id']}/decisions", json={"kind": "reject"}
    )

    # The task's review is where its changes are requested; a thread reject
    # would leave the task in review with nothing to resume it.
    assert response.status_code == 409
    assert response.json()["detail"] == "task_review_pending"
    assert review_app.state.session_store.get_session(session["id"])["status"] == "completed"


def test_mark_done_is_the_humans_acceptance(review_app, review_client):
    task, session, controller = _blocked_task_thread(review_app, policy="human")
    controller.complete_session(
        session["id"], "The round reported it is blocked. Ship it?",
        task_status="waiting_for_human", work_outcome="blocked",
    )

    response = review_client.post(
        f"/api/v1/threads/{session['id']}/decisions", json={"kind": "mark_done"}
    )

    assert response.status_code == 200
    # A person pressing "mark done" has accepted the work; a second review
    # step would ask them the same question twice.
    assert review_app.state.task_store.get_task(task["id"])["status"] == "done"


def test_reject_serializes_validation_with_run_admission(review_app, review_client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from relay.api import session_routes

    _task, session, controller = _blocked_task_thread(review_app)
    controller.complete_session(session["id"], "Done")
    original = session_routes._assert_rejectable
    with ThreadPoolExecutor(max_workers=1) as pool:
        def validate(snapshot, ctx):
            original(snapshot, ctx)
            def can_admit():
                acquired = ctx.registry.dispatch_lock.acquire(blocking=False)
                if acquired:
                    ctx.registry.dispatch_lock.release()
                return acquired
            assert not pool.submit(can_admit).result(timeout=2)
        monkeypatch.setattr(session_routes, "_assert_rejectable", validate)
        response = review_client.post(f"/api/v1/threads/{session['id']}/decisions", json={"kind": "reject"})
    assert response.status_code == 200


def test_admin_stop_preserves_identity_for_backend(review_app, review_client, monkeypatch):
    session = SessionController(
        review_app.state.session_store, owner_user_id=_admin_id(review_app)
    ).create_session("Stop")
    monkeypatch.setattr(review_app.state.registry, "monitor_nodes", lambda: [{"id": "node", "activeRuns": [{"sessionId": session["id"]}]}])
    received = {}
    def cancel_run(node_id, session_id, reason, **kwargs):
        received.update(kwargs)
        return session
    monkeypatch.setattr(review_app.state.backend, "cancel_run", cancel_run)
    response = review_client.post(f"/api/v1/threads/{session['id']}/cancellations", json={})
    assert response.status_code == 202
    assert received["actor_user_id"] == _admin_id(review_app)
    assert received["actor_is_admin"] is True


def test_reject_rechecks_the_thread_after_acquiring_admission_scope(review_app, review_client, monkeypatch):
    from contextlib import contextmanager

    _task, session, controller = _blocked_task_thread(review_app)
    controller.complete_session(session["id"], "Done")
    original = review_app.state.session_store.mutation_scope
    @contextmanager
    def admission_won(session_id):
        # Admission completed between the route's initial read and row lock.
        with original(session_id):
            review_app.state.session_store.append_event(session_id, {
                "type": "session.status", "sessionId": session_id,
                "id": "evt_new_run", "timestamp": now_iso(),
                "status": "running", "phase": "running",
            })
            yield
    monkeypatch.setattr(review_app.state.session_store, "mutation_scope", admission_won)
    response = review_client.post(f"/api/v1/threads/{session['id']}/decisions", json={"kind": "reject"})
    assert response.status_code == 409
    assert response.json()["detail"] == "session_run_in_flight"
    assert not review_app.state.session_store.get_session(session["id"])["decisions"]


def test_web_assets_cache_only_content_hashed_files(review_app, monkeypatch, tmp_path):
    dist = tmp_path / "out"
    (dist / "_next" / "static" / "chunks").mkdir(parents=True)
    (dist / "_next" / "static" / "chunks" / "app-1.js").write_text("app")
    (dist / "index.html").write_text("<html></html>")
    (dist / "favicon.ico").write_bytes(b"icon")
    (dist / "landing").mkdir()
    (dist / "landing" / "threads.webp").write_bytes(b"shot")
    # The web UI directory is read once at startup (core/settings.py).
    replace_app_context(review_app, settings=replace(review_app.state.settings, web_ui_dist_dir=dist))
    client = TestClient(review_app)
    hashed = client.get("/_next/static/chunks/app-1.js")
    assert hashed.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert client.get("/landing/threads.webp").headers["cache-control"] == "public, max-age=86400"
    # Fixed names and pages revalidate, so a deploy is visible at once.
    for path in ("/favicon.ico", "/", "/index.html", "/threads"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.headers["cache-control"] == "no-cache", path
