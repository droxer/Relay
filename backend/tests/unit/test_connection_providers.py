"""Provider-specific OAuth, refresh, resource selection and bounded actions."""

import httpx
import pytest
from cryptography.fernet import Fernet

from relay.connections import providers
from relay.connections.service import ConnectionService
from relay.core.connections import ConnectionConfig, ConnectionError, connections_config_from_env
from relay.persistence.connection.store import DatabaseConnectionStore


@pytest.mark.parametrize("provider", ["slack", "google-drive", "gmail"])
def test_unsupported_providers_cannot_authorize_or_execute(tmp_path, provider):
    service = ConnectionService(DatabaseConnectionStore(f"sqlite:///{tmp_path}/db"), {}, Fernet.generate_key().decode())
    assert [item["id"] for item in service.catalog()] == ["github"]
    with pytest.raises(ConnectionError, match="connection_provider_not_configured"):
        service.start("owner", "session", provider, "/settings/connections")
    with pytest.raises(ConnectionError, match="connection_access_denied"):
        providers.call(provider, "token", f"{provider}.read", "resource", {})


def test_provider_failure_does_not_expose_response_or_retry(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(503, text="sensitive provider internals")

    monkeypatch.setattr(providers, "transport", httpx.MockTransport(handler))
    with pytest.raises(ConnectionError, match="connection_provider_unavailable"):
        providers.call("github", "token", "github.list_issues", "octo/repo", {})
    assert len(calls) == 1


def test_expired_refresh_is_reported_as_reconnect_required(monkeypatch):
    monkeypatch.setattr(providers, "transport", httpx.MockTransport(lambda _request:
        httpx.Response(400, json={"error": "invalid_grant"})))
    with pytest.raises(ConnectionError, match="connection_reconnect_required"):
        providers.exchange(ConnectionConfig("github", "id", "secret", "https://relay.example"),
            {"grant_type": "refresh_token", "refresh_token": "expired"})


def test_configuration_requires_complete_credentials_and_valid_callback(monkeypatch):
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CLIENT_ID", "id")
    with pytest.raises(ValueError, match="CLIENT_SECRET"):
        connections_config_from_env()
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CLIENT_SECRET", "secret")
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CALLBACK_URL", "https://evil.example/wrong")
    with pytest.raises(ValueError, match="CALLBACK_URL"):
        connections_config_from_env()
