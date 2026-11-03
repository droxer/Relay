"""Browser GitHub App connection, scoped to a signed-in Relay user."""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select, update

from test_github_issue_import import context as context, github as github


@pytest.fixture(autouse=True)
def app_config(monkeypatch):
    monkeypatch.setenv("RELAY_GITHUB_CLIENT_ID", "client")
    monkeypatch.setenv("RELAY_GITHUB_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("RELAY_GITHUB_APP_SLUG", "relay-issues")
    monkeypatch.setenv("RELAY_GITHUB_CALLBACK_URL", "https://relay.example/api/v1/account/github/callback")
    monkeypatch.setenv("RELAY_GITHUB_ENCRYPTION_KEY", Fernet.generate_key().decode())


def test_connect_is_session_scoped_and_uses_pkce(context):
    _app, client, _project = context
    response = client.post("/api/v1/account/github/connect", json={"returnTo": "/issues?githubImport=1"})
    assert response.status_code == 200, response.text
    url = urlsplit(response.json()["authorizeUrl"])
    assert url.hostname == "github.com"
    query = parse_qs(url.query)
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["state"][0]) >= 32
    assert query["scope"] == ["offline_access"]
    client.cookies.clear()
    assert client.get("/api/v1/account/github").status_code == 401
    assert client.post("/api/v1/account/github/connect", json={}).status_code == 401


def test_callback_rejects_unknown_state_before_network(context):
    _app, client, _project = context
    response = client.get("/api/v1/account/github/callback?state=forged&code=code", follow_redirects=False)
    assert response.status_code == 400
    assert response.json()["detail"] == "github_connection_state_invalid"


def test_full_connection_encrypts_tokens_imports_and_disconnects(context, github, monkeypatch):
    from relay.accounts import github_client

    app, client, _project = context
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.host == "github.com":
            assert request.url.query == b""
            fields = parse_qs(request.content.decode())
            if fields.get("grant_type") == ["refresh_token"]:
                assert fields["refresh_token"] == ["ghr_private"]
                return httpx.Response(200, json={"access_token": "ghu_refreshed", "expires_in": 28800,
                    "refresh_token": "ghr_refreshed", "refresh_token_expires_in": 15897600})
            assert b"code_verifier=" in request.content
            return httpx.Response(200, json={"access_token": "ghu_private", "expires_in": 1,
                "refresh_token": "ghr_private", "refresh_token_expires_in": 15897600})
        if request.url.path == "/user":
            return httpx.Response(200, json={"id": 42, "login": "octocat"})
        if request.url.path == "/user/installations":
            installed = sum(item.url.path == "/user/installations" for item in requests) > 1
            return httpx.Response(200, json={"installations": [{"id": 7, "permissions": {"issues": "read", "metadata": "read"}}] if installed else []})
        if request.url.path == "/user/installations/7/repositories":
            return httpx.Response(200, json={"repositories": []})
        raise AssertionError(request.url)

    monkeypatch.setattr(github_client, "transport", httpx.MockTransport(handler))
    start = client.post("/api/v1/account/github/connect", json={"returnTo": "/issues?githubImport=1"}).json()
    state = parse_qs(urlsplit(start["authorizeUrl"]).query)["state"][0]
    callback = client.get("/api/v1/account/github/callback", params={"code": "code", "state": state}, follow_redirects=False)
    assert callback.status_code == 303, callback.text
    installation = urlsplit(callback.headers["location"])
    assert installation.path == "/apps/relay-issues/installations/new"
    installation_state = parse_qs(installation.query)["state"][0]
    complete = client.get("/api/v1/account/github/callback", params={"installation_id": 7, "state": installation_state}, follow_redirects=False)
    assert complete.status_code == 303
    assert complete.headers["location"] == "/issues?githubImport=1&githubConnection=connected"
    status = client.get("/api/v1/account/github").json()
    assert status["connected"] is True
    assert status["login"] == "octocat"
    assert "private" not in str(status)
    store = app.state.github_connection.store
    with store.engine.connect() as connection:
        sealed = connection.scalar(select(store.connections.c.sealed_secret))
    assert "ghu_private" not in sealed and "ghr_private" not in sealed
    replay = client.get("/api/v1/account/github/callback", params={"installation_id": 7, "state": installation_state}, follow_redirects=False)
    assert replay.status_code == 400
    imported = client.post("/api/v1/tasks/github/import", json={"repository": "octo/hello", "numbers": [1]})
    assert imported.status_code == 201, imported.text
    assert github.requests[0].headers["authorization"] == "Bearer ghu_refreshed"
    assert client.delete("/api/v1/account/github").status_code == 200
    assert client.get("/api/v1/account/github").json()["connected"] is False


@pytest.mark.parametrize("return_to", ["https://evil.example", "//evil.example", "/\\evil.example"])
def test_connect_refuses_external_return_urls(context, return_to):
    _app, client, _project = context
    response = client.post("/api/v1/account/github/connect", json={"returnTo": return_to})
    assert response.status_code == 400


def test_callback_state_is_bound_to_the_login_session(context):
    from test_project_routes import _login_alice

    _app, client, _project = context
    start = client.post("/api/v1/account/github/connect", json={}).json()
    state = parse_qs(urlsplit(start["authorizeUrl"]).query)["state"][0]
    _login_alice(client)
    response = client.get("/api/v1/account/github/callback", params={"code": "unused", "state": state}, follow_redirects=False)
    assert response.status_code == 400
    assert response.json()["detail"] == "github_connection_state_invalid"


def test_disconnect_invalidates_an_unfinished_authorization(context):
    _app, client, _project = context
    start = client.post("/api/v1/account/github/connect", json={}).json()
    state = parse_qs(urlsplit(start["authorizeUrl"]).query)["state"][0]
    assert client.delete("/api/v1/account/github").status_code == 200
    response = client.get("/api/v1/account/github/callback", params={"code": "unused", "state": state}, follow_redirects=False)
    assert response.status_code == 400


def test_provider_failure_returns_to_a_recoverable_ui(context, monkeypatch):
    from relay.accounts import github_client

    _app, client, _project = context
    monkeypatch.setattr(github_client, "transport", httpx.MockTransport(lambda request: httpx.Response(403)))
    start = client.post("/api/v1/account/github/connect", json={}).json()
    state = parse_qs(urlsplit(start["authorizeUrl"]).query)["state"][0]
    response = client.get("/api/v1/account/github/callback", params={"code": "code", "state": state}, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/settings/account?githubConnection=failed"
    assert client.get("/api/v1/account/github").json()["connected"] is False


def test_connection_attempts_are_rate_limited(context):
    _app, client, _project = context
    for _ in range(5):
        assert client.post("/api/v1/account/github/connect", json={}).status_code == 200
    response = client.post("/api/v1/account/github/connect", json={})
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0


def test_reconnect_reuses_an_existing_read_only_installation(context, monkeypatch):
    from relay.accounts import github_client

    _app, client, _project = context

    def handler(request):
        if request.url.host == "github.com":
            return httpx.Response(200, json={"access_token": "ghu_existing", "expires_in": 28800})
        if request.url.path == "/user":
            return httpx.Response(200, json={"id": 42, "login": "octocat"})
        if request.url.path == "/user/installations":
            return httpx.Response(200, json={"installations": [{"id": 7, "permissions": {"issues": "read"}}]})
        assert request.url.path == "/user/installations/7/repositories"
        return httpx.Response(200, json={"repositories": []})

    monkeypatch.setattr(github_client, "transport", httpx.MockTransport(handler))
    start = client.post("/api/v1/account/github/connect", json={}).json()
    state = parse_qs(urlsplit(start["authorizeUrl"]).query)["state"][0]
    response = client.get("/api/v1/account/github/callback", params={"code": "code", "state": state}, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/settings/account?githubConnection=connected"
    assert client.get("/api/v1/account/github").json()["connected"] is True


def test_callback_rejects_expired_state(context):
    from relay.persistence.tables.github import states

    app, client, _project = context
    start = client.post("/api/v1/account/github/connect", json={}).json()
    state = parse_qs(urlsplit(start["authorizeUrl"]).query)["state"][0]
    with app.state.github_connection.store.engine.begin() as connection:
        connection.execute(update(states).values(expires_at=0))
    response = client.get("/api/v1/account/github/callback", params={"code": "unused", "state": state}, follow_redirects=False)
    assert response.status_code == 400
