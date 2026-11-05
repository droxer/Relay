"""Service authorization and grants must not expose or widen credentials."""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.fernet import Fernet

from relay.connections import providers
from relay.connections.service import ConnectionService
from relay.core.connections import ConnectionConfig, ConnectionError
from relay.persistence.connection.store import DatabaseConnectionStore


@pytest.fixture
def service(tmp_path, monkeypatch):
    def handler(request):
        if request.url.path == "/login/oauth/access_token":
            return httpx.Response(200, json={"access_token": "provider-secret", "scope": "read:user,repo"})
        assert request.headers["Authorization"] == "Bearer provider-secret"
        if request.url.path == "/user":
            return httpx.Response(200, json={"id": 17, "login": "octocat"})
        if request.url.path == "/user/repos":
            return httpx.Response(200, json=[{"id": 42, "full_name": "octo/hello"}])
        if request.url.path == "/repos/octo/hello/issues":
            return httpx.Response(200, json=[{"number": 1, "title": "Deliver Connections"}])
        raise AssertionError(str(request.url))

    monkeypatch.setattr(providers, "transport", httpx.MockTransport(handler))
    store = DatabaseConnectionStore(f"sqlite:///{tmp_path}/connections.db")
    config = ConnectionConfig("github", "client", "client-secret", "https://relay.example/api/v1/connections/callback/github")
    return ConnectionService(store, {"github": config}, Fernet.generate_key().decode())


def connect(service, user="alice", session="session"):
    url = service.start(user, session, "github", "/settings/connections")
    state = parse_qs(urlsplit(url).query)["state"][0]
    return service.complete(user, session, "github", state, code="code")[0]


def test_oauth_state_is_session_bound_and_single_use(service):
    url = service.start("alice", "session", "github", "/settings/connections")
    query = parse_qs(urlsplit(url).query)
    assert query["code_challenge_method"] == ["S256"]
    with pytest.raises(ConnectionError, match="connection_state_invalid"):
        service.complete("alice", "other-session", "github", query["state"][0], code="code")
    with pytest.raises(ConnectionError, match="connection_state_invalid"):
        service.complete("alice", "session", "github", query["state"][0], code="code")


@pytest.mark.parametrize("path", ["https://evil.example", "//evil.example", "/\\evil", "/settings\nLocation:x"])
def test_authorization_rejects_unsafe_returns(service, path):
    with pytest.raises(ConnectionError, match="connection_return_invalid"):
        service.start("alice", "session", "github", path)


def test_credentials_are_encrypted_and_foreign_connections_hidden(service):
    connection = connect(service)
    assert connection["identity"] == "octocat"
    assert "provider-secret" not in str(connection)
    assert "provider-secret" not in service.store.get("alice", connection["id"])["sealedSecret"]
    assert service.list("bob") == []
    with pytest.raises(ConnectionError, match="connection_not_found"):
        service.resources("bob", connection["id"])


def test_grants_bound_actions_resources_and_disconnect(service):
    connection = connect(service)
    resources = service.resources("alice", connection["id"])
    assert resources["resources"] == [{"id": "octo/hello", "name": "octo/hello"}]
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    service.set_grants("alice", "task", "task-1", [grant])
    snapshot = service.grants("alice", "task", "task-1")
    assert service.call("alice", snapshot, connection["id"], "github.list_issues", "octo/hello", {})[0]["number"] == 1
    with pytest.raises(ConnectionError, match="connection_access_denied"):
        service.call("alice", snapshot, connection["id"], "github.list_issues", "octo/private", {})
    with pytest.raises(ConnectionError, match="connection_access_denied"):
        service.call("alice", snapshot, connection["id"], "github.create_issue", "octo/hello", {})
    service.disconnect("alice", connection["id"])
    with pytest.raises(ConnectionError, match="connection_unavailable"):
        service.call("alice", snapshot, connection["id"], "github.list_issues", "octo/hello", {})


def test_grant_reduction_revokes_live_snapshot_without_expanding_it(service):
    connection = connect(service)
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    service.set_grants("alice", "thread", "thread-1", [grant])
    snapshot = service.grants("alice", "thread", "thread-1")
    service.set_grants("alice", "thread", "thread-1", [])
    with pytest.raises(ConnectionError, match="connection_access_denied"):
        service.call("alice", snapshot, connection["id"], "github.list_issues", "octo/hello", {})


def test_grant_validation_is_atomic(service):
    connection = connect(service)
    valid = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    service.set_grants("alice", "automation", "automation-1", [valid])
    with pytest.raises(ConnectionError):
        service.set_grants("alice", "automation", "automation-1", [valid, {**valid, "resources": ["https://evil.example"]}])
    assert len(service.grants("alice", "automation", "automation-1")) == 1


def test_delivery_resolves_only_work_grants_and_refuses_unavailable_access(service):
    connection = connect(service)
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    service.set_grants("alice", "thread", "thread-1", [grant])
    resolved = service.for_work("alice", "thread-1")
    assert resolved[0]["connectionId"] == connection["id"]
    assert service.for_work("bob", "thread-1") == []
    service.disconnect("alice", connection["id"])
    with pytest.raises(ConnectionError, match="connection_unavailable"):
        service.for_work("alice", "thread-1")


def test_insufficient_provider_consent_is_not_reported_connected(service, monkeypatch):
    monkeypatch.setattr(providers, "exchange", lambda *_args: {"access_token": "provider-secret", "scope": "read:user"})
    with pytest.raises(ConnectionError, match="connection_permissions_invalid"):
        connect(service)
    assert service.list("alice") == []


def test_deleting_owner_retires_credentials_and_pending_authorizations(service):
    connection = connect(service)
    url = service.start("alice", "session", "github", "/settings/connections")
    state = parse_qs(urlsplit(url).query)["state"][0]
    service.disconnect_all("alice")
    assert service.store.get("alice", connection["id"])["sealedSecret"] is None
    with pytest.raises(ConnectionError, match="connection_state_invalid"):
        service.complete("alice", "session", "github", state, code="code")
