"""Connection-backed issue imports keep provider credentials owner-scoped."""

import httpx
import pytest
from relay.tasks import github_issues

from test_connections import _connect
from test_connections import configuration as configuration
from test_github_issue_import import ALICE
from test_github_issue_import import context as context
from test_github_issue_import import github as github


@pytest.fixture(autouse=True)
def chat_configuration(monkeypatch):
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat-service-token")


def test_private_preview_and_import_use_selected_connection(context, github):
    _app, client, project = context
    connection = _connect(client)
    github.visibility = "private"
    payload = {"repository": "octo/hello", "connectionId": connection["id"], "projectId": project["id"]}
    preview = client.post("/api/v1/tasks/github/issues", json=payload)
    assert preview.status_code == 200, preview.text
    assert [item["number"] for item in preview.json()["issues"]] == [1, 2]
    imported = client.post("/api/v1/tasks/github/import", json={**payload, "numbers": [1]})
    assert imported.status_code == 201, imported.text
    assert imported.json()["created"][0]["description"].startswith("Body of 1")
    assert all(request.headers.get("authorization") == "Bearer secret-token" for request in github.requests)
    assert "secret-token" not in preview.text + imported.text


@pytest.mark.parametrize("route", ["issues", "import"])
@pytest.mark.parametrize("failure", ["other_owner", "disconnected", "reconnect", "wrong_provider", "no_actions", "missing"])
def test_connection_access_is_checked_before_any_github_read(context, github, route, failure):
    app, client, _project = context
    connection = _connect(client)
    service = app.state.context.connections
    if failure == "other_owner":
        client.cookies.clear()
        client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    elif failure == "disconnected":
        client.delete(f"/api/v1/connections/{connection['id']}")
    elif failure in {"reconnect", "wrong_provider", "no_actions"}:
        record = service.store.get(ALICE, connection["id"])
        patch = {"status": "reconnect_required"} if failure == "reconnect" else (
            {"actions": []} if failure == "no_actions" else {"provider": "other"}
        )
        service.store.save(ALICE, {**record, **patch}, record["sealedSecret"])
    response = client.post(f"/api/v1/tasks/github/{route}", json={
        "repository": "octo/hello", "connectionId": "missing" if failure == "missing" else connection["id"], "numbers": [1],
    })
    assert response.status_code in (403, 404, 409), response.text
    assert github.requests == []


@pytest.mark.parametrize("route", ["issues", "import"])
@pytest.mark.parametrize("connection_id", [12, [], {}, "", " "])
def test_invalid_connection_ids_never_fall_back_to_anonymous(context, github, route, connection_id):
    _app, client, _project = context
    response = client.post(f"/api/v1/tasks/github/{route}", json={
        "repository": "octo/hello", "connectionId": connection_id, "numbers": [1],
    })
    assert response.status_code == 400
    assert github.requests == []


def test_connected_account_is_not_used_without_explicit_selection(context, github):
    _app, client, _project = context
    _connect(client)
    response = client.post("/api/v1/tasks/github/issues", json={"repository": "octo/hello"})
    assert response.status_code == 200
    assert all("authorization" not in request.headers for request in github.requests)


@pytest.mark.parametrize("route", ["issues", "import"])
@pytest.mark.parametrize("status", [401, 403, 404, 302])
def test_github_denial_or_redirect_never_reads_issues(context, github, monkeypatch, route, status):
    _app, client, _project = context
    connection = _connect(client)
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, json={}, headers={"Location": "https://elsewhere.example/"})

    monkeypatch.setattr(github_issues, "transport", httpx.MockTransport(handler))
    response = client.post(f"/api/v1/tasks/github/{route}", json={
        "repository": "octo/hello", "connectionId": connection["id"], "numbers": [1],
    })
    assert response.status_code == {401: 403, 403: 403, 404: 404, 302: 409}[status]
    assert len(requests) == 1
    assert requests[0].url.host == "api.github.com"
    assert requests[0].url.path == "/repos/octo/hello"


def test_expired_connection_refreshes_before_private_import(context, github):
    app, client, _project = context
    connection = _connect(client)
    service = app.state.context.connections
    record = service.store.get(ALICE, connection["id"])
    service.store.save(ALICE, record, service._seal({
        "access_token": "expired-secret", "refresh_token": "refresh-secret", "expiresAt": 0,
    }))
    github.visibility = "private"
    response = client.post("/api/v1/tasks/github/import", json={
        "repository": "octo/hello", "connectionId": connection["id"], "numbers": [1],
    })
    assert response.status_code == 201, response.text
    assert len(response.json()["created"]) == 1
    assert all(request.headers["authorization"] == "Bearer secret-token" for request in github.requests)
    assert service.store.grants(ALICE, "task", response.json()["created"][0]["id"]) == []


@pytest.mark.parametrize("route", ["issues", "import"])
@pytest.mark.parametrize("with_admin_cookie", [False, True])
def test_chat_actor_cannot_borrow_user_connections(context, github, route, with_admin_cookie):
    _app, client, _project = context
    connection = _connect(client)
    client.cookies.clear()
    if with_admin_cookie:
        login = client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
        assert login.status_code == 200
    response = client.post(f"/api/v1/tasks/github/{route}", headers={
        "Authorization": "Bearer chat-service-token", "x-relay-user-id": ALICE,
    }, json={"repository": "octo/hello", "connectionId": connection["id"], "numbers": [1]})
    assert response.status_code == (403 if with_admin_cookie else 401), response.text
    assert github.requests == []
