from __future__ import annotations

import json
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.api.threads.events import _STREAM_FALLBACK_SECONDS
from relay.app import create_app
from relay.persistence.events import relay_event


def _bootstrap_admin(client: TestClient, token: str = "admin_token") -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={"token": token, "username": "admin", "password": "kestrel-vault-7719"},
    )
    assert response.status_code == 200


def _parse_sse(body: str) -> list[tuple[str, str]]:
    """Return (event, data) pairs from an SSE body; default event name is 'message'."""
    frames: list[tuple[str, str]] = []
    for block in body.split("\n\n"):
        if not block.strip():
            continue
        event = "message"
        data = ""
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("data: "):
                data = line[len("data: ") :]
        frames.append((event, data))
    return frames


def _message_payloads(body: str) -> list[dict[str, object]]:
    payloads: list[dict[str, object]] = []
    for event, data in _parse_sse(body):
        decoded = json.loads(data)
        if event == "message":
            payloads.append(decoded)
        elif event == "batch":
            payloads.extend(decoded["events"])
    return payloads


def test_session_event_stream_uses_slow_recovery_polling() -> None:
    # Committed events wake the stream through the notification broker. The
    # fallback exists only to recover from a missed notification and therefore
    # must not recreate the old 20-queries-per-second hot poll.
    assert _STREAM_FALLBACK_SECONDS >= 1.0


def test_session_list_summary_omits_event_history(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        created = client.post("/api/v1/threads", json={"taskGoal": "ship it"})
        assert created.status_code == 201

        response = client.get("/api/v1/threads?view=summary")

        assert response.status_code == 200
        summary = response.json()["sessions"][0]
        assert summary["id"] == created.json()["id"]
        assert summary["eventCount"] == len(created.json()["events"])
        assert "events" not in summary
        assert "agentRuns" not in summary


def test_session_events_streams_backlog_then_closes_on_terminal(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        created = client.post(
            "/api/v1/threads",
            json={"taskGoal": "ship it", "assignments": [{"agent": "claude"}]},
        )
        assert created.status_code == 201
        session_id = created.json()["id"]

        # Drive the session to a terminal state so the tail-poll flushes the
        # backlog and closes instead of holding the connection open.
        done = client.post(
            f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
        )
        assert done.status_code == 200
        assert done.json()["status"] == "completed"

        response = client.get(f"/api/v1/threads/{session_id}/events")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        frames = _parse_sse(response.text)
        # The wire contract remains one domain event per default SSE message;
        # the browser coalesces all messages received in one animation frame.
        message_types = [
            payload["type"] for payload in _message_payloads(response.text)
        ]
        assert "session.created" in message_types
        assert [event for event, _ in frames].count("message") == len(message_types)
        assert frames[-1][0] == "done"


def test_mark_done_persists_a_delivery_fence_for_an_active_request(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "userId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        created = client.post("/api/v1/threads", json={"taskGoal": "finish safely"})
        session_id = created.json()["id"]
        run_request = app.state.daemon_store.create_run_request(
            {
                "nodeId": "node_admin",
                "sessionId": session_id,
                "taskGoal": "finish safely",
                "assignments": [
                    {
                        "assignmentId": "assignment_mark_done",
                        "executorKind": "codex",
                        "mode": "action",
                    }
                ],
                "state": {},
                "status": "running",
            }
        )

        done = client.post(
            f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
        )

        assert done.status_code == 200, done.text
        assert done.json()["status"] == "completed"
        assert (
            app.state.daemon_store.get_run_request(run_request["id"])["status"]
            == "cancelled"
        )


def test_terminal_session_stream_drains_every_bounded_page(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        created = client.post("/api/v1/threads", json={"taskGoal": "stream all"})
        session_id = created.json()["id"]
        for sequence in range(300):
            app.state.session_store.append_event(
                session_id,
                relay_event(
                    "agent.output",
                    session_id,
                    {
                        "runId": "run_long",
                        "agent": "codex",
                        "stream": "stdout",
                        "text": str(sequence),
                        "sequence": sequence,
                    },
                ),
                hydrate_events=False,
            )
        app.state.session_store.append_event(
            session_id,
            relay_event("session.completed", session_id, {"outcome": "done"}),
            hydrate_events=False,
        )

        response = client.get(f"/api/v1/threads/{session_id}/events")

        assert response.status_code == 200
        # session.created + 300 output events + session.completed
        assert len(_message_payloads(response.text)) == 303
        assert _parse_sse(response.text)[-1][0] == "done"


def test_session_events_cursor_skips_already_cached_history(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        created = client.post(
            "/api/v1/threads",
            json={"taskGoal": "ship it", "assignments": [{"agent": "claude"}]},
        )
        assert created.status_code == 201
        session_id = created.json()["id"]

        done = client.post(
            f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
        )
        assert done.status_code == 200
        events = done.json()["events"]

        after_created = client.get(
            f"/api/v1/threads/{session_id}/events?after={events[0]['id']}"
        )
        assert after_created.status_code == 200
        assert [payload["id"] for payload in _message_payloads(after_created.text)] == [
            event["id"] for event in events[1:]
        ]

        after_latest = client.get(
            f"/api/v1/threads/{session_id}/events?after={events[-1]['id']}"
        )
        assert after_latest.status_code == 200
        assert _message_payloads(after_latest.text) == []
        assert _parse_sse(after_latest.text)[-1][0] == "done"


def test_session_events_reconnect_header_overrides_initial_query_cursor(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        created = client.post(
            "/api/v1/threads",
            json={"taskGoal": "ship it", "assignments": [{"agent": "claude"}]},
        )
        assert created.status_code == 201
        session_id = created.json()["id"]
        done = client.post(
            f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
        )
        assert done.status_code == 200
        events = done.json()["events"]

        response = client.get(
            f"/api/v1/threads/{session_id}/events?after={events[0]['id']}",
            headers={"Last-Event-ID": events[-1]["id"]},
        )

        assert response.status_code == 200
        assert _message_payloads(response.text) == []
        assert _parse_sse(response.text)[-1][0] == "done"


def test_session_events_cursor_falls_back_to_backlog_for_unknown_event(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        created = client.post("/api/v1/threads", json={"taskGoal": "ship it"})
        assert created.status_code == 201
        session_id = created.json()["id"]
        done = client.post(
            f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
        )
        assert done.status_code == 200

        response = client.get(f"/api/v1/threads/{session_id}/events?after=evt_missing")
        assert response.status_code == 200
        assert [payload["id"] for payload in _message_payloads(response.text)] == [
            event["id"] for event in done.json()["events"]
        ]


def test_session_events_reads_incremental_pages_after_authorization(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        created = client.post("/api/v1/threads", json={"taskGoal": "ship it"})
        session_id = created.json()["id"]
        client.post(
            f"/api/v1/threads/{session_id}/decisions", json={"kind": "mark_done"}
        )

        store = app.state.session_store
        original_get_session = store.get_session
        get_session_calls = 0

        def counted_get_session(target: str):
            nonlocal get_session_calls
            get_session_calls += 1
            return original_get_session(target)

        monkeypatch.setattr(store, "get_session", counted_get_session)

        response = client.get(f"/api/v1/threads/{session_id}/events")

        assert response.status_code == 200
        # Authorization uses the compact session header; neither the handshake
        # nor the stream loop rematerializes the full thread event history.
        assert get_session_calls == 0


def test_session_events_unauthorized_is_forbidden_before_streaming(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        # A nonexistent session is a 404 (authorization runs before the stream
        # opens), proving errors still surface as normal responses.
        assert client.get("/api/v1/threads/sess_missing/events").status_code == 404


def test_session_events_accept_chat_service_actor(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        headers = {
            "Authorization": "Bearer chat_token",
            "X-Relay-User-Id": "alice",
        }

        created = client.post(
            "/api/v1/threads", json={"taskGoal": "from chat"}, headers=headers
        )
        assert created.status_code == 201
        session_id = created.json()["id"]

        done = client.post(
            f"/api/v1/threads/{session_id}/decisions",
            json={"kind": "mark_done"},
            headers=headers,
        )
        assert done.status_code == 200
        assert done.json()["status"] == "completed"

        response = client.get(f"/api/v1/threads/{session_id}/events", headers=headers)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        missing_user = client.get(
            f"/api/v1/threads/{session_id}/events",
            headers={"Authorization": "Bearer chat_token"},
        )
        assert missing_user.status_code == 401
