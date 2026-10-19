from __future__ import annotations

import base64

from fastapi.testclient import TestClient
from relay.app import create_app


def _bootstrap(client: TestClient) -> None:
    assert client.post("/api/v1/auth/bootstrap", json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"}).status_code == 200


def _register_node(app, *, capabilities: list[str]) -> None:
    app.state.registry.register({
        "sandboxId": "node_1",
        "userId": "alice",
        "token": "node_token",
        "protocolVersion": 1,
        "supportedAgents": ["codex"],
        "capabilities": capabilities,
        "status": "ready",
    })


def test_admin_browses_node_shared_workspace(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap(client)
    _register_node(app, capabilities=["workspace-read-shared"])

    async def dispatch(_ctx, node, command):
        assert node["id"] == "node_1"
        assert "agentId" not in command
        if command["type"] == "workspace.list":
            return {"type": "workspace.listing", "path": "", "exists": True, "entries": [{"name": "shared.md", "path": "shared.md", "kind": "file", "bytes": 5, "updatedAt": "2026-07-19T00:00:00Z"}]}
        return {"type": "workspace.file", "path": "shared.md", "bytes": 5, "isBinary": False, "truncated": False, "contentBase64": "aGVsbG8="}

    monkeypatch.setattr(
        "relay.api.computers.node_workspace.dispatch_workspace_command", dispatch
    )
    listing = client.get("/api/v1/admin/daemon-nodes/node_1/workspace/files")
    assert listing.status_code == 200, listing.text
    assert listing.json()["nodeId"] == "node_1"
    assert listing.json()["scope"] == "shared"
    assert listing.json()["entries"][0]["name"] == "shared.md"

    file = client.get("/api/v1/admin/daemon-nodes/node_1/workspace/file?path=shared.md")
    assert file.status_code == 200
    assert file.json()["content"] == "hello"
    assert file.json()["contentBase64"] is None


def test_node_workspace_file_passes_binary_bytes_through(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap(client)
    _register_node(app, capabilities=["workspace-read-shared"])
    png = b"\x89PNG\r\n\x1a\n" + bytes(8)

    async def dispatch(_ctx, _node, _command):
        return {"type": "workspace.file", "path": "logo.png", "bytes": len(png), "isBinary": True, "truncated": False, "contentBase64": base64.b64encode(png).decode()}

    monkeypatch.setattr(
        "relay.api.computers.node_workspace.dispatch_workspace_command", dispatch
    )
    file = client.get("/api/v1/admin/daemon-nodes/node_1/workspace/file?path=logo.png")
    assert file.status_code == 200, file.text
    body = file.json()
    assert body["isBinary"] is True
    assert body["content"] is None
    assert base64.b64decode(body["contentBase64"]) == png


def test_node_workspace_requires_admin(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    admin = TestClient(app)
    _bootstrap(admin)
    _register_node(app, capabilities=["workspace-read-shared"])
    assert admin.post("/api/v1/admin/accounts", json={"username": "bob", "password": "userpass", "userId": "bob"}).status_code == 201
    bob = TestClient(app)
    assert bob.post("/api/v1/auth/login", json={"username": "bob", "password": "userpass"}).status_code == 200
    assert bob.get("/api/v1/admin/daemon-nodes/node_1/workspace/files").status_code == 403


def test_node_workspace_unavailable_without_shared_capability(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap(client)
    _register_node(app, capabilities=[])

    response = client.get("/api/v1/admin/daemon-nodes/node_1/workspace/files")
    assert response.status_code == 503
    assert response.json()["detail"] == {"reason": "placement-unavailable"}
    assert client.get("/api/v1/admin/daemon-nodes/missing/workspace/files").status_code == 404
    assert client.get("/api/v1/admin/daemon-nodes/node_1/workspace/file?path=../x").status_code == 400
