"""Public connection routes authenticate, scope grants, and keep secrets private."""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.fernet import Fernet

from relay.connections import providers
from test_github_issue_import import context as context


@pytest.fixture(autouse=True)
def configuration(monkeypatch):
    monkeypatch.setenv("RELAY_CONNECTIONS_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CLIENT_ID", "client")
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CALLBACK_URL", "https://relay.example/api/v1/connections/callback/github")

    def handler(request):
        if request.url.path.endswith("access_token"):
            return httpx.Response(200, json={"access_token": "secret-token", "scope": "read:user,repo"})
        if request.url.path == "/user":
            return httpx.Response(200, json={"id": 17, "login": "octocat"})
        if request.url.path == "/user/repos":
            return httpx.Response(200, json=[{"id": 42, "full_name": "octo/hello"}])
        raise AssertionError(str(request.url))

    monkeypatch.setattr(providers, "transport", httpx.MockTransport(handler))


def _connect(client):
    response = client.post("/api/v1/connections/authorizations", json={"provider": "github", "returnTo": "/settings/connections"})
    assert response.status_code == 200, response.text
    state = parse_qs(urlsplit(response.json()["url"]).query)["state"][0]
    callback = client.get("/api/v1/connections/callback/github", params={"state": state, "code": "code"}, follow_redirects=False)
    assert callback.status_code == 303, callback.text
    assert callback.headers["location"] == "/settings/connections"
    return client.get("/api/v1/connections").json()["connections"][0]


def test_connect_resources_grants_and_disconnect(context):
    _app, client, _project = context
    connection = _connect(client)
    assert "secret-token" not in str(connection)
    resources = client.get(f"/api/v1/connections/{connection['id']}/resources")
    assert resources.json()["resources"][0]["id"] == "octo/hello"
    task = client.post("/api/v1/tasks", json={"title": "Read issues"}).json()
    path = f"/api/v1/connection-grants/task/{task['id']}"
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    saved = client.put(path, json={"grants": [grant]})
    assert saved.status_code == 200, saved.text
    assert client.get(path).json()["grants"][0]["connectionId"] == connection["id"]
    assert client.get(f"/api/v1/connections/{connection['id']}/usage").json()["usage"][0]["targetId"] == task["id"]
    assert client.delete(f"/api/v1/connections/{connection['id']}").status_code == 200
    assert client.get("/api/v1/connections").json()["connections"] == []


def test_routes_require_session(context):
    _app, client, _project = context
    client.cookies.clear()
    for path in ("connection-providers", "connections", "connections/x/resources", "connection-grants/task/x"):
        assert client.get(f"/api/v1/{path}").status_code == 401
    assert client.post("/api/v1/connections/authorizations", json={"provider": "github"}).status_code == 401


def test_grants_require_real_owned_targets(context):
    _app, client, _project = context
    assert client.put("/api/v1/connection-grants/task/missing", json={"grants": []}).status_code == 404
    assert client.put("/api/v1/connection-grants/computer/missing", json={"grants": []}).status_code == 400


def test_catalog_advertises_only_configured_providers(context):
    _app, client, _project = context
    response = client.get("/api/v1/connection-providers")
    assert response.status_code == 200
    assert {p["id"]: p["configured"] for p in response.json()["providers"]} == {
        "github": True, "slack": False, "google-drive": False}


def test_automation_occurrence_snapshots_grants_and_cannot_expand_them(context):
    app, client, project = context
    connection = _connect(client)
    routine_response = client.post("/api/v1/tasks", json={"title": "Weekly issues", "projectId": project["id"],
        "isRoutine": True, "routineState": "active", "routineTriggers": []})
    assert routine_response.status_code == 201, routine_response.text
    routine = routine_response.json()
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    path = f"/api/v1/connection-grants/automation/{routine['id']}"
    assert client.put(path, json={"grants": [grant]}).status_code == 200
    occurrence = app.state.task_store.create_triggered_occurrence(routine["id"], run_date="2026-11-06",
        trigger_kind="manual", depth=0, context="Run now")
    assert occurrence
    grants_path = f"/api/v1/connection-grants/task/{occurrence['id']}"
    response = client.get(grants_path)
    assert len(response.json()["grants"]) == 1
    assert response.json()["readOnly"] is True
    assert client.put(grants_path, json={"grants": []}).status_code == 409
    assert client.delete(f"/api/v1/connections/{connection['id']}").status_code == 200
    assert app.state.task_store.get_task(routine["id"])["routinePauseReason"] == "connection_unavailable"
