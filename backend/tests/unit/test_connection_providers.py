"""Provider-specific OAuth, refresh, resource selection and bounded actions."""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.fernet import Fernet

from relay.connections import providers
from relay.connections.service import ConnectionService
from relay.core.connections import ConnectionConfig, ConnectionError, connections_config_from_env
from relay.persistence.connection.store import DatabaseConnectionStore


@pytest.mark.parametrize("provider", ["slack", "google-drive"])
def test_provider_authentication_and_real_action_adapter(tmp_path, monkeypatch, provider):
    calls = []

    def handler(request):
        calls.append(request)
        path = request.url.path
        if path in {"/api/oauth.v2.access", "/token"}:
            scope = "channels:read,channels:history,chat:write" if provider == "slack" else "openid email https://www.googleapis.com/auth/drive.readonly"
            return httpx.Response(200, json={"access_token": "service-token", "scope": scope, "refresh_token": "refresh", "expires_in": 3600})
        assert request.headers["Authorization"] == "Bearer service-token"
        if path == "/api/auth.test":
            return httpx.Response(200, json={"ok": True, "user_id": "B1", "user": "Relay", "team_id": "T1", "team": "Studio"})
        if path == "/v1/userinfo":
            return httpx.Response(200, json={"sub": "G1", "email": "user@example.test"})
        if path == "/api/conversations.list":
            return httpx.Response(200, json={"ok": True, "channels": [{"id": "C1", "name": "releases"}]})
        if path == "/drive/v3/files":
            return httpx.Response(200, json={"files": [{"id": "F1", "name": "Release plan"}]})
        if path == "/api/conversations.history":
            return httpx.Response(200, json={"ok": True, "messages": [{"text": "Ship it"}]})
        if path == "/api/chat.postMessage":
            return httpx.Response(200, json={"ok": True, "ts": "1.0"})
        if path == "/drive/v3/files/F1" and request.url.params.get("alt") == "media":
            return httpx.Response(200, text="Release plan contents")
        if path == "/drive/v3/files/F1":
            return httpx.Response(200, json={"id": "F1", "name": "Release plan", "mimeType": "text/plain"})
        raise AssertionError(str(request.url))

    monkeypatch.setattr(providers, "transport", httpx.MockTransport(handler))
    service = ConnectionService(DatabaseConnectionStore(f"sqlite:///{tmp_path}/db"),
        {provider: ConnectionConfig(provider, "id", "secret", f"https://relay.example/api/v1/connections/callback/{provider}")}, Fernet.generate_key().decode())
    state = parse_qs(urlsplit(service.start("owner", "session", provider, "/settings/connections")).query)["state"][0]
    record, _ = service.complete("owner", "session", provider, state, code="code")
    resource = "C1" if provider == "slack" else "F1"
    actions = ["slack.history", "slack.post_message"] if provider == "slack" else ["google-drive.read_file"]
    assert service.resources("owner", record["id"])["resources"][0]["id"] == resource
    grants = service.set_grants("owner", "task", "task", [{"connectionId": record["id"], "resources": [resource], "actions": actions}])
    result = service.call("owner", grants, record["id"], actions[0], resource, {})
    assert "Ship it" in str(result) if provider == "slack" else "Release plan contents" in str(result)
    if provider == "slack":
        assert service.call("owner", grants, record["id"], "slack.post_message", resource, {"text": "Release ready"})["ok"]
        assert sum(request.url.path == "/api/chat.postMessage" for request in calls) == 1
        with pytest.raises(ConnectionError, match="connection_arguments_invalid"):
            service.call("owner", grants, record["id"], "slack.post_message", resource, {"text": "x", "channel": "C2"})


def test_provider_failure_does_not_expose_response_or_retry_writes(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(503, text="sensitive provider internals")

    monkeypatch.setattr(providers, "transport", httpx.MockTransport(handler))
    with pytest.raises(ConnectionError, match="connection_provider_unavailable"):
        providers.call("slack", "token", "slack.post_message", "C1", {"text": "Hello"})
    assert len(calls) == 1


def test_expired_refresh_is_reported_as_reconnect_required(monkeypatch):
    monkeypatch.setattr(providers, "transport", httpx.MockTransport(lambda _request:
        httpx.Response(400, json={"error": "invalid_grant"})))
    with pytest.raises(ConnectionError, match="connection_reconnect_required"):
        providers.exchange(ConnectionConfig("google-drive", "id", "secret", "https://relay.example"),
            {"grant_type": "refresh_token", "refresh_token": "expired"})


def test_configuration_requires_complete_credentials_and_valid_callback(monkeypatch):
    monkeypatch.setenv("RELAY_CONNECTIONS_SLACK_CLIENT_ID", "id")
    with pytest.raises(ValueError, match="CLIENT_SECRET"):
        connections_config_from_env()
    monkeypatch.setenv("RELAY_CONNECTIONS_SLACK_CLIENT_SECRET", "secret")
    monkeypatch.setenv("RELAY_CONNECTIONS_SLACK_CALLBACK_URL", "https://evil.example/wrong")
    with pytest.raises(ValueError, match="CALLBACK_URL"):
        connections_config_from_env()
