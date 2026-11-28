"""A message keeps its original acceptance across retry boundaries."""

from __future__ import annotations

import pytest
from relay.collaboration import queue
from relay.sessions.controller import SessionController

from test_thread_same_computer_targets import _agent, _sync, _thread, _world


def _complete(registry, node_id, token, command):
    registry.handle_event(node_id, {
        "type": "run.completed", "commandId": command["id"], "sessionId": command["sessionId"],
        "runId": command["runId"], "agent": command["agent"], "exitCode": 0,
        "agentLog": "Finished.", "leaseId": command.get("leaseId"),
        "roundResult": {"status": "done", "work": {"status": "done", "evidence": ["Verified"]}},
    }, token)


def _without_round_receipts(monkeypatch):
    record_round = SessionController.record_collaboration_round_started

    def record_legacy(self, session_id, manifest, *, hydrate=True, message_receipt=None):
        return record_round(self, session_id, manifest, hydrate=hydrate)

    monkeypatch.setattr(SessionController, "record_collaboration_round_started", record_legacy)


@pytest.mark.parametrize("opening", [False, True])
def test_retry_after_run_request_retention(monkeypatch, opening):
    with _world(monkeypatch) as (app, client, node, _):
        agent = _agent(app, node, "Solo", "codex")
        _sync(app, node)
        key = "evt_unchanged"
        identity = {"userMessageId": key, "idempotencyKey": key}
        if opening:
            url = "/api/v1/agent-runs"
            text_field = "taskGoal"
            payload = {**identity, "taskGoal": "Start", "assignments": [{"agentId": agent["id"]}]}
        else:
            url = f"/api/v1/threads/{_thread(app, node, agent)['id']}/messages"
            text_field = "text"
            payload = {**identity, "text": "Continue"}
        response = client.post(url, json=payload)
        assert response.status_code == 202, response.text
        sid = response.json()["id"]
        registry = app.state.registry
        token = "token_node_here"
        [first] = registry.take_commands(node["id"], token)
        _complete(registry, node["id"], token, first)
        assert app.state.context.execution_lifecycle.status(app.state.session_store.get_session(sid))["phase"] == "terminal"
        assert app.state.daemon_store.prune_terminal_records(0, 500, run_request_retention_seconds=0)["runRequests"] == 1
        retry = client.post(url, json=payload)
        assert retry.status_code == 202, retry.text
        assert retry.json()["id"] == sid
        assert retry.json()["messageRunRequestId"] == response.json()["messageRunRequestId"]
        assert client.post(url, json={**payload, text_field: "Different"}).status_code == 409
        assert registry.take_commands(node["id"], token) == []
        assert len(retry.json()["collaborationRounds"]) == 1
        assert sum(event["id"] == key for event in retry.json()["events"]) == (0 if opening else 1)


@pytest.mark.parametrize("queued", [False, True])
@pytest.mark.parametrize("legacy", [False, True])
def test_committed_mention_replays_after_rename(monkeypatch, queued, legacy):
    with _world(monkeypatch) as (app, client, node, _):
        agent = _agent(app, node, "Solo", "codex")
        _sync(app, node)
        sid = _thread(app, node, agent)["id"]
        suffix = "queue" if queued else "messages"
        url = f"/api/v1/threads/{sid}/{suffix}"
        key = "evt_unchanged"
        payload = {"text": "@Solo Continue"}
        if queued:
            payload.update(action="enqueue", id=key)
        else:
            payload.update(userMessageId=key, idempotencyKey=key)
        with monkeypatch.context() as before_upgrade:
            if legacy and queued:
                save_queue = queue._save_queue

                def save_legacy(store, thread_id, state, receipt_id=None, *, input_fingerprint=None):
                    save_queue(store, thread_id, state, receipt_id)

                before_upgrade.setattr(queue, "_save_queue", save_legacy)
            elif legacy:
                _without_round_receipts(before_upgrade)
            response = client.post(url, json=payload)
        status = 200 if queued else 202
        assert response.status_code == status, response.text
        app.state.agent_store.update_agent(agent["id"], {"displayName": "Renamed"})
        retry = client.post(url, json=payload)
        assert retry.status_code == status, retry.text
        assert client.post(url, json={**payload, "text": "@Solo Different"}).status_code == 409
        event_id = f"queue.accepted:{key}" if queued else key
        assert sum(event["id"] == event_id for event in app.state.session_store.get_session(sid)["events"]) == 1


def test_pre_upgrade_send_with_pruned_request_cannot_dispatch_again(monkeypatch):
    with _world(monkeypatch) as (app, client, node, _):
        agent = _agent(app, node, "Solo", "codex")
        _sync(app, node)
        sid = _thread(app, node, agent)["id"]
        url = f"/api/v1/threads/{sid}/messages"
        payload = {"text": "Continue", "userMessageId": "evt_legacy"}
        with monkeypatch.context() as before_upgrade:
            _without_round_receipts(before_upgrade)
            response = client.post(url, json=payload)
        assert response.status_code == 202, response.text
        registry = app.state.registry
        token = "token_node_here"
        [command] = registry.take_commands(node["id"], token)
        _complete(registry, node["id"], token, command)
        assert app.state.daemon_store.prune_terminal_records(0, 500, run_request_retention_seconds=0)["runRequests"] == 1

        retry = client.post(url, json=payload)
        assert retry.status_code == 409, retry.text
        assert retry.json()["detail"]["code"] == "message_receipt_unavailable"
        assert registry.take_commands(node["id"], token) == []


def test_late_receipt_stop_leaves_newer_run_and_queue_alone(monkeypatch):
    with _world(monkeypatch) as (app, client, node, _):
        agent = _agent(app, node, "Solo", "codex")
        _sync(app, node)
        sid = _thread(app, node, agent)["id"]
        url = f"/api/v1/threads/{sid}/messages"
        first = {"text": "First", "userMessageId": "evt_first", "idempotencyKey": "evt_first"}
        second = {"text": "Second", "userMessageId": "evt_second", "idempotencyKey": "evt_second"}
        first_ack = client.post(url, json=first)
        assert first_ack.status_code == 202, first_ack.text
        registry = app.state.registry
        token = "token_node_here"
        [first_command] = registry.take_commands(node["id"], token)
        first_request = app.state.daemon_store.active_run_request_for_session_any_node(sid)
        _complete(registry, node["id"], token, first_command)
        response = client.post(url, json=second)
        assert response.status_code == 202, response.text
        [second_command] = registry.take_commands(node["id"], token)
        second_request = app.state.daemon_store.active_run_request_for_session_any_node(sid)
        receipt = client.post(f"{url}?view=compact", json=first)
        assert receipt.status_code == 202, receipt.text
        assert receipt.json()["id"] == sid
        assert receipt.json()["messageRunRequestId"] == first_ack.json()["messageRunRequestId"] == first_request["id"]
        stop = client.post(f"/api/v1/threads/{sid}/cancellations", json={
            "reason": "Stopped pending send",
            "expectedRunRequestId": receipt.json()["messageRunRequestId"],
        })
        assert stop.status_code == 202, stop.text
        assert registry.take_commands(node["id"], token) == []
        assert registry.daemon_store.active_run_request_for_session_any_node(sid)["id"] == second_request["id"]
        assert not (stop.json().get("messageQueue") or {}).get("paused")

        stop = client.post(f"/api/v1/threads/{sid}/cancellations", json={
            "expectedRunRequestId": response.json()["messageRunRequestId"],
        })
        assert stop.status_code == 202, stop.text
        [cancel] = registry.take_commands(node["id"], token)
        assert cancel["type"] == "run.cancel"
        assert cancel["commandId"] == second_command["id"]
