"""Personal-computer credentials and limits apply on every HTTP surface."""
import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.daemon_registry.credentials import daemon_node_token_matches


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    app = create_app(tmp_path / "state")
    admin = TestClient(app)
    assert admin.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token", "username": "admin", "password": "kestrel-vault-7719",
    }).status_code == 200
    account = app.state.auth_store.create_account("alice", "kestrel-vault-7720", user_id="alice")
    owner = TestClient(app)
    assert owner.post("/api/v1/auth/login", json={
        "username": "alice", "password": "kestrel-vault-7720",
    }).status_code == 200
    return app, admin, owner, account["userId"]


def enroll(owner, path="/workspace/alice"):
    response = owner.post("/api/v1/daemon-node-enrollments/local", json={
        "workspacePath": path, "sandboxMode": "none",
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_admin_list_never_discloses_personal_computer_launch_token(accounts):
    _, admin, owner, _ = accounts
    enrolled = enroll(owner)
    node = next(node for node in admin.get("/api/v1/admin/daemon-nodes").json()["nodes"]
                if node["id"] == enrolled["node"]["id"])
    assert "nodeToken" not in node


def test_only_owner_can_rotate_personal_computer_credential(accounts):
    app, admin, owner, _ = accounts
    enrolled = enroll(owner)
    node_id, token = enrolled["node"]["id"], enrolled["nodeToken"]
    path = f"/api/v1/daemon-nodes/{node_id}/token/reissue"
    assert admin.post(path).status_code == 403
    assert daemon_node_token_matches(app.state.daemon_store.get_node(node_id), token)
    response = owner.post(path)
    assert response.status_code == 200
    assert daemon_node_token_matches(app.state.daemon_store.get_node(node_id), response.json()["nodeToken"])
    assert not daemon_node_token_matches(app.state.daemon_store.get_node(node_id), token)


def test_legacy_sandbox_creation_obeys_personal_computer_limit(accounts):
    app, _, owner, user_id = accounts
    app.state.org_settings_store.update_settings(max_local_computers_per_user=0)
    response = owner.post("/api/v1/sandboxes", headers={"Authorization": "Bearer chosen-ui-token"}, json={
        "userId": user_id, "sandboxId": "legacy_node", "workspacePath": "/workspace/legacy",
        "nodeToken": "chosen-node-token",
    })
    assert response.status_code == 409
    assert app.state.daemon_store.get_node("legacy_node") is None


def test_legacy_existing_sandbox_can_be_adopted_at_limit(accounts):
    app, _, owner, user_id = accounts
    enrolled = enroll(owner)
    app.state.org_settings_store.update_settings(max_local_computers_per_user=0)
    response = owner.post("/api/v1/sandboxes", json={
        "userId": user_id, "sandboxId": enrolled["node"]["id"],
    })
    assert response.status_code == 201
    assert response.json()["id"] == enrolled["node"]["id"]
