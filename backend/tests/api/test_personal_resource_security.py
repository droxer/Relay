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
        })
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
