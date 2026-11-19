"""Provider OAuth and the run-bound Inbox contract."""

import time
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import rsa

from relay.connections import providers
from relay.connections.service import ConnectionService
from relay.core.connections import ConnectionConfig, ConnectionError
from relay.persistence.connection.store import DatabaseConnectionStore

TENANT = "18145fa6-93d3-4191-a576-6d42edd48a83"
OBJECT = "10aaf069-13fe-40a2-87b9-59b22bf47b78"
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"


@pytest.fixture(params=["gmail", "outlook"])
def mailbox(request, tmp_path, monkeypatch):
    provider = request.param
    config = ConnectionConfig(provider, "client", "secret", f"https://relay.example/api/v1/connections/callback/{provider}")
    service = ConnectionService(DatabaseConnectionStore(f"sqlite:///{tmp_path}/db"),
        {provider: config}, Fernet.generate_key().decode())
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = {**jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True), "kid": "test", "use": "sig"}
    issuer = "https://accounts.google.com" if provider == "gmail" else f"https://login.microsoftonline.com/{TENANT}/v2.0"
    if provider == "outlook":
        jwk["issuer"] = "https://login.microsoftonline.com/{tenantid}/v2.0"
    control = {"moved": False, "subject": "user-1", "object": OBJECT, "bad_nonce": False, "refreshes": 0,
        "refresh_error": False, "outlook_next_host": "graph.microsoft.com", "pages": []}

    def handler(req):
        path = req.url.path
        if req.method == "POST":
            fields = parse_qs(req.content.decode())
            assert fields["grant_type"] in (["authorization_code"], ["refresh_token"])
            if fields["grant_type"] == ["refresh_token"]:
                control["refreshes"] += 1
                assert fields["refresh_token"] == ["refresh"]
                if control["refresh_error"]:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": "new-access", "expires_in": 3600})
            assert fields["code_verifier"]
            claims = {"iss": issuer, "aud": "client", "sub": control["subject"], "iat": int(time.time()),
                "exp": int(time.time()) + 3600, "nonce": "wrong" if control["bad_nonce"] else control["nonce"],
                "preferred_username": "mail@example.com", "oid": control["object"], "tid": TENANT}
            return httpx.Response(200, json={"access_token": "mail-token", "refresh_token": "refresh",
                "expires_in": 1, "scope": GMAIL_SCOPE if provider == "gmail" else "Mail.Read profile",
                "id_token": jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test"})})
        if path.endswith(("/certs", "/keys")):
            return httpx.Response(200, json={"keys": [jwk]})
        if path.endswith("/profile"):
            return httpx.Response(200, json={"emailAddress": "mail@example.com"})
        if path.endswith("/mailFolders/inbox"):
            return httpx.Response(200, json={"id": "inbox-folder"})
        if path.endswith("/messages"):
            if provider == "gmail":
                assert req.url.params["labelIds"] == "INBOX"
                page = req.url.params.get("pageToken")
                control["pages"].append(page)
                return httpx.Response(200, json={"messages": [{"id": "msg1"}],
                    **({"nextPageToken": "gmail-cursor"} if not page else {})})
            assert "/mailFolders/inbox/" in path
            page = req.url.params.get("$skip")
            control["pages"].append(page)
            next_link = f"https://{control['outlook_next_host']}/v1.0/me/mailFolders/inbox/messages?$skip=10"
            return httpx.Response(200, json={"value": [graph_message()], **({"@odata.nextLink": next_link} if not page else {})})
        if path.endswith("/messages/msg1"):
            if provider == "gmail":
                return httpx.Response(200, json={"id": "msg1", "internalDate": "1710000000000",
                    "labelIds": ["UNREAD"] if control["moved"] else ["INBOX", "UNREAD"],
                    "payload": {"mimeType": "text/plain", "body": {"data": "SGVsbG8"},
                        "headers": [{"name": "Subject", "value": "Hello"}]}})
            return httpx.Response(200, json=graph_message())
        raise AssertionError(str(req.url))

    def graph_message():
        return {"id": "msg1", "parentFolderId": "other" if control["moved"] else "inbox-folder",
            "subject": "Hello", "isRead": False, "receivedDateTime": "2024-03-09T10:00:00Z",
            "body": {"contentType": "html", "content": "<p>Hello</p><script>bad</script>"}}

    monkeypatch.setattr(providers, "transport", httpx.MockTransport(handler))

    def authorize(reconnect=None):
        url = service.start("owner", "session", provider, "/settings/connections", reconnect)
        query = parse_qs(urlsplit(url).query)
        control["nonce"] = query["nonce"][0]
        assert query["code_challenge_method"] == ["S256"]
        if provider == "gmail":
            assert query["access_type"] == ["offline"]
        else:
            assert "offline_access" in query["scope"][0].split()
        return service.complete("owner", "session", provider, query["state"][0], code="code")[0]

    return service, provider, control, authorize


def test_verified_inbox_grant_refresh_and_revocation(mailbox):
    service, provider, control, authorize = mailbox
    record = authorize()
    connection_id = record["id"]
    assert record["identity"] == "mail@example.com"
    assert service.resources("owner", connection_id)["resources"] == [{"id": "inbox", "name": "Inbox"}]
    list_action, get_action = f"{provider}.list_messages", f"{provider}.get_message"
    grant = {"connectionId": connection_id, "resources": ["inbox"], "actions": [get_action]}
    with pytest.raises(ConnectionError, match="connection_grants_invalid"):
        service.set_grants("owner", "task", "task", [grant])
    snapshot = service.set_grants("owner", "task", "task", [{**grant, "actions": [list_action, get_action]}])
    listed = service.call("owner", snapshot, connection_id, list_action, "inbox", {"limit": 10}, run_id="run")
    message_id = listed["messages"][0]["id"]
    assert message_id != "msg1"
    assert listed["messages"][0]["subject"] == "Hello"
    assert control["refreshes"] == 1
    with pytest.raises(ConnectionError, match="connection_cursor_invalid"):
        service.call("owner", snapshot, connection_id, list_action, "inbox",
            {"limit": 10, "cursor": listed["nextCursor"]}, run_id="other-run")
    with pytest.raises(ConnectionError, match="connection_cursor_invalid"):
        service.call("owner", snapshot, connection_id, list_action, "inbox",
            {"limit": 20, "cursor": listed["nextCursor"]}, run_id="run")
    second_page = service.call("owner", snapshot, connection_id, list_action, "inbox",
        {"limit": 10, "cursor": listed["nextCursor"]}, run_id="run")
    assert second_page["nextCursor"] is None
    assert control["pages"] == [None, "gmail-cursor" if provider == "gmail" else "10"]
    with pytest.raises(ConnectionError, match="connection_arguments_invalid"):
        service.call("owner", snapshot, connection_id, get_action, "inbox", {"messageId": "msg1"}, run_id="run")
    assert service.call("owner", snapshot, connection_id, get_action, "inbox",
        {"messageId": message_id}, run_id="run")["body"] == "Hello"
    control["moved"] = True
    with pytest.raises(ConnectionError, match="connection_message_unavailable"):
        service.call("owner", snapshot, connection_id, get_action, "inbox", {"messageId": message_id}, run_id="run")
    service.disconnect("owner", connection_id)
    with pytest.raises(ConnectionError, match="connection_unavailable"):
        service.call("owner", snapshot, connection_id, list_action, "inbox", {}, run_id="run")


def test_oauth_rejects_bad_nonce_and_another_identity(mailbox):
    service, provider, control, authorize = mailbox
    control["bad_nonce"] = True
    with pytest.raises(ConnectionError, match="connection_identity_invalid"):
        authorize()
    assert service.list("owner") == []
    control["bad_nonce"] = False
    record = authorize()
    assert authorize(record["id"])["id"] == record["id"]
    if provider == "gmail":
        control["subject"] = "different-subject"
    else:
        control["object"] = "1753da78-2497-4629-89c3-d3c95bd99fea"
    with pytest.raises(ConnectionError, match="connection_identity_mismatch"):
        authorize(record["id"])


def test_refresh_revocation_commits_reconnect_required(mailbox):
    service, _provider, control, authorize = mailbox
    record = authorize()
    control["refresh_error"] = True
    with pytest.raises(ConnectionError, match="connection_reconnect_required"):
        service.token("owner", record["id"])
    assert service.list("owner")[0]["status"] == "reconnect_required"


@pytest.mark.parametrize("mailbox", ["outlook"], indirect=True)
def test_outlook_rejects_provider_cursor_that_leaves_graph(mailbox):
    service, _provider, control, authorize = mailbox
    record = authorize()
    control["outlook_next_host"] = "example.com"
    action = "outlook.list_messages"
    grants = service.set_grants("owner", "task", "task", [
        {"connectionId": record["id"], "resources": ["inbox"], "actions": [action]}])
    with pytest.raises(ConnectionError, match="connection_cursor_invalid"):
        service.call("owner", grants, record["id"], action, "inbox", {}, run_id="run")
