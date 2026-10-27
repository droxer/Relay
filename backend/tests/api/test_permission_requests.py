"""A live run's permission prompt reaches a person, and their answer reaches the run.

The daemon reports a prompt as `run.permission_requested` and polls for the
answer; only a person (never the node token) answers it, and a prompt whose
run ends first closes as expired so the daemon stops waiting.
"""
from __future__ import annotations

from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from relay.app import create_app
from relay.core.ids import new_database_id
from relay.persistence.events import relay_event
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


QUESTIONS = [
    {"id": "db", "text": "Which database?", "options": [{"label": "Postgres", "description": "shared"}, {"label": "SQLite"}]},
    {"id": "name", "text": "Service name?", "options": [], "multiSelect": True},
]


def test_a_question_prompt_carries_the_persons_answers_to_the_daemon(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command, toolName="AskUserQuestion", questions=QUESTIONS)

        [prompt] = client.get(f"/api/v1/threads/{session_id}").json()["permissionRequests"]
        assert prompt["questions"] == QUESTIONS

        # Every question needs an answer, one each unless it allows several.
        assert _answer(client, session_id, decision="allow").status_code == 400
        assert _answer(client, session_id, decision="allow", answers={"db": ["SQLite"]}).status_code == 400
        assert _answer(
            client, session_id, decision="allow", answers={"db": ["SQLite", "Postgres"], "name": ["relay"]},
        ).status_code == 400
        answered = _answer(
            client, session_id, decision="allow", answers={"db": "SQLite", "name": ["relay", " api "]},
        )
        assert answered.status_code == 200, answered.text
        [decision] = answered.json()["permissionDecisions"]
        assert decision["answers"] == {"db": ["SQLite"], "name": ["relay", "api"]}
        assert _poll(client, session_id).json() == {
            "status": "allow", "answers": {"db": ["SQLite"], "name": ["relay", "api"]},
        }


def test_a_skipped_question_and_a_plain_prompt_take_no_answers(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command, toolName="AskUserQuestion", questions=QUESTIONS)
        assert _answer(client, session_id, decision="deny").status_code == 200
        assert _poll(client, session_id).json() == {"status": "deny"}


def test_a_plain_prompt_ignores_answers(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        _ask(client, _dispatched_run(app, session_id))
        allowed = _answer(client, session_id, decision="allow", answers={"db": ["x"]})
        assert allowed.status_code == 200
        assert "answers" not in allowed.json()["permissionDecisions"][0]


def test_the_daemon_may_withdraw_its_own_prompt(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command)

        withdraw = {
            "type": "run.permission_withdrawn",
            "commandId": command["id"],
            "sessionId": session_id,
            "runId": command["runId"],
            "agent": "claude",
            "requestId": REQUEST_ID,
            "reason": "No one answered within 30 minutes.",
        }
        response = client.post("/api/v1/daemon-nodes/sbx_alice/events", json=withdraw, headers=NODE_AUTH)
        assert response.status_code == 200, response.text
        thread = client.get(f"/api/v1/threads/{session_id}").json()
        assert not thread.get("permissionRequests")
        [decision] = thread["permissionDecisions"]
        assert decision["decision"] == "expired"
        assert decision["note"] == "No one answered within 30 minutes."
        assert "decidedBy" not in decision
        assert _poll(client, session_id).json() == {
            "status": "expired", "note": "No one answered within 30 minutes.",
        }
        # Withdrawing again, or an unknown prompt, changes nothing.
        assert client.post("/api/v1/daemon-nodes/sbx_alice/events", json=withdraw, headers=NODE_AUTH).status_code == 200
        assert len(client.get(f"/api/v1/threads/{session_id}").json()["permissionDecisions"]) == 1
        malformed = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events", json={**withdraw, "requestId": "nope"}, headers=NODE_AUTH,
        )
        assert malformed.status_code == 400


def test_a_prompt_notifies_the_threads_owner_once(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command)
        _ask(client, command)  # the retried post is not news

        inbox = client.get("/api/v1/notifications").json()
        prompts = [item for item in inbox["notifications"] if item["kind"] == "permission_requested"]
        assert len(prompts) == 1
        assert prompts[0]["data"]["sessionId"] == session_id
        assert prompts[0]["data"]["requestId"] == REQUEST_ID
        assert prompts[0]["data"]["toolName"] == "Bash"
        assert prompts[0]["data"]["question"] is False
        assert "permission_requested" in client.get("/api/v1/notifications/preferences").json()["kinds"]


def _thread(client: TestClient, session_id: str) -> dict:
    return client.get(f"/api/v1/threads/{session_id}").json()


def _prompt_notices(client: TestClient) -> list[dict]:
    inbox = client.get("/api/v1/notifications").json()
    return [item for item in inbox["notifications"] if item["kind"] == "permission_requested"]


def test_always_allow_answers_later_prompts_for_that_tool_in_the_thread(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command)

        answered = _answer(client, session_id, decision="allow", always=True)
        assert answered.status_code == 200, answered.text
        [decision] = answered.json()["permissionDecisions"]
        assert decision["decision"] == "allow"
        assert decision["always"] is True
        assert _poll(client, session_id).json() == {"status": "allow"}

        later = "perm_fedcba9876543210"
        _ask(client, command, id=later)
        thread = _thread(client, session_id)
        assert not thread.get("permissionRequests")
        assert _poll(client, session_id, later).json() == {"status": "allow"}
        session = app.state.session_store.get_session(session_id)
        granted = session["permissionDecisions"][-1]
        assert granted["requestId"] == later
        assert granted["grant"] is True
        assert "decidedBy" not in granted
        assert session["permissionGrants"] == [
            {"agent": "claude", "toolName": "Bash", "grantedAt": decision["resolvedAt"], "grantedBy": decision["decidedBy"]},
        ]
        # Answered in advance, so the person is not called for it.
        assert [item["data"]["requestId"] for item in _prompt_notices(client)] == [REQUEST_ID]


def test_always_allow_retries_a_failed_automatic_resolution(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app, raise_server_exceptions=False)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command)
        assert _answer(client, session_id, decision="allow", always=True).status_code == 200

        later = "perm_fedcba9876543210"
        append_event = app.state.session_store.append_event

        def fail_resolution(session_id, event, **kwargs):
            if event["type"] == "agent.permission_resolved":
                raise RuntimeError("interrupted automatic approval write")
            return append_event(session_id, event, **kwargs)

        with monkeypatch.context() as failure:
            failure.setattr(app.state.session_store, "append_event", fail_resolution)
            response = client.post(
                "/api/v1/daemon-nodes/sbx_alice/events",
                json={
                    "type": "run.permission_requested",
                    "commandId": command["id"],
                    "sessionId": session_id,
                    "runId": command["runId"],
                    "agent": "claude",
                    "request": {
                        "id": later, "toolName": "Bash", "input": "{}", "toolUseId": "toolu_1",
                    },
                },
                headers=NODE_AUTH,
            )
        assert response.status_code == 500
        assert _poll(client, session_id, later).json() == {"status": "pending"}

        _ask(client, command, id=later, input="{}")
        assert _poll(client, session_id, later).json() == {"status": "allow"}
        # A further delivery stays closed and produces no additional decision.
        _ask(client, command, id=later, input="{}")
        thread = _thread(client, session_id)
        assert not thread.get("permissionRequests")
        decisions = [item for item in thread["permissionDecisions"] if item["requestId"] == later]
        assert len(decisions) == 1
        assert decisions[0]["grant"] is True
        assert [item["data"]["requestId"] for item in _prompt_notices(client)] == [REQUEST_ID]


def test_always_allow_covers_only_its_tool(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command)
        assert _answer(client, session_id, decision="allow", always=True).status_code == 200

        other = "perm_00000000aaaaaaaa"
        _ask(client, command, id=other, toolName="Write", input='{"file_path":"a.txt"}')
        [prompt] = _thread(client, session_id)["permissionRequests"]
        assert prompt["id"] == other
        assert _poll(client, session_id, other).json() == {"status": "pending"}

        # A question is never answered in advance, even for a granted name.
        question = "perm_00000000bbbbbbbb"
        _ask(client, command, id=question, toolName="Bash", questions=QUESTIONS)
        assert _poll(client, session_id, question).json() == {"status": "pending"}


def test_always_is_only_an_allow_of_an_approval(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        _ask(client, command, toolName="AskUserQuestion", questions=QUESTIONS)

        assert _answer(client, session_id, decision="deny", always=True).status_code == 400
        assert _answer(client, session_id, decision="allow", always="yes").status_code == 400
        refused = _answer(
            client, session_id, decision="allow", always=True,
            answers={"db": "SQLite", "name": ["relay"]},
        )
        assert refused.status_code == 400
        assert _poll(client, session_id).json() == {"status": "pending"}
        assert not app.state.session_store.get_session(session_id).get("permissionGrants")


def test_always_allow_also_answers_the_same_tools_prompts_already_waiting(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        session_id = _create_session(client)
        command = _dispatched_run(app, session_id)
        waiting, other = "perm_1111111111111111", "perm_2222222222222222"
        _ask(client, command)
        _ask(client, command, id=waiting)
        _ask(client, command, id=other, toolName="Write")

        assert _answer(client, session_id, decision="allow", always=True).status_code == 200
        assert _poll(client, session_id, waiting).json() == {"status": "allow"}
        assert _poll(client, session_id, other).json() == {"status": "pending"}
        assert [item["id"] for item in _thread(client, session_id)["permissionRequests"]] == [other]
