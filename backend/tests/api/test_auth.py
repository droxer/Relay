from __future__ import annotations

from automation_helpers import WEEKLY_TRIGGERS

import uuid
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from sqlalchemy import delete as sa_delete, select, update as sa_update
from relay.app import create_app
from relay.persistence.daemon.store import DatabaseDaemonStore
from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.task.store import DatabaseTaskStore
from relay.persistence.events import relay_event
from relay.security.auth import DatabaseAccountAuthStore
from user_ids import user_id


def _bootstrap_admin(client: TestClient, token: str = "admin_token") -> None:
    response = client.post("/api/v1/auth/bootstrap", json={
        "token": token,
        "username": "admin",
        "password": "kestrel-vault-7719",
    })
    assert response.status_code == 200


def _login(client: TestClient, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={
        "username": username,
        "password": password,
    })
    assert response.status_code == 200


def _create_account(client: TestClient, username: str, *, user_id: str | None = None) -> None:
    response = client.post("/api/v1/admin/accounts", json={
        "username": username,
        "password": "userpass",
        "role": "user",
        **({"userId": user_id} if user_id else {}),
    })
    assert response.status_code == 201


def _add_workspace_file_artifact(app, session_id: str, title: str, path: str) -> None:
    artifact = {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, path)),
        "kind": "workspace_file",
        "title": title,
        "path": path,
        "createdAt": "2026-06-30T00:00:00.000Z",
        "bytes": 128,
        "contentType": "application/octet-stream",
        "workspaceRelativePath": Path(path).name,
    }
    app.state.session_store.append_event(session_id, relay_event("artifact.created", session_id, {"artifact": artifact}))


def _assert_no_secret_fields(value: object) -> None:
    if isinstance(value, dict):
        forbidden = {"passwordHash", "token", "sandboxToken", "nodeToken", "sessionToken"}
        assert forbidden.isdisjoint(value.keys())
        for child in value.values():
            _assert_no_secret_fields(child)
    elif isinstance(value, list):
        for child in value:
            _assert_no_secret_fields(child)


def test_control_panel_requires_admin_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 401
        assert response.json()["detail"] == "Authentication required."


def test_bootstrap_creates_first_admin(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "admin_token",
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 200
        body = response.json()
        assert body["user"]["username"] == "admin"
        assert body["user"]["role"] == "admin"
        assert "passwordHash" not in body["user"]
        assert "token" not in body["user"]


def test_bootstrap_requires_bootstrap_token(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "wrong",
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 401


def test_bootstrap_only_once(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "admin_token",
            "username": "admin2",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 409


def test_user_preferences_persist_across_login_sessions(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        response = client.patch("/api/v1/auth/preferences", json={
            "theme": "dark",
            "language": "zh-CN",
        })

        assert response.status_code == 200
        assert response.json()["user"]["theme"] == "dark"
        assert response.json()["user"]["language"] == "zh-CN"

        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "admin", "kestrel-vault-7719")
        current = client.get("/api/v1/auth/me")
        assert current.status_code == 200
        assert current.json()["user"]["theme"] == "dark"
        assert current.json()["user"]["language"] == "zh-CN"


def test_onboarding_preference_is_server_stamped_and_validated(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        assert client.get("/api/v1/auth/me").json()["user"]["onboarding"] == {}

        response = client.patch("/api/v1/auth/preferences", json={
            "onboarding": {"introSeen": True, "closedCards": ["teams"]},
        })

        assert response.status_code == 200
        onboarding = response.json()["user"]["onboarding"]
        assert onboarding["closedCards"] == ["teams"]
        assert onboarding["introSeenAt"]

        for body in ({"onboarding": "dismiss"}, {"onboarding": {"dismissedAt": "x"}}, {}):
            assert client.patch("/api/v1/auth/preferences", json=body).status_code == 400
        assert client.get("/api/v1/auth/me").json()["user"]["onboarding"] == onboarding


def test_home_snoozes_preference_round_trips_and_is_validated(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        assert client.get("/api/v1/auth/me").json()["user"]["homeSnoozes"] == []

        response = client.patch("/api/v1/auth/preferences", json={
            "homeSnoozes": {"snooze": [{"key": "task:t1", "stamp": "2026-10-31T10:00:00Z"}]},
        })

        assert response.status_code == 200
        snoozes = [{"key": "task:t1", "stamp": "2026-10-31T10:00:00Z"}]
        assert response.json()["user"]["homeSnoozes"] == snoozes
        for body in ({"homeSnoozes": []}, {"homeSnoozes": {"snooze": [{"key": "x"}]}}):
            assert client.patch("/api/v1/auth/preferences", json=body).status_code == 400
        assert client.get("/api/v1/auth/me").json()["user"]["homeSnoozes"] == snoozes

        cleared = client.patch("/api/v1/auth/preferences", json={"homeSnoozes": {"unsnooze": ["task:t1"]}})
        assert cleared.json()["user"]["homeSnoozes"] == []


def test_login_and_session_cookie(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        response = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 200
        assert "relay_session" in response.cookies

        response = client.get("/api/v1/auth/me")
        assert response.status_code == 200
        assert response.json()["authenticated"] is True
        assert response.json()["user"]["username"] == "admin"
        assert response.json()["user"]["role"] == "admin"

        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 200


def test_login_rejects_wrong_password(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        response = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "wrong",
        })
        assert response.status_code == 401


def test_logout_clears_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        response = client.post("/api/v1/auth/logout")
        assert response.status_code == 200

        response = client.get("/api/v1/auth/me")
        assert response.status_code == 401


def test_auth_status_reports_bootstrap_need(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.get("/api/v1/auth/status")
        assert response.status_code == 200
        assert response.json()["requiresBootstrap"] is True

        _bootstrap_admin(client)

        response = client.get("/api/v1/auth/status")
        assert response.status_code == 200
        assert response.json()["requiresBootstrap"] is False


def test_bootstrap_without_an_admin_token_is_unavailable(monkeypatch) -> None:
    monkeypatch.delenv("RELAY_ADMIN_TOKEN", raising=False)
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "anything",
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        # Nothing is generated: a token only its hash remembers would be lost.
        assert response.status_code == 503
        assert not (Path(root) / "auth" / "admin-token").exists()


def test_user_creation_validation_returns_client_errors(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        response = client.post("/api/v1/admin/accounts", json={
            "username": "alice",
            "password": "userpass",
            "role": "manager",
        })
        assert response.status_code == 400
        assert response.json()["detail"] == "role must be admin or user."

        response = client.post("/api/v1/admin/accounts", json={
            "username": " ",
            "password": "userpass",
            "role": "user",
        })
        assert response.status_code == 400
        assert response.json()["detail"] == "username is required."

        response = client.post("/api/v1/admin/accounts", json={
            "username": "alice",
            "password": "",
            "role": "user",
        })
        assert response.status_code == 400
        assert response.json()["detail"] == "password is required."


def test_duplicate_username_validation_normalizes_case_and_spacing(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        response = client.post("/api/v1/admin/accounts", json={
            "username": " Alice ",
            "password": "userpass",
            "role": "user",
        })
        assert response.status_code == 201
        assert response.json()["account"]["username"] == "alice"

        response = client.post("/api/v1/admin/accounts", json={
            "username": "ALICE",
            "password": "userpass",
            "role": "user",
        })
        assert response.status_code == 400
        assert response.json()["detail"] == "username already exists."


def test_bootstrap_validation_returns_client_errors(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "admin_token",
            "username": "",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 400
        assert response.json()["detail"] == "username is required."

        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "admin_token",
            "username": "admin",
            "password": "",
        })
        assert response.status_code == 400
        assert response.json()["detail"] == "password is required."


def test_regular_user_can_access_sessions_and_tasks_but_not_admin_panel(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        response = client.post("/api/v1/admin/accounts", json={
            "username": "alice",
            "password": "userpass",
            "role": "user",
        })
        assert response.status_code == 201
        assert response.json()["account"]["role"] == "user"

        # Use a fresh client so the admin session cookie is not reused.
        account_client = TestClient(create_app(root))
        _login(account_client, "alice", "userpass")

        response = account_client.get("/api/v1/auth/me")
        assert response.status_code == 200
        assert response.json()["user"]["role"] == "user"

        response = account_client.get("/api/v1/threads")
        assert response.status_code == 200
        response = account_client.get("/api/v1/tasks")
        assert response.status_code == 200

        response = account_client.get("/api/v1/admin/version")
        assert response.status_code == 403
        assert response.json()["detail"] == "Admin access required."

        response = account_client.get("/api/v1/admin/accounts")
        assert response.status_code == 403
        assert response.json()["detail"] == "Admin access required."

        response = account_client.get("/api/v1/admin/users")
        assert response.status_code == 403
        assert response.json()["detail"] == "Admin access required."

        response = account_client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 403
        assert response.json()["detail"] == "Admin access required."

        response = account_client.post("/api/v1/admin/accounts", json={
            "username": "bob",
            "password": "userpass",
            "role": "user",
        })
        assert response.status_code == 403

        response = account_client.post("/api/v1/admin/daemon-nodes", json={
            "userId": "alice",
            "workspacePath": "/workspace/alice",
        })
        assert response.status_code == 403

        response = account_client.post("/api/v1/admin/users", json={
            "userId": "alice-2",
            "username": "alice2",
            "password": "userpass",
            "nodeId": "sbx_unassigned",
        })
        assert response.status_code == 403


def test_unauthenticated_user_cannot_access_sessions_or_admin_panel(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        bootstrap_client = TestClient(create_app(root))
        _bootstrap_admin(bootstrap_client)

        # Use a fresh client so no session cookie is present.
        client = TestClient(create_app(root))

        response = client.get("/api/v1/threads")
        assert response.status_code == 401

        response = client.get("/api/v1/tasks")
        assert response.status_code == 401

        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 401

        response = client.post("/api/v1/admin/users", json={
            "userId": "alice",
            "username": "alice",
            "password": "userpass",
            "nodeId": "sbx_unassigned",
        })
        assert response.status_code == 401


def test_user_routes_are_scoped_to_authenticated_user(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login(admin_client, "admin", "kestrel-vault-7719")
        _create_account(admin_client, "alice", user_id="alice")
        _create_account(admin_client, "bob", user_id="bob")

        alice_client = TestClient(app)
        bob_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        _login(bob_client, "bob", "userpass")

        task_response = alice_client.post("/api/v1/tasks", json={
            "title": "Alice task",
            "ownerUserId": "bob",
            "isRoutine": True, "routineState": "paused", "createSession": True,
            "assignments": [{"agent": "claude"}],
        })
        assert task_response.status_code == 201
        task = task_response.json()
        assert task["ownerUserId"] == user_id("alice")
        session_id = task["linkedSessionIds"][0]
        session = alice_client.get(f"/api/v1/threads/{session_id}").json()
        assert session["ownerUserId"] == user_id("alice")

        assert bob_client.get("/api/v1/tasks").json()["tasks"] == []
        assert bob_client.get("/api/v1/threads").json()["sessions"] == []
        assert bob_client.get(f"/api/v1/tasks/{task['id']}").status_code == 403
        assert bob_client.patch(f"/api/v1/tasks/{task['id']}", json={"status": "done"}).status_code == 403
        assert bob_client.put(f"/api/v1/tasks/{task['id']}/assignment", json={"agent": "codex"}).status_code == 403
        assert bob_client.post(f"/api/v1/tasks/{task['id']}/pickups", json={"agent": "claude"}).status_code == 403
        assert bob_client.get(f"/api/v1/tasks/{task['id']}/events").status_code == 403
        assert bob_client.get(f"/api/v1/threads/{session_id}").status_code == 403
        assert bob_client.post(f"/api/v1/threads/{session_id}/assignments", json={"assignments": [{"agent": "pi"}]}).status_code == 403
        assert bob_client.post(f"/api/v1/threads/{session_id}/decisions", json={"kind": "approve"}).status_code == 403
        assert bob_client.post(f"/api/v1/threads/{session_id}/handoffs", json={"targetAgent": "codex"}).status_code == 403
        assert bob_client.get(f"/api/v1/threads/{session_id}/events").status_code == 403

        artifact_id = session["artifacts"][0]["id"]
        assert bob_client.get(f"/api/v1/threads/{session_id}/artifacts/{artifact_id}").status_code == 403

        bob_task_response = admin_client.post("/api/v1/tasks", json={
            "title": "Bob task",
            "ownerUserId": user_id("bob"),
        })
        assert bob_task_response.status_code == 201
        bob_task = bob_task_response.json()
        assert alice_client.post("/api/v1/threads", json={
            "taskGoal": "Try linking Bob's task",
            "taskId": bob_task["id"],
        }).status_code == 403


def test_artifact_index_is_scoped_to_authenticated_user(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login(admin_client, "admin", "kestrel-vault-7719")
        _create_account(admin_client, "alice", user_id="alice")
        _create_account(admin_client, "bob", user_id="bob")

        alice_client = TestClient(app)
        bob_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        _login(bob_client, "bob", "userpass")

        alice_first = alice_client.post("/api/v1/threads", json={
            "taskGoal": "Alice first",
            "workspacePath": "/workspace/alice",
            "assignments": [{"agent": "claude"}],
        })
        assert alice_first.status_code == 201
        alice_second = alice_client.post("/api/v1/threads", json={
            "taskGoal": "Alice second",
            "workspacePath": "/workspace/alice",
            "assignments": [{"agent": "codex"}],
        })
        assert alice_second.status_code == 201
        bob_session = bob_client.post("/api/v1/threads", json={
            "taskGoal": "Bob private",
            "workspacePath": "/workspace/bob",
            "assignments": [{"agent": "pi"}],
        })
        assert bob_session.status_code == 201
        _add_workspace_file_artifact(app, alice_first.json()["id"], "alice-first.pptx", "/workspace/alice/alice-first.pptx")
        _add_workspace_file_artifact(app, alice_second.json()["id"], "alice-second.pdf", "/workspace/alice/alice-second.pdf")
        _add_workspace_file_artifact(app, bob_session.json()["id"], "bob-report.xlsx", "/workspace/bob/bob-report.xlsx")

        alice_artifacts = alice_client.get("/api/v1/artifacts")
        assert alice_artifacts.status_code == 200
        alice_body = alice_artifacts.json()
        assert [artifact["ownerUserId"] for artifact in alice_body["artifacts"]] == [
            user_id("alice"),
            user_id("alice"),
        ]
        assert {artifact["sessionId"] for artifact in alice_body["artifacts"]} == {
            alice_first.json()["id"],
            alice_second.json()["id"],
        }

        assert alice_client.get(f"/api/v1/artifacts?userId={user_id('bob')}").status_code == 403

        admin_bob_artifacts = admin_client.get(f"/api/v1/artifacts?userId={user_id('bob')}")
        assert admin_bob_artifacts.status_code == 200
        assert [artifact["ownerUserId"] for artifact in admin_bob_artifacts.json()["artifacts"]] == [user_id("bob")]


def test_workspace_brief_summarizes_user_workspace(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login(admin_client, "admin", "kestrel-vault-7719")
        _create_account(admin_client, "alice", user_id="alice")
        _create_account(admin_client, "bob", user_id="bob")

        register = admin_client.post("/api/v1/daemon-node-registrations", json={
            "sandboxId": "sbx_alice",
            "userId": user_id("alice"),
            "token": "node_token",
            "workspacePath": "/workspace/alice",
            "protocolVersion": 1,
            "supportedAgents": ["claude", "codex"],
            "status": "ready",
        }, headers={"Authorization": "Bearer ui_token"})
        assert register.status_code == 200
        agent = app.state.agent_store.create_agent(
            user_id("alice"), {"displayName": "Auth Maintainer", "executorKind": "codex", "defaultRole": "implementer"}
        )

        alice_client = TestClient(app)
        bob_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        _login(bob_client, "bob", "userpass")

        session = alice_client.post("/api/v1/threads", json={
            "taskGoal": "Inspect auth flow",
            "workspacePath": "/workspace/alice",
            "assignments": [{"agent": "claude"}],
        })
        assert session.status_code == 201
        _add_workspace_file_artifact(app, session.json()["id"], "auth-flow.pptx", "/workspace/alice/auth-flow.pptx")
        task = alice_client.post("/api/v1/tasks", json={
            "title": "Patch auth",
            "status": "assigned",
            "assignedAgentId": agent["id"],
            "isRoutine": True,
            "routineState": "active",
            "routineTriggers": WEEKLY_TRIGGERS,
        })
        assert task.status_code == 201
        bob_session = bob_client.post("/api/v1/threads", json={
            "taskGoal": "Bob private",
            "workspacePath": "/workspace/bob",
            "assignments": [{"agent": "pi"}],
        })
        assert bob_session.status_code == 201

        def whole_history_read(*_args, **_kwargs):
            raise AssertionError("workspace brief loaded every thread or task history")

        monkeypatch.setattr(app.state.session_store, "list_sessions", whole_history_read)
        monkeypatch.setattr(app.state.task_store, "list_tasks", whole_history_read)
        brief_response = alice_client.get("/api/v1/workspace/brief")
        assert brief_response.status_code == 200
        brief = brief_response.json()
        assert brief["userId"] == user_id("alice")
        assert "workspacePath" not in brief
        assert "primaryNode" not in brief
        assert brief["nodes"][0]["id"] == "sbx_alice"
        assert "nodeToken" not in brief["nodes"][0]
        assert brief["metrics"]["nodeCount"] == 1
        assert brief["metrics"]["sessionCount"] == 1
        assert brief["metrics"]["taskCount"] == 1
        assert brief["metrics"]["artifactCount"] == 1
        assert brief["sessions"][0]["id"] == session.json()["id"]
        assert "events" not in brief["sessions"][0]
        assert brief["tasks"][0]["id"] == task.json()["id"]
        assert brief["tasks"][0]["routineTriggers"] == WEEKLY_TRIGGERS
        assert brief["tasks"][0]["routineState"] == "active"
        assert brief["tasks"][0]["routineNextRunAt"]
        assert "routineCadence" not in brief["tasks"][0]
        assert brief["artifacts"][0]["sessionId"] == session.json()["id"]

        assert alice_client.get(f"/api/v1/workspace/brief?userId={user_id('bob')}").status_code == 403

        admin_bob = admin_client.get(f"/api/v1/workspace/brief?userId={user_id('bob')}")
        assert admin_bob.status_code == 200
        assert admin_bob.json()["userId"] == user_id("bob")
        assert admin_bob.json()["metrics"]["sessionCount"] == 1


def test_workspace_brief_only_lists_generated_artifacts(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login(admin_client, "admin", "kestrel-vault-7719")
        _create_account(admin_client, "alice")

        alice_client = TestClient(app)
        _login(alice_client, "alice", "userpass")

        session = alice_client.post("/api/v1/threads", json={
            "taskGoal": "Run tests",
            "workspacePath": "/workspace/alice",
            "assignments": [{"agent": "claude"}],
        })
        assert session.status_code == 201
        session_id = session.json()["id"]

        app.state.session_store.create_artifact(session_id, {
            "kind": "command_log",
            "title": "Claude run log",
            "body": "● agent output",
            "extension": "txt",
        })
        app.state.session_store.create_artifact(session_id, {
            "kind": "diff",
            "title": "Auth patch",
            "body": "diff --git a/auth.ts",
            "extension": "diff",
        })
        _add_workspace_file_artifact(app, session_id, "test-results.pptx", "/workspace/alice/test-results.pptx")

        brief = alice_client.get("/api/v1/workspace/brief").json()
        assert brief["metrics"]["artifactCount"] == 1
        assert {artifact["kind"] for artifact in brief["artifacts"]} == {"workspace_file"}

        listed = alice_client.get("/api/v1/artifacts").json()["artifacts"]
        assert {artifact["kind"] for artifact in listed} == {"workspace_file"}


def test_user_workspace_file_routes_are_removed(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        workspace = Path(root) / "workspaces" / "alice"
        (workspace / "src").mkdir(parents=True)
        (workspace / "README.md").write_text("hello", encoding="utf-8")
        (workspace / "src" / "app.ts").write_text("export {};\n", encoding="utf-8")

        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login(admin_client, "admin", "kestrel-vault-7719")
        _create_account(admin_client, "alice")
        _create_account(admin_client, "bob")

        register = admin_client.post("/api/v1/daemon-node-registrations", json={
            "sandboxId": "sbx_alice",
            "userId": "alice",
            "token": "node_token",
            "workspacePath": str(workspace),
            "protocolVersion": 1,
            "supportedAgents": ["claude"],
            "status": "ready",
        }, headers={"Authorization": "Bearer ui_token"})
        assert register.status_code == 200

        alice_client = TestClient(app)
        bob_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        _login(bob_client, "bob", "userpass")

        assert "workspacePath" not in alice_client.get("/api/v1/workspace/brief").json()
        assert alice_client.get("/api/v1/workspace/files").status_code == 404
        assert alice_client.get("/api/v1/workspace/file", params={"path": "README.md"}).status_code == 404
        assert bob_client.get("/api/v1/workspace/files?userId=alice").status_code == 404


def test_admin_can_create_resources_for_specific_user(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        response = client.post("/api/v1/tasks", json={
            "title": "Bob task",
            "ownerUserId": "bob",
            "isRoutine": True, "routineState": "paused", "createSession": True,
        })

        assert response.status_code == 201
        task = response.json()
        assert task["ownerUserId"] == "bob"

        response = client.post("/api/v1/threads", json={
            "taskGoal": "Admin-linked session",
            "taskId": task["id"],
        })
        assert response.status_code == 201
        assert response.json()["ownerUserId"] == "bob"


def test_invalid_session_cookie_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        bootstrap_client = TestClient(create_app(root))
        _bootstrap_admin(bootstrap_client)

        client = TestClient(create_app(root))
        client.cookies.set("relay_session", "not-a-real-session")
        response = client.get("/api/v1/auth/me")

        assert response.status_code == 401
        assert response.json()["detail"] == "Session expired or invalid."


def test_expired_session_is_rejected_and_removed(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        auth_store = app.state.auth_store
        with auth_store.engine.begin() as conn:
            conn.execute(
                sa_update(auth_store.sessions).values(
                    expires_at=datetime(2000, 1, 1, tzinfo=UTC)
                )
            )

        response = client.get("/api/v1/auth/me")

        assert response.status_code == 401
        assert response.json()["detail"] == "Session expired or invalid."
        with auth_store.engine.begin() as conn:
            assert conn.execute(select(auth_store.sessions.c.id)).first() is None


def test_session_for_deleted_user_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        auth_store = app.state.auth_store
        with auth_store.engine.begin() as conn:
            conn.execute(sa_delete(auth_store.accounts))

        response = client.get("/api/v1/auth/me")

        assert response.status_code == 401
        assert response.json()["detail"] == "User not found."


def test_auth_responses_do_not_expose_secret_fields(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "admin_token",
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 200
        _assert_no_secret_fields(response.json())

        response = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 200
        _assert_no_secret_fields(response.json())

        response = client.get("/api/v1/auth/me")
        assert response.status_code == 200
        _assert_no_secret_fields(response.json())

        response = client.post("/api/v1/admin/accounts", json={
            "username": "alice",
            "password": "userpass",
            "role": "user",
        })
        assert response.status_code == 201
        _assert_no_secret_fields(response.json())

        response = client.get("/api/v1/admin/accounts")
        assert response.status_code == 200
        _assert_no_secret_fields(response.json())


def test_control_panel_node_list_exposes_node_token_for_admins(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        create = client.post("/api/v1/admin/daemon-nodes", json={
            "userId": "alice",
            "workspacePath": "/workspace/alice",
        })
        assert create.status_code == 201
        created_node_token = create.json()["nodeToken"]
        assert created_node_token.startswith("tok_")

        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 200
        nodes = response.json()["nodes"]
        assert len(nodes) == 1
        assert nodes[0].get("nodeToken") == created_node_token
        # Other secrets must still be hidden from the control-panel list.
        assert "token" not in nodes[0]
        assert "tokenHash" not in nodes[0]
        assert "uiTokenHash" not in nodes[0]
        assert "nodeTokenHash" not in nodes[0]


def test_authenticated_user_can_list_own_sandbox_and_daemon_node_without_token(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        response = client.post("/api/v1/admin/daemon-nodes", json={
            "userId": "alice",
            "workspacePath": "/workspace/alice",
        })
        assert response.status_code == 201
        response = client.post("/api/v1/admin/daemon-nodes", json={
            "userId": "bob",
            "workspacePath": "/workspace/bob",
        })
        assert response.status_code == 201

        response = client.get("/api/v1/sandboxes")
        assert response.status_code == 200
        assert {sandbox["userId"] for sandbox in response.json()["sandboxes"]} == {"alice", "bob"}
        _assert_no_secret_fields(response.json())

        response = client.get("/api/v1/daemon-nodes")
        assert response.status_code == 200
        assert {node["userId"] for node in response.json()["nodes"]} == {"alice", "bob"}
        _assert_no_secret_fields(response.json())


def test_unauthenticated_user_cannot_list_sandboxes_or_daemon_nodes(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        admin_client = TestClient(create_app(root))
        _bootstrap_admin(admin_client)
        _login(admin_client, "admin", "kestrel-vault-7719")

        response = admin_client.post("/api/v1/admin/daemon-nodes", json={
            "userId": "alice",
            "workspacePath": "/workspace/alice",
        })
        assert response.status_code == 201
        response = admin_client.post("/api/v1/admin/daemon-nodes", json={
            "userId": "bob",
            "workspacePath": "/workspace/bob",
        })
        assert response.status_code == 201

        # Use a fresh client with no session cookie.
        client = TestClient(create_app(root))

        response = client.get("/api/v1/sandboxes")
        assert response.status_code == 401

        response = client.get("/api/v1/daemon-nodes")
        assert response.status_code == 401

        # A stale bearer token must not fall back to an inventory disclosure.
        response = client.get("/api/v1/sandboxes", headers={"Authorization": "Bearer invalid-token"})
        assert response.status_code == 401

        response = client.get("/api/v1/daemon-nodes", headers={"Authorization": "Bearer invalid-token"})
        assert response.status_code == 401


def test_cross_site_request_cannot_mutate_cookie_authenticated_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        rejected = client.post(
            "/api/v1/auth/logout",
            headers={
                "Origin": "https://attacker.example",
                "Sec-Fetch-Site": "cross-site",
                # Forwarded headers are client-spoofable unless a trusted
                # proxy sanitizes them, so they must not bypass the guard.
                "X-Forwarded-Host": "attacker.example",
                "X-Forwarded-Proto": "https",
            },
        )

        assert rejected.status_code == 403
        assert client.get("/api/v1/auth/me").status_code == 200
        accepted = client.post(
            "/api/v1/auth/logout",
            headers={"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"},
        )
        assert accepted.status_code == 200


def test_same_origin_browser_mutation_survives_nextjs_proxy(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")

        response = client.post(
            "/api/v1/auth/logout",
            headers={
                # Next.js preserves the browser origin while proxying the
                # request to the backend's upstream Host.
                "Origin": "http://127.0.0.1:5000",
                "Sec-Fetch-Site": "same-origin",
                "X-Forwarded-Host": "127.0.0.1:5000",
                "X-Forwarded-Proto": "http",
            },
        )

        assert response.status_code == 200


def test_json_endpoints_reject_simple_cross_site_content_type(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.post(
            "/api/v1/auth/login",
            content='{"username":"admin","password":"kestrel-vault-7719"}',
            headers={"Content-Type": "text/plain"},
        )

        assert response.status_code == 415


def test_login_rate_limit_stops_repeated_password_checks(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_AUTH_RATE_LIMIT_ATTEMPTS", "3")
    monkeypatch.setenv("RELAY_AUTH_RATE_LIMIT_WINDOW_SECONDS", "60")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)

        for _ in range(3):
            response = client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "wrong-password"},
            )
            assert response.status_code == 401

        limited = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "wrong-password"},
        )
        assert limited.status_code == 429
        assert int(limited.headers["Retry-After"]) > 0


def test_backend_applies_browser_security_headers(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root), base_url="https://relay.example")

        response = client.get("/api")

        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
        assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
        assert response.headers["Strict-Transport-Security"].startswith("max-age=")
        assert response.headers["Cache-Control"] == "no-store"


def test_chat_service_token_can_act_as_user(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.post("/api/v1/threads", json={
            "taskGoal": "invoke from chat",
        }, headers={
            "Authorization": "Bearer chat_token",
            "X-Relay-User-Id": "alice",
        })
        assert response.status_code == 201
        assert response.json()["ownerUserId"] == "alice"

        allowed = client.get(f"/api/v1/threads/{response.json()['id']}", headers={
            "Authorization": "Bearer chat_token",
            "X-Relay-User-Id": "alice",
        })
        assert allowed.status_code == 200

        denied = client.get(f"/api/v1/threads/{response.json()['id']}", headers={
            "Authorization": "Bearer chat_token",
            "X-Relay-User-Id": "bob",
        })
        assert denied.status_code == 403


def test_chat_service_user_header_requires_configured_token(monkeypatch) -> None:
    monkeypatch.delenv("RELAY_CHAT_TOKEN", raising=False)
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.get("/api/v1/threads", headers={
            "Authorization": "Bearer wrong",
            "X-Relay-User-Id": "alice",
        })
        assert response.status_code == 503

        # The token is read once at startup, like every other setting.
        monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_token")
        client = TestClient(create_app(root))
        response = client.get("/api/v1/threads", headers={
            "Authorization": "Bearer wrong",
            "X-Relay-User-Id": "alice",
        })
        assert response.status_code == 401


def test_app_keeps_accounts_users_and_departments_in_the_database(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/auth.db"
        monkeypatch.setenv("RELAY_DATABASE_URL", database_url)
        DatabaseAccountAuthStore(database_url, create_schema=True)

        client = TestClient(create_app(root))
        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "admin_token",
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 200
        admin_user_id = response.json()["user"]["userId"]
        assert admin_user_id

        response = client.get("/api/v1/auth/me")
        assert response.status_code == 200
        assert response.json()["user"]["role"] == "admin"

        second_client = TestClient(create_app(root))
        response = second_client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 200

        response = second_client.get("/api/v1/admin/accounts")
        assert response.status_code == 200

        response = second_client.post("/api/v1/admin/departments", json={
            "departmentId": "engineering",
            "name": "Engineering",
        })
        assert response.status_code == 201
        engineering_id = response.json()["department"]["id"]
        assert engineering_id

        response = second_client.get("/api/v1/admin/departments")
        assert response.status_code == 200
        assert response.json()["departments"][0]["name"] == "Engineering"

        response = second_client.post("/api/v1/admin/accounts", json={
            "username": "eng-user",
            "password": "kestrel-vault-7719",
            "role": "user",
            "userId": "eng-user",
            "departmentId": engineering_id,
            "departmentName": "Engineering",
        })
        assert response.status_code == 201
        eng_user_id = response.json()["account"]["userId"]
        assert eng_user_id

        response = second_client.get("/api/v1/admin/users")
        assert response.status_code == 200
        assert response.json()["users"][0]["id"] == admin_user_id
        users_by_id = {user["id"]: user for user in response.json()["users"]}
        assert users_by_id[eng_user_id]["displayName"] == "eng-user"
        assert users_by_id[eng_user_id]["departmentId"] == engineering_id
        assert users_by_id[eng_user_id]["departmentName"] == "Engineering"

        response = second_client.post("/api/v1/admin/daemon-nodes", json={
            "userId": "alice",
            "workspacePath": "/workspace/alice",
        })
        assert response.status_code == 201

        response = second_client.get("/api/v1/admin/users")
        assert response.status_code == 200
        users = response.json()["users"]
        assert {admin_user_id, eng_user_id}.issubset({user["id"] for user in users})
        assert any(user["displayName"] == "alice" for user in users)


def test_backend_stores_share_the_configured_database(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/relay.db"
        monkeypatch.setenv("RELAY_DATABASE_URL", database_url)
        DatabaseSessionStore(database_url, create_schema=True)
        DatabaseTaskStore(database_url, create_schema=True)
        DatabaseDaemonStore(database_url, create_schema=True)
        DatabaseAccountAuthStore(database_url, create_schema=True)

        app = create_app(root)
        assert isinstance(app.state.session_store, DatabaseSessionStore)
        assert isinstance(app.state.task_store, DatabaseTaskStore)
        assert isinstance(app.state.registry.daemon_store, DatabaseDaemonStore)
        assert isinstance(app.state.auth_store, DatabaseAccountAuthStore)

        client = TestClient(app)
        _bootstrap_admin(client)
        response = client.post("/api/v1/tasks", json={
            "title": "Persist task in DB",
            "description": "Create a DB-backed session too.",
            "isRoutine": True, "routineState": "paused", "createSession": True,
            "workspacePath": "/workspace",
        })
        assert response.status_code == 201
        task = response.json()
        assert task["linkedSessionIds"]

        assert app.state.task_store.get_task(task["id"])["id"] == task["id"]
        assert app.state.session_store.get_session(task["linkedSessionIds"][0])["taskGoal"].startswith("Persist task in DB")

        response = client.post("/api/v1/daemon-node-registrations", json={
            "sandboxId": "sbx_unassigned",
            "token": "node_token",
            "workspacePath": "/workspace/unassigned",
            "protocolVersion": 1,
            "supportedAgents": ["claude"],
            "status": "ready",
        })
        assert response.status_code == 200
        assert "userId" not in app.state.registry.daemon_store.get_node("sbx_unassigned")

        response = client.post("/api/v1/admin/users", json={
            "userId": "db-user",
            "username": "db-user",
            "password": "kestrel-vault-7719",
            "nodeId": "sbx_unassigned",
        })
        assert response.status_code == 201
        user_id = response.json()["user"]["id"]
        assert app.state.registry.daemon_store.get_node("sbx_unassigned")["userId"] == user_id
