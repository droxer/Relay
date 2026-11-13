"""Queues survive independent clients and are advanced without a browser."""

from fastapi.testclient import TestClient
from relay.app import create_app


def test_queue_is_shared_and_owner_scoped(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    with TestClient(app) as laptop:
        login = laptop.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "email": "admin@example.com", "password": "kestrel-vault-7719"},
        )
        assert login.status_code == 200
        owner = app.state.auth_store.resolve_user_id("admin")
        thread = app.state.session_store.create_session(
            {"workspacePath": str(tmp_path), "taskGoal": "queue", "ownerUserId": owner}
        )
        path = f"/api/v1/threads/{thread['id']}/queue"
        added = laptop.post(path, json={"action": "enqueue", "id": "q_test", "text": "Next step"})
        assert added.status_code == 200, added.text
        with TestClient(create_app(tmp_path)) as phone:
            phone.cookies.update(laptop.cookies)
            assert phone.get(path).json()["messages"] == [{"id": "q_test", "text": "Next step"}]
            assert phone.post(path, json={"action": "remove", "id": "q_test"}).status_code == 200
        assert laptop.get(path).json()["messages"] == []
        assert laptop.post(path, json={"action": "undo_remove", "id": "q_test"}).json()["messages"] == [{"id": "q_test", "text": "Next step"}]


def test_queue_dispatch_without_browser(tmp_path, monkeypatch):
    import asyncio
    from relay.collaboration.queue import ThreadQueueDispatcher, change_queue
    from relay.collaboration.service import CollaborationConductor
    from relay.persistence.events import relay_event

    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    client.post(
        "/api/v1/auth/bootstrap", json={"token": "admin_token", "username": "admin", "email": "admin@example.com", "password": "kestrel-vault-7719"}
    )
    store = app.state.session_store
    thread = store.create_session(
        {
            "workspacePath": str(tmp_path),
            "taskGoal": "queue",
            "ownerUserId": app.state.auth_store.resolve_user_id("admin"),
        }
    )
    tid = thread["id"]
    store.append_event(tid, relay_event("session.status", tid, {"status": "completed", "phase": "done"}))
    change_queue(store, tid, "enqueue", message={"id": "q1", "text": "next"})
    sent = []

    async def submit(self, intent, actor):
        sent.append(intent)
        return {}

    monkeypatch.setattr(CollaborationConductor, "submit", submit)
    dispatcher = ThreadQueueDispatcher(app.state.context)
    asyncio.run(dispatcher.tick())
    assert [m.text for m in sent] == ["next"]
    assert store.get_session(tid)["messageQueue"]["messages"] == []
    asyncio.run(dispatcher.tick())
    assert len(sent) == 1


def test_queue_failures_pause_and_keep_message(tmp_path, monkeypatch):
    import asyncio
    from relay.collaboration.errors import CollaborationError
    from relay.collaboration.queue import ThreadQueueDispatcher, change_queue
    from relay.collaboration.service import CollaborationConductor
    from relay.persistence.events import relay_event

    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    app = create_app(tmp_path)
    store = app.state.session_store
    thread = store.create_session({"workspacePath": str(tmp_path), "taskGoal": "queue", "ownerUserId": "owner"})
    tid = thread["id"]
    store.append_event(tid, relay_event("session.status", tid, {"status": "completed", "phase": "done"}))
    change_queue(store, tid, "enqueue", message={"id": "q1", "text": "next"})

    async def submit(self, intent, actor):
        raise CollaborationError("computer_unavailable", "Choose an available computer.")

    monkeypatch.setattr(CollaborationConductor, "submit", submit)
    dispatcher = ThreadQueueDispatcher(app.state.context)
    asyncio.run(dispatcher.tick())
    state = store.get_session(tid)["messageQueue"]
    assert state["paused"] and state["messages"][0]["id"] == "q1"
    assert "available computer" in state["error"]
    change_queue(store, tid, "resume")
    # Two workers cannot claim the same message while its dispatch is active.
    assert dispatcher._claim(tid)
    assert dispatcher._claim(tid) is None
    import pytest

    with pytest.raises(ValueError, match="being sent"):
        change_queue(store, tid, "remove", message_id="q1")


def test_queue_receipts_survive_removal_and_import_pauses(tmp_path):
    from store_fixtures import make_session_store
    from relay.collaboration.queue import change_queue

    store = make_session_store(tmp_path)
    thread = store.create_session({"workspacePath": str(tmp_path), "taskGoal": "queue", "ownerUserId": "owner"})
    tid = thread["id"]
    message = {"id": "old", "text": "legacy draft"}
    assert change_queue(store, tid, "import", message=message)["paused"]
    change_queue(store, tid, "remove", message_id="old")
    # A lost enqueue response retried after dispatch/removal cannot send twice.
    assert change_queue(store, tid, "enqueue", message=message)["messages"] == []
    import pytest

    with pytest.raises(ValueError, match="another message"):
        change_queue(store, tid, "enqueue", message={"id": "old", "text": "different"})


def test_queue_dispatches_real_round_and_retains_mention_target(monkeypatch):
    import asyncio
    from test_thread_same_computer_targets import _world, _agent, _sync, _thread
    from relay.collaboration.queue import ThreadQueueDispatcher
    from relay.persistence.events import relay_event

    with _world(monkeypatch) as (app, client, here, there):
        solo = _agent(app, here, "Solo", "codex")
        reviewer = _agent(app, here, "Reviewer", "claude")
        _sync(app, here, there)
        thread = _thread(app, here, solo)
        tid = thread["id"]
        app.state.session_store.append_event(
            tid, relay_event("session.status", tid, {"status": "completed", "phase": "done"})
        )
        response = client.post(
            f"/api/v1/threads/{tid}/queue",
            json={"action": "enqueue", "id": "q_review", "text": "@Reviewer check the fix"},
        )
        assert response.status_code == 200, response.text
        asyncio.run(ThreadQueueDispatcher(app.state.context).dispatch(tid))
        result = app.state.session_store.get_session(tid)
        assert result["messageQueue"]["messages"] == [], result["messageQueue"]
        manifest = result["collaborationRounds"][-1]
        assert [a["agentId"] for a in manifest["assignments"]] == [reviewer["id"]]
        assert app.state.registry.daemon_store.active_run_request_for_session_any_node(tid)


def test_queue_rejects_non_owner_and_invalid_payloads(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    app = create_app(tmp_path)
    client = TestClient(app)
    client.post(
        "/api/v1/auth/bootstrap", json={"token": "admin_token", "username": "admin", "email": "admin@example.com", "password": "kestrel-vault-7719"}
    )
    thread = app.state.session_store.create_session(
        {
            "workspacePath": str(tmp_path),
            "taskGoal": "queue",
            "ownerUserId": app.state.auth_store.resolve_user_id("admin"),
        }
    )
    path = f"/api/v1/threads/{thread['id']}/queue"
    assert client.post(path, json={"action": "enqueue", "id": "q1", "text": " "}).status_code == 400
    assert client.post(path, json={"action": "enqueue", "id": "q1", "text": "@Missing do work"}).status_code == 400
    app.state.auth_store.create_account("other", "kestrel-vault-7719", email="other@example.com")
    other = TestClient(app)
    assert (
        other.post("/api/v1/auth/login", json={"username": "other", "password": "kestrel-vault-7719"}).status_code
        == 200
    )
    assert other.get(path).status_code == 403
    assert other.post(path, json={"action": "enqueue", "id": "q1", "text": "Private"}).status_code == 403


def test_lost_dispatch_ack_replays_same_real_round(monkeypatch):
    import asyncio
    from test_thread_same_computer_targets import _world, _agent, _sync, _thread
    from relay.collaboration.queue import ThreadQueueDispatcher
    from relay.persistence.events import relay_event

    with _world(monkeypatch) as (app, client, here, there):
        solo = _agent(app, here, "Solo", "codex")
        _sync(app, here)
        tid = _thread(app, here, solo)["id"]
        store = app.state.session_store
        store.append_event(tid, relay_event("session.status", tid, {"status": "completed", "phase": "done"}))
        assert (
            client.post(
                f"/api/v1/threads/{tid}/queue", json={"action": "enqueue", "id": "q_retry", "text": "Continue"}
            ).status_code
            == 200
        )
        dispatcher = ThreadQueueDispatcher(app.state.context)
        finish = dispatcher._finish
        monkeypatch.setattr(dispatcher, "_finish", lambda *args: None)
        asyncio.run(dispatcher.dispatch(tid))
        before = store.get_session(tid)
        assert before["messageQueue"]["sending"] == "q_retry"
        queue = before["messageQueue"]
        queue["leaseUntil"] = "2000-01-01T00:00:00+00:00"
        store.append_event(tid, relay_event("session.queue", tid, {"queue": queue}))
        monkeypatch.setattr(dispatcher, "_finish", finish)
        asyncio.run(dispatcher.dispatch(tid))
        after = store.get_session(tid)
        assert after["messageQueue"]["messages"] == []
        assert len(after["collaborationRounds"]) == len(before["collaborationRounds"])


def test_stop_between_claim_and_admission_cancels_the_new_run(monkeypatch):
    import asyncio
    from test_thread_same_computer_targets import _world, _agent, _sync, _thread
    from relay.collaboration.queue import ThreadQueueDispatcher, change_queue
    from relay.collaboration.service import CollaborationConductor
    from relay.persistence.events import relay_event

    with _world(monkeypatch) as (app, client, here, there):
        solo = _agent(app, here, "Solo", "codex")
        _sync(app, here)
        tid = _thread(app, here, solo)["id"]
        store = app.state.session_store
        store.append_event(tid, relay_event("session.status", tid, {"status": "completed", "phase": "done"}))
        change_queue(store, tid, "enqueue", message={"id": "q_stop", "text": "Continue"})
        original = CollaborationConductor.submit

        async def stop_then_submit(self, intent, actor):
            change_queue(store, tid, "pause")
            return await original(self, intent, actor)

        monkeypatch.setattr(CollaborationConductor, "submit", stop_then_submit)
        asyncio.run(ThreadQueueDispatcher(app.state.context).dispatch(tid))
        assert store.get_session(tid)["messageQueue"]["paused"]
        assert app.state.registry.daemon_store.active_run_request_for_session_any_node(tid) is None


def test_a_steered_message_is_sent_as_soon_as_the_stopped_run_settles(tmp_path, monkeypatch):
    import asyncio
    from relay.collaboration import queue as thread_queue
    from relay.collaboration.queue import ThreadQueueDispatcher, change_queue
    from relay.collaboration.service import CollaborationConductor

    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    monkeypatch.setattr(thread_queue, "STEER_POLL_SECONDS", 0.01)
    app = create_app(tmp_path)
    store = app.state.session_store
    tid = store.create_session({"workspacePath": str(tmp_path), "taskGoal": "queue", "ownerUserId": "owner"})["id"]
    change_queue(store, tid, "enqueue", message={"id": "q1", "text": "later"})
    change_queue(store, tid, "enqueue", message={"id": "q2", "text": "steer"})
    change_queue(store, tid, "promote", message_id="q2")
    # The stopped run takes a few polls to settle; nothing may go out before.
    phases = iter(["stopping", "stopping", "finalizing"])
    lifecycle = app.state.context.execution_lifecycle
    monkeypatch.setattr(lifecycle, "status", lambda _session: {"phase": next(phases, "terminal")})
    sent = []

    async def submit(self, intent, actor):
        sent.append(intent.text)
        return {}

    monkeypatch.setattr(CollaborationConductor, "submit", submit)

    async def follow():
        ThreadQueueDispatcher(app.state.context).follow_requested_send(tid)
        ThreadQueueDispatcher(app.state.context).follow_requested_send(tid)  # one follower per thread
        await asyncio.wait_for(next(iter(thread_queue._followers.values())), timeout=5)

    asyncio.run(follow())
    assert sent == ["steer"]
    assert [m["id"] for m in store.get_session(tid)["messageQueue"]["messages"]] == ["q1"]
    assert thread_queue._followers == {}


def test_steer_keeps_the_selected_agent_instead_of_the_whole_room(monkeypatch):
    import asyncio
    from test_thread_same_computer_targets import _world, _agent, _sync, _thread
    from relay.collaboration.queue import ThreadQueueDispatcher, change_queue
    from relay.persistence.events import relay_event

    with _world(monkeypatch) as (app, client, here, there):
        solo = _agent(app, here, "Solo", "codex")
        selected = _agent(app, here, "Selected", "claude")
        _sync(app, here)
        tid = _thread(app, here, solo, participantAgentIds=[solo["id"], selected["id"]])["id"]
        store = app.state.session_store
        response = client.post(
            f"/api/v1/threads/{tid}/queue",
            json={"action": "enqueue", "id": "q_selected", "text": "Continue",
                  "addressAgentIds": [selected["id"]]},
        )
        assert response.status_code == 200, response.text
        change_queue(store, tid, "promote", message_id="q_selected")
        store.append_event(tid, relay_event("session.status", tid, {"status": "completed", "phase": "done"}))
        asyncio.run(ThreadQueueDispatcher(app.state.context).dispatch(tid))
        after = store.get_session(tid)
        assert after["messageQueue"]["messages"] == [], after["messageQueue"]
        assert [a["agentId"] for a in after["collaborationRounds"][-1]["assignments"]] == [selected["id"]]


def test_queue_preserves_selected_team_and_rejects_invalid_addressing(monkeypatch):
    import asyncio
    from test_thread_same_computer_targets import _world, _agent, _sync, _thread, _team
    from relay.collaboration.queue import ThreadQueueDispatcher
    from relay.persistence.events import relay_event

    with _world(monkeypatch) as (app, client, here, there):
        solo = _agent(app, here, "Solo", "codex")
        selected = _agent(app, here, "Selected", "claude")
        _sync(app, here)
        team = _team(app, "Selected crew", selected)
        tid = _thread(app, here, solo)["id"]
        path = f"/api/v1/threads/{tid}/queue"
        for invalid in ({"addressAgentIds": "bad"}, {"addressAgentIds": [None]},
                        {"addressTeamId": []}, {"addressTeamId": " "},
                        {"addressTeamId": team["id"], "addressAgentIds": [solo["id"]]}):
            response = client.post(path, json={"action": "enqueue", "id": "q_invalid", "text": "Continue", **invalid})
            assert response.status_code == 400, response.text
        response = client.post(path, json={"action": "enqueue", "id": "q_team", "text": "Continue",
                                         "addressTeamId": team["id"]})
        assert response.status_code == 200, response.text
        assert response.json()["messages"][0]["addressTeamId"] == team["id"]
        app.state.session_store.append_event(tid, relay_event("session.status", tid, {"status": "completed", "phase": "done"}))
        asyncio.run(ThreadQueueDispatcher(app.state.context).dispatch(tid))
        after = app.state.session_store.get_session(tid)
        assert after["messageQueue"]["messages"] == [], after["messageQueue"]
        assert [a["agentId"] for a in after["collaborationRounds"][-1]["assignments"]] == [selected["id"]]


def test_remove_undo_restores_recipient_and_order_without_duplicate(tmp_path):
    from store_fixtures import make_session_store
    from relay.collaboration.queue import change_queue

    store = make_session_store(tmp_path)
    tid = store.create_session({"workspacePath": str(tmp_path), "taskGoal": "queue", "ownerUserId": "owner"})["id"]
    message = {"id": "q1", "text": "Review", "addressAgentIds": ["reviewer"]}
    change_queue(store, tid, "enqueue", message=message)
    change_queue(store, tid, "enqueue", message={"id": "q2", "text": "Next"})
    removed = change_queue(store, tid, "remove", message_id="q1")
    assert removed["removed"]["message"] == message
    restored = change_queue(store, tid, "undo_remove", message_id="q1")
    assert restored["messages"] == [message, {"id": "q2", "text": "Next"}]
    assert "removed" not in restored
    assert change_queue(store, tid, "undo_remove", message_id="q1")["messages"] == restored["messages"]


def test_undo_preserves_receipt_and_cannot_exceed_queue_limit(tmp_path):
    import pytest
    from store_fixtures import make_session_store
    from relay.collaboration.queue import change_queue

    store = make_session_store(tmp_path)
    tid = store.create_session({"workspacePath": str(tmp_path), "taskGoal": "queue", "ownerUserId": "owner"})["id"]
    original = {"id": "original", "text": "Restore team", "addressTeamId": "team"}
    change_queue(store, tid, "enqueue", message=original)
    change_queue(store, tid, "remove", message_id="original")
    for index in range(20):
        change_queue(store, tid, "enqueue", message={"id": f"q{index}", "text": "Queued"})
    with pytest.raises(ValueError, match="full"):
        change_queue(store, tid, "undo_remove", message_id="original")
    # Editing frees space without replacing the last removal record.
    change_queue(store, tid, "edit", message_id="q0")
    state = change_queue(store, tid, "undo_remove", message_id="original")
    assert state["messages"][-1] == original
    assert len(state["messages"]) == 20
