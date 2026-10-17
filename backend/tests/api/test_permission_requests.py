"""A live run's permission prompt reaches a person, and their answer reaches the run.

The daemon reports a prompt as `run.permission_requested` and polls for the
answer; only a person (never the node token) answers it, and a prompt whose
run ends first closes as expired so the daemon stops waiting.
"""
from __future__ import annotations

from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from relay.app import create_app
from relay.persistence.store_common import new_database_id
from relay.persistence.stores import relay_event
from relay.sessions.controller import SessionController

NODE_AUTH = {"Authorization": "Bearer node_token"}
REQUEST_ID = "perm_0123456789abcdef"


def _bootstrap(client: TestClient) -> None:
    response = client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token",
        "username": "admin",
        "password": "kestrel-vault-7719",
    })
    assert response.status_code == 200
    assert client.post("/api/v1/auth/login", json={
        "username": "admin", "password": "kestrel-vault-7719",
    }).status_code == 200


def _create_session(client: TestClient) -> str:
    response = client.post("/api/v1/threads", json={
        "taskGoal": "demo task",
        "assignments": [{"agent": "claude"}],
        "workspacePath": "/workspace",
    })
    assert response.status_code == 201
    return response.json()["id"]


def _dispatched_run(app, session_id: str) -> dict:
    registry = app.state.registry
    registry.register({
        "sandboxId": "sbx_alice", "userId": "alice", "token": "node_token",
        "protocolVersion": 1, "supportedAgents": ["claude"], "status": "ready",
    })
    request = registry.daemon_store.create_run_request({
        "nodeId": "sbx_alice", "sessionId": session_id, "taskGoal": "work",
        "assignments": [{"executorKind": "claude"}], "state": {},
    })
    command = {
        "id": new_database_id(), "type": "run.start", "sessionId": session_id,
        "runId": new_database_id(), "agent": "claude", "taskGoal": "work",
        "_runRequestId": request["id"],
    }
    registry.daemon_store.update_run_request(request["id"], {
        "currentCommandId": command["id"], "currentRunId": command["runId"],
    })
    registry.daemon_store.enqueue_command("sbx_alice", command)
    registry.daemon_store.take_queued_commands("sbx_alice", lease_seconds=60)
    SessionController(app.state.session_store).record_agent_started(session_id, {
        "runId": command["runId"], "agent": "claude",
    })
    return command


def _ask(client: TestClient, command: dict, **request: object) -> None:
    response = client.post(
        "/api/v1/daemon-nodes/sbx_alice/events",
        json={
            "type": "run.permission_requested",
            "commandId": command["id"],
            "sessionId": command["sessionId"],
            "runId": command["runId"],
            "agent": "claude",
            "request": {
                "id": REQUEST_ID,
                "toolName": "Bash",
                "input": '{"command":"rm -rf build"}',
                "toolUseId": "toolu_1",
                **request,
            },
        },
        headers=NODE_AUTH,
    )
    assert response.status_code == 200, response.text


def _poll(client: TestClient, session_id: str, request_id: str = REQUEST_ID):
    return client.get(
        f"/api/v1/daemon-nodes/sbx_alice/permission-requests/{request_id}",
        params={"sessionId": session_id},
        headers=NODE_AUTH,
    )


def _answer(client: TestClient, session_id: str, **body: object):
    return client.post(
        f"/api/v1/threads/{session_id}/permission-requests/{REQUEST_ID}", json=body,
    )


def test_a_prompt_waits_on_the_thread_until_a_person_allows_it(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)

        _ask(client, command)
        _ask(client, command)  # a retried post does not open a second prompt

        thread = client.get(f"/api/v1/threads/{session_id}").json()
        [prompt] = thread["permissionRequests"]
        assert prompt["id"] == REQUEST_ID
        assert prompt["toolName"] == "Bash"
        assert prompt["runId"] == command["runId"]
        assert prompt["input"] == '{"command":"rm -rf build"}'
        assert _poll(client, session_id).json() == {"status": "pending"}

        answered = _answer(client, session_id, decision="allow")
        assert answered.status_code == 200, answered.text
        assert not answered.json().get("permissionRequests")
        [decision] = answered.json()["permissionDecisions"]
        assert decision["decision"] == "allow"
        assert decision["decidedBy"]
        assert _poll(client, session_id).json() == {"status": "allow"}

        assert _answer(client, session_id, decision="deny").status_code == 409
        assert _poll(client, session_id).json() == {"status": "allow"}


def test_a_denial_carries_the_persons_note_to_the_daemon(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        _ask(client, _dispatched_run(app, session_id))

        assert _answer(client, session_id, decision="maybe").status_code == 400
        response = _answer(
            client, session_id, decision="deny", note="Use a scratch directory instead.",
        )
        assert response.status_code == 200
        assert _poll(client, session_id).json() == {
            "status": "deny", "note": "Use a scratch directory instead.",
        }


def test_a_prompt_expires_when_its_run_ends_first(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command)

        app.state.session_store.append_event(session_id, relay_event(
            "agent.completed", session_id, {
                "runId": command["runId"], "agent": "claude", "status": "cancelled",
                "exitCode": 130, "agentLog": "",
            },
        ))

        thread = client.get(f"/api/v1/threads/{session_id}").json()
        assert not thread.get("permissionRequests")
        assert _poll(client, session_id).json() == {"status": "expired"}
        assert _answer(client, session_id, decision="allow").status_code == 409


def test_only_the_asking_computer_may_poll_and_the_node_token_cannot_answer(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        _ask(client, _dispatched_run(app, session_id))
        app.state.registry.register({
            "sandboxId": "sbx_bob", "userId": "bob", "token": "bob_token",
            "protocolVersion": 1, "supportedAgents": ["claude"], "status": "ready",
        })

        foreign = client.get(
            f"/api/v1/daemon-nodes/sbx_bob/permission-requests/{REQUEST_ID}",
            params={"sessionId": session_id},
            headers={"Authorization": "Bearer bob_token"},
        )
        assert foreign.status_code == 404
        wrong_token = client.get(
            f"/api/v1/daemon-nodes/sbx_alice/permission-requests/{REQUEST_ID}",
            params={"sessionId": session_id},
            headers={"Authorization": "Bearer bob_token"},
        )
        assert wrong_token.status_code == 401
        assert _poll(client, session_id, "perm_ffffffffffffffff").status_code == 404

        anonymous = TestClient(app)
        answered = anonymous.post(
            f"/api/v1/threads/{session_id}/permission-requests/{REQUEST_ID}",
            json={"decision": "allow"},
            headers=NODE_AUTH,
        )
        assert answered.status_code in (401, 403)
        assert _poll(client, session_id).json() == {"status": "pending"}


def test_a_malformed_prompt_is_refused(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        response = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.permission_requested",
                "commandId": command["id"],
                "sessionId": session_id,
                "runId": command["runId"],
                "agent": "claude",
                "request": {"id": "../etc", "toolName": "Bash", "input": "{}"},
            },
            headers=NODE_AUTH,
        )
        assert response.status_code == 400
