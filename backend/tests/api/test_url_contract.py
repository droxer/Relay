from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from relay.api.contract import API_PREFIX
from relay.app import create_app


def _client(monkeypatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    web_dist = tmp_path / "web-out"
    web_dist.mkdir()
    (web_dist / "index.html").write_text("<html>relay-spa</html>")
    monkeypatch.setenv("RELAY_WEB_UI_DIST_DIR", str(web_dist))
    return TestClient(create_app(tmp_path / "state"))


def _bootstrap(client: TestClient) -> None:
    response = client.post(
        f"{API_PREFIX}/auth/bootstrap",
        json={
            "token": "admin_token",
            "username": "admin",
            "password": "kestrel-vault-7719",
        },
    )
    assert response.status_code == 200


def test_openapi_publishes_only_the_canonical_json_contract(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("RELAY_CHANNELS_ENABLED", "1")
    client = _client(monkeypatch, tmp_path)
    schema = client.get("/api/openapi.json").json()
    paths = schema["paths"]

    assert "/api/v1/threads" in paths
    assert "/api/v1/admin/daemon-nodes" in paths
    assert "/api/v1/internal/chat/integrations/runtime" in paths
    assert "/profile-images/{kind}/{entity_id}" in paths
    assert "/sessions" not in paths
    assert "/cp/users" not in paths
    assert "/chat/identity/resolve" not in paths
    assert "/api/v1/tasks/claim-next" not in paths

    operations = [
        operation
        for path in paths.values()
        for method, operation in path.items()
        if method in {"get", "post", "put", "patch", "delete"}
    ]
    assert all(operation.get("tags") for operation in operations)
    operation_ids = [operation["operationId"] for operation in operations]
    assert len(operation_ids) == len(set(operation_ids))

    assert set(paths["/api/v1/threads/{session_id}"]) == {"get", "patch", "delete"}
    assert "204" in paths["/api/v1/threads/{session_id}"]["delete"]["responses"]
    assert set(paths["/api/v1/tasks/{task_id}/assignment"]) == {"put"}
    assert "202" in paths["/api/v1/tasks/{task_id}/pickups"]["post"]["responses"]
    assert set(paths["/api/v1/admin/daemon-nodes/{node_id}/assignment"]) == {
        "put",
        "delete",
    }
    assert (
        "200" in paths["/api/v1/daemon-nodes/{sandbox_id}/events"]["post"]["responses"]
    )
    assert "200" in paths["/api/v1/teams/{team_id}"]["delete"]["responses"]
    assert "200" in paths["/api/v1/admin/agents/{agent_id}"]["delete"]["responses"]
    assert "200" in paths["/api/v1/admin/agent-placements/{placement_id}"][
        "delete"
    ]["responses"]
    assert (
        "202" in paths["/api/v1/admin/managed-nodes/{node_id}"]["delete"]["responses"]
    )
    assert (
        "204"
        in paths["/api/v1/admin/managed-nodes/{node_id}/record"]["delete"]["responses"]
    )


def test_api_discovery_is_generated_from_version_constants(
    monkeypatch, tmp_path: Path
) -> None:
    response = _client(monkeypatch, tmp_path).get("/api")

    assert response.status_code == 200
    assert response.json() == {
        "name": "Relay backend",
        "version": "v1",
        "basePath": "/api/v1",
        "docsPath": "/api/docs",
        "openapiPath": "/api/openapi.json",
        "redocPath": "/api/redoc",
        "uiPath": "/admin",
        "webUiPath": "/",
    }


def test_unversioned_api_routes_are_not_mounted(monkeypatch, tmp_path: Path) -> None:
    client = _client(monkeypatch, tmp_path)

    for method, path in (
        ("GET", "/auth/status"),
        ("GET", "/sessions"),
        ("GET", "/cp"),
        ("POST", "/daemon-nodes/register"),
        ("POST", "/chat/conversation/sessions"),
    ):
        response = client.request(method, path)
        assert response.status_code == 404
        assert "deprecation" not in response.headers
        assert "link" not in response.headers


def test_thread_patch_replaces_title_and_archive_action_urls(
    monkeypatch, tmp_path: Path
) -> None:
    client = _client(monkeypatch, tmp_path)
    _bootstrap(client)
    created = client.post(f"{API_PREFIX}/threads", json={"taskGoal": "Ship it"})
    assert created.status_code == 201
    thread_id = created.json()["id"]

    renamed = client.patch(
        f"{API_PREFIX}/threads/{thread_id}", json={"title": "Canonical title"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Canonical title"

    archived = client.patch(
        f"{API_PREFIX}/threads/{thread_id}", json={"archived": True}
    )
    assert archived.status_code == 200
    assert archived.json()["archived"] is True


def test_spa_fallback_is_allowlisted_and_never_masks_api_typos(
    monkeypatch, tmp_path: Path
) -> None:
    client = _client(monkeypatch, tmp_path)

    direct_web_route = client.get("/threads/ses_123")
    assert direct_web_route.status_code == 200
    assert direct_web_route.text == "<html>relay-spa</html>"

    for path in (
        "/agents",
        "/agents/agent_123",
        "/computer",
        "/projects",
        "/projects/project_123",
        "/teams",
        "/teams/team_123",
    ):
        browser_route = client.get(path, headers={"accept": "text/html"})
        assert browser_route.status_code == 200
        assert browser_route.text == "<html>relay-spa</html>"
        assert "deprecation" not in browser_route.headers

    for path in (
        "/api/v1/missing",
        "/typoed-api/path",
        "/missing.js",
        "/threads/missing.js",
        "/agents/missing.js",
        "/admin/missing.css",
    ):
        response = client.get(path)
        assert response.status_code == 404
        assert response.headers["content-type"].startswith("application/json")
        assert response.json() == {"detail": "Not found."}
