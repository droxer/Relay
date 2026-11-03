"""GitHub connection is deferred even when App settings are present."""

import httpx
import pytest
from cryptography.fernet import Fernet

from test_github_issue_import import context as context


@pytest.fixture(autouse=True)
def app_config(monkeypatch):
    monkeypatch.setenv("RELAY_GITHUB_CLIENT_ID", "client")
    monkeypatch.setenv("RELAY_GITHUB_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("RELAY_GITHUB_APP_SLUG", "relay-issues")
    monkeypatch.setenv("RELAY_GITHUB_CALLBACK_URL", "https://relay.example/api/v1/account/github/callback")
    monkeypatch.setenv("RELAY_GITHUB_ENCRYPTION_KEY", Fernet.generate_key().decode())


def test_connection_status_is_coming_soon(context):
    app, client, _project = context
    response = client.get("/api/v1/account/github")
    assert response.status_code == 200
    assert response.json() == {"configured": False, "connected": False, "comingSoon": True, "login": None, "manageUrl": None}
    assert app.state.github_connection.config is None


def test_connection_and_callback_are_disabled(context, monkeypatch):
    from relay.accounts import github_client

    _app, client, _project = context

    def unexpected_request(request):
        raise AssertionError("Deferred connection must not contact GitHub")

    monkeypatch.setattr(github_client, "transport", httpx.MockTransport(unexpected_request))
    response = client.post("/api/v1/account/github/connect", json={})
    assert response.status_code == 501
    assert response.json()["detail"] == "github_connection_coming_soon"
    callback = client.get("/api/v1/account/github/callback", params={"state": "old-state", "code": "code"}, follow_redirects=False)
    assert callback.status_code == 501
    assert callback.json()["detail"] == "github_connection_coming_soon"


def test_deferred_connection_routes_still_require_a_session(context):
    _app, client, _project = context
    client.cookies.clear()
    assert client.get("/api/v1/account/github").status_code == 401
    assert client.post("/api/v1/account/github/connect", json={}).status_code == 401
    assert client.get("/api/v1/account/github/callback").status_code == 401


def test_existing_credentials_can_still_be_removed(context):
    app, client, _project = context
    account_id = client.get("/api/v1/auth/me").json()["user"]["id"]
    store = app.state.github_connection.store
    store.save_connection(account_id, "sealed-old-credential")
    store.issue_state(account_id, "pending", "sealed-pending-state")
    assert client.delete("/api/v1/account/github").status_code == 200
    assert store.read_connection(account_id) is None
    assert store.consume_state(account_id, "pending") is None
