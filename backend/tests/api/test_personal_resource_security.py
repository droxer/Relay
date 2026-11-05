from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.sessions.controller import SessionController
from test_auth import _add_workspace_file_artifact
from test_tasks import _bootstrap_admin, _create_account, _login
from user_ids import user_id


@pytest.fixture
def personal_resources(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap_admin(client)
    admin_id = client.get("/api/v1/auth/me").json()["user"]["userId"]
    _create_account(client, "alice", user_id="alice")
    identities = {"admin": admin_id, "alice": user_id("alice")}
    sessions = {}
    for name, owner in identities.items():
        session = SessionController(app.state.session_store, owner_user_id=owner).create_session(
            f"{name}'s private thread", ["human"],
        )
        sessions[name] = session["id"]
        _add_workspace_file_artifact(app, session["id"], f"{name}.txt", f"/workspace/{name}/{name}.txt")
        app.state.registry.register({
            "sandboxId": f"node_{name}", "userId": owner, "token": f"token_{name}",
            "workspaceId": f"machine_{name}", "workspacePath": f"/workspace/{name}",
            "nodeLocation": "user-device", "protocolVersion": 1,
            "supportedAgents": ["codex"], "capabilities": ["workspace-read-shared"],
            "status": "ready",
        }, ui_token=f"ui_{name}", authorized_node_location="user-device")
    return client, app, identities, sessions


@pytest.mark.parametrize("username", ["admin", "alice"])
@pytest.mark.parametrize("path,key", [
    ("/threads", "sessions"), ("/threads?view=summary", "sessions"),
    ("/artifacts", "artifacts"), ("/daemon-nodes", "nodes"), ("/sandboxes", "sandboxes"),
])
def test_personal_collections_never_include_other_users(personal_resources, username, path, key):
    client, _app, identities, sessions = personal_resources
    _login(client, username, "kestrel-vault-7719" if username == "admin" else "userpass")
    response = client.get(f"/api/v1{path}")
    assert response.status_code == 200, response.text
    rows = response.json()[key]
    assert rows
    if key == "artifacts":
        assert {row["sessionId"] for row in rows} == {sessions[username]}
    elif key == "sessions":
        assert {row["id"] for row in rows} == {sessions[username]}
    else:
        assert {row["userId"] for row in rows} == {identities[username]}


@pytest.mark.parametrize("suffix", ["files", "file?path=private.txt"])
def test_admin_cannot_browse_someone_elses_personal_computer(personal_resources, monkeypatch, suffix):
    client, _app, _identities, _sessions = personal_resources

    async def dispatch(*_args):
        pytest.fail("A private Computer must be refused before dispatching a file read")

    monkeypatch.setattr("relay.api.computers.node_workspace.dispatch_workspace_command", dispatch)
    response = client.get(f"/api/v1/admin/daemon-nodes/node_alice/workspace/{suffix}")
    assert response.status_code == 403, response.text


@pytest.mark.parametrize("operation", ["read", "run", "provision"])
def test_admin_cannot_use_legacy_sandbox_routes_to_control_a_personal_computer(personal_resources, monkeypatch, operation):
    client, _app, identities, _sessions = personal_resources

    def resolve(*_args):
        pytest.fail("A private Computer must be refused before resolving an agent")

    monkeypatch.setattr("relay.api.computers.sandboxes._resolve_legacy_assignment", resolve)
    if operation == "read":
        response = client.get("/api/v1/sandboxes/node_alice")
    elif operation == "run":
        response = client.post("/api/v1/sandboxes/node_alice/runs", json={
            "taskGoal": "Do not dispatch", "assignments": [{"agent": "codex"}],
        })
    else:
        response = client.post("/api/v1/sandboxes", json={
            "sandboxId": "node_alice", "userId": identities["alice"],
        })
    assert response.status_code == 403, response.text


@pytest.mark.parametrize("bearer", ["token_alice", "attacker_ui_token"])
def test_daemon_registration_cannot_mint_a_human_credential(personal_resources, bearer):
    _client, app, identities, sessions = personal_resources
    daemon = TestClient(app)
    registered = daemon.post("/api/v1/daemon-node-registrations", json={
        "sandboxId": "node_alice", "userId": identities["alice"], "token": "token_alice",
        "protocolVersion": 1, "supportedAgents": ["codex"], "status": "ready",
        "workspaceId": "machine_alice", "workspacePath": "/workspace/alice",
    }, headers={"Authorization": f"Bearer {bearer}"})
    assert registered.status_code == 200, registered.text
    response = daemon.get(f"/api/v1/threads/{sessions['alice']}", headers={"Authorization": f"Bearer {bearer}"})
    assert response.status_code == 401, response.text


@pytest.mark.parametrize("path,key", [("/daemon-nodes", "nodes"), ("/sandboxes", "sandboxes")])
def test_cookie_identity_cannot_be_overridden_by_another_users_stored_token(personal_resources, path, key):
    client, _app, identities, _sessions = personal_resources
    response = client.get(f"/api/v1{path}", headers={"Authorization": "Bearer ui_alice"})
    assert response.status_code == 200, response.text
    assert {row["userId"] for row in response.json()[key]} == {identities["admin"]}


def test_foreign_ui_token_does_not_override_a_signed_in_person(personal_resources):
    client, app, _identities, _sessions = personal_resources
    path = "/api/v1/sandboxes/node_alice"
    assert client.get(path, headers={"Authorization": "Bearer ui_alice"}).status_code == 403
    # A token-only legacy browser still acts as its own user when no cookie
    # supplies a different authenticated identity.
    assert TestClient(app).get(path, headers={"Authorization": "Bearer ui_alice"}).status_code == 200


def test_legacy_sandbox_without_credentials_is_not_public(personal_resources):
    _client, app, _identities, _sessions = personal_resources
    app.state.registry.register({
        "sandboxId": "legacy_unconfigured", "token": "", "protocolVersion": 1,
        "supportedAgents": ["codex"], "status": "ready",
    })
    assert TestClient(app).get("/api/v1/sandboxes/legacy_unconfigured").status_code == 401


def test_legacy_shared_node_and_ui_secret_never_grants_human_authority(personal_resources):
    _client, app, identities, sessions = personal_resources
    app.state.registry.register({
        "sandboxId": "node_alice", "userId": identities["alice"], "token": "token_alice",
        "protocolVersion": 1, "supportedAgents": ["codex"], "status": "ready",
        "workspaceId": "machine_alice", "workspacePath": "/workspace/alice",
    }, ui_token="token_alice")
    response = TestClient(app).get(f"/api/v1/threads/{sessions['alice']}", headers={"Authorization": "Bearer token_alice"})
    assert response.status_code == 401, response.text
