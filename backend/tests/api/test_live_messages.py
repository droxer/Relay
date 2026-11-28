"""'Send now' hands a queued message to the live run when its computer can take it."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from test_thread_same_computer_targets import _admin_id, _agent, _sync, _thread, _world

from relay.collaboration.queue import _save_queue
from relay.collaboration.thread_queue.dispatcher import ThreadQueueDispatcher
from relay.sessions.conversation import compute_conversation_history

TOKEN = "token_node_live"


def _live_node(app: Any) -> dict[str, Any]:
    return app.state.registry.register({
        "sandboxId": "node_live",
        "userId": _admin_id(app),
        "token": TOKEN,
        "workspacePath": "/workspace/node_live",
        "protocolVersion": 1,
        "supportedAgents": ["codex", "claude"],
        "capabilities": ["workspace-scope", "thread-workspaces", "work-results", "live-messages"],
        "status": "ready",
    })


def _running_thread(app: Any, client: Any, node: dict[str, Any], agent: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    tid = _thread(app, node, agent)["id"]
    assert client.post(f"/api/v1/threads/{tid}/messages", json={"text": "First turn"}).status_code == 202
    [run] = app.state.registry.take_commands(node["id"], TOKEN)
    assert run["type"] == "run.start"
    return tid, run


def _answer(client: Any, node: dict[str, Any], steer: dict[str, Any], **fields: Any) -> Any:
    return client.post(
        f"/api/v1/daemon-nodes/{node['id']}/events",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={
            "type": "run.steered", "commandId": steer["id"], "targetCommandId": steer["commandId"],
            "sessionId": steer["sessionId"], "runId": steer["runId"], "agent": steer["agent"],
            "messageId": steer["messageId"], **fields,
        },
    )


def _enqueue_and_steer(client: Any, tid: str, message: dict[str, Any]) -> Any:
    path = f"/api/v1/threads/{tid}/queue"
    assert client.post(path, json={"action": "enqueue", **message}).status_code == 200
    return client.post(path, json={"action": "steer", "id": message["id"]})


def test_a_delivered_message_joins_the_running_turn_without_stopping_it(monkeypatch):
    followed: list[str] = []
    monkeypatch.setattr(ThreadQueueDispatcher, "follow_requested_send", lambda _self, tid: followed.append(tid))
    with _world(monkeypatch) as (app, client, _here, _there):
        node = _live_node(app)
        solo = _agent(app, node, "Solo", "codex")
        _sync(app, node)
        tid, run = _running_thread(app, client, node, solo)
        registry = app.state.registry

        response = _enqueue_and_steer(client, tid, {"id": "q_live", "text": "Use the staging database."})
        assert response.status_code == 200, response.text
        assert response.json()["live"]["id"] == "q_live"

        [steer] = registry.take_commands(node["id"], TOKEN)
        assert steer["type"] == "run.steer"
        assert (steer["commandId"], steer["runId"], steer["messageId"], steer["text"]) == (
            run["id"], run["runId"], "q_live", "Use the staging database.",
        )
        # While the computer answers, nothing else sends or removes the message.
        assert ThreadQueueDispatcher(app.state.context)._claim(tid) is None
        held = client.post(f"/api/v1/threads/{tid}/queue", json={"action": "remove", "id": "q_live"})
        assert held.status_code == 409

        assert _answer(client, node, steer, outcome="delivered", delivery="steer").status_code == 200
        # A redelivered answer changes nothing.
        assert _answer(client, node, steer, outcome="delivered", delivery="steer").status_code == 200

        thread = app.state.session_store.get_session(tid)
        assert thread["status"] == "running"
        live = [event for event in thread["events"] if event["type"] == "user.live_message"]
        assert [(event["text"], event["runId"], event["delivery"]) for event in live] == [
            ("Use the staging database.", run["runId"], "steer"),
        ]
        # A live message is not a new user turn.
        assert [event["text"] for event in thread["events"] if event["type"] == "user.message"] == ["First turn"]
        queue = client.get(f"/api/v1/threads/{tid}/queue").json()
        assert queue["messages"] == [] and "live" not in queue and "steeringUntil" not in queue
        assert registry.take_commands(node["id"], TOKEN) == []
        # Only "Send now" started a follower, as a backstop should the computer never answer.
        assert followed == [tid]


def test_a_message_the_run_cannot_take_falls_back_to_stop_and_send(monkeypatch):
    followed: list[str] = []
    monkeypatch.setattr(ThreadQueueDispatcher, "follow_requested_send", lambda _self, tid: followed.append(tid))
    with _world(monkeypatch) as (app, client, _here, _there):
        node = _live_node(app)
        solo = _agent(app, node, "Solo", "claude")
        _sync(app, node)
        tid, run = _running_thread(app, client, node, solo)
        registry = app.state.registry
        assert _enqueue_and_steer(client, tid, {"id": "q_later", "text": "Send after a stop"}).status_code == 200
        [steer] = registry.take_commands(node["id"], TOKEN)

        answered = _answer(client, node, steer, outcome="unavailable", reason="This run is not taking messages.")
        assert answered.status_code == 200, answered.text
        # "Send now" started one follower; the fallback starts the one that sends after the stop.
        assert followed == [tid, tid]
        [stop] = registry.take_commands(node["id"], TOKEN)
        assert (stop["type"], stop["commandId"]) == ("run.cancel", run["id"])
        queue = client.get(f"/api/v1/threads/{tid}/queue").json()
        assert [m["id"] for m in queue["messages"]] == ["q_later"]
        assert queue["sendRequested"] is True and "live" not in queue

        registry.handle_event(node["id"], {
            "type": "run.cancelled", "commandId": run["id"], "runId": run["runId"],
            "sessionId": tid, "agent": run["agent"], "reason": "Stopped",
        }, TOKEN)
        asyncio.run(ThreadQueueDispatcher(app.state.context).dispatch(tid))
        [next_run] = registry.take_commands(node["id"], TOKEN)
        assert next_run["type"] == "run.start"
        thread = app.state.session_store.get_session(tid)
        assert [event["text"] for event in thread["events"] if event["type"] == "user.message"] == [
            "First turn", "Send after a stop",
        ]


@pytest.mark.parametrize("include_running_agent", [False, True])
def test_a_message_for_another_agent_stops_the_run_instead(monkeypatch, include_running_agent):
    monkeypatch.setattr(ThreadQueueDispatcher, "follow_requested_send", lambda *_: None)
    with _world(monkeypatch) as (app, client, _here, _there):
        node = _live_node(app)
        solo = _agent(app, node, "Solo", "codex")
        other = _agent(app, node, "Other", "claude")
        _sync(app, node)
        tid, run = _running_thread(app, client, node, solo)
        recipients = [other["id"], solo["id"]] if include_running_agent else [other["id"]]
        response = _enqueue_and_steer(client, tid, {"id": "q_other", "text": "Your turn", "addressAgentIds": recipients})
        assert response.status_code == 200, response.text
        assert "live" not in response.json()
        [stop] = app.state.registry.take_commands(node["id"], TOKEN)
        assert (stop["type"], stop["commandId"]) == ("run.cancel", run["id"])


def test_an_unanswered_message_is_sent_after_the_run(monkeypatch):
    monkeypatch.setattr(ThreadQueueDispatcher, "follow_requested_send", lambda *_: None)
    with _world(monkeypatch) as (app, client, _here, _there):
        node = _live_node(app)
        solo = _agent(app, node, "Solo", "codex")
        _sync(app, node)
        tid, run = _running_thread(app, client, node, solo)
        registry, store = app.state.registry, app.state.session_store
        assert _enqueue_and_steer(client, tid, {"id": "q_lost", "text": "Did it arrive?"}).status_code == 200
        registry.take_commands(node["id"], TOKEN)
        # The computer went quiet; its answer window has passed.
        with store.mutation_scope(tid):
            state = store.get_session_header(tid)["messageQueue"]
            past = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
            _save_queue(store, tid, {**state, "live": {**state["live"], "until": past}, "steeringUntil": past})
        registry.handle_event(node["id"], {
            "type": "run.cancelled", "commandId": run["id"], "runId": run["runId"],
            "sessionId": tid, "agent": run["agent"], "reason": "Stopped",
        }, TOKEN)
        asyncio.run(ThreadQueueDispatcher(app.state.context).dispatch(tid))
        thread = store.get_session(tid)
        assert [event["text"] for event in thread["events"] if event["type"] == "user.message"][-1] == "Did it arrive?"
        assert "live" not in thread["messageQueue"]


def test_an_invalid_answer_is_refused(monkeypatch):
    with _world(monkeypatch) as (app, client, _here, _there):
        node = _live_node(app)
        steer = {"id": "cmd_x", "commandId": "cmd_run", "sessionId": "ses_x", "runId": "run_x", "agent": "codex", "messageId": "q"}
        assert _answer(client, node, steer, outcome="maybe").status_code == 400
        assert _answer(client, node, steer, outcome="delivered").status_code == 400
        # An answer for a command this backend never queued is acknowledged and ignored.
        assert _answer(client, node, steer, outcome="unavailable").status_code == 200


def test_the_next_run_hears_what_was_said_to_the_last_one():
    session = {
        "createdAt": "2026-11-22T10:00:00Z",
        "taskGoal": "Fix the bug",
        "events": [
            {"type": "session.created", "timestamp": "2026-11-22T10:00:00Z"},
            {"type": "user.message", "timestamp": "2026-11-22T10:00:01Z", "text": "Fix the bug"},
            {"type": "user.live_message", "timestamp": "2026-11-22T10:00:05Z", "text": "Use the staging database.", "agent": "codex"},
        ],
        "agentRuns": [],
    }
    history = compute_conversation_history(session, store=None)  # type: ignore[arg-type]
    assert history is not None
    assert "[User, to @codex while it worked]\nUse the staging database." in history
