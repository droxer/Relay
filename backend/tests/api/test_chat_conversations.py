from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app


@pytest.fixture(autouse=True)
def _channels_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Chat channels ship disabled; these tests cover the enabled feature."""
    monkeypatch.setenv("RELAY_CHANNELS_ENABLED", "1")

CHAT_HEADERS = {"Authorization": "Bearer chat_secret"}
CONVERSATION = {
    "provider": "discord",
    "tenantId": "guild_123",
    "externalUserId": "discord_user_1",
    "conversationId": "channel_123",
}


async def _healthy_provider(_settings):
    return True, "Provider credentials verified."


def _bootstrap_admin(client: TestClient) -> None:
    assert client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token", "username": "admin", "password": "kestrel-vault-7719",
    }).status_code == 200
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200


def _active_integration(client: TestClient) -> str:
    client.app.state.chat_probe = _healthy_provider
    assert client.post("/api/v1/admin/users", json={
        "username": "alice",
        "password": "harbor-quartz-8830",
        "employeeId": "alice",
        "displayName": "Alice",
    }).status_code == 201
    integration_id = client.post("/api/v1/admin/chat-integrations", json={
        "provider": "discord",
        "displayName": "Eng Discord",
        "tenantId": "guild_123",
        "secrets": {"botToken": "discord-secret-token"},
    }).json()["integration"]["id"]
    client.post(f"/api/v1/admin/chat-integrations/{integration_id}/identity-links", json={
        "externalUserId": "discord_user_1", "employeeId": "alice", "defaultSandboxId": "sbx_alice",
    })
    client.post(f"/api/v1/admin/chat-integrations/{integration_id}/allowed-conversations", json={
        "conversationId": "channel_123", "label": "team-agents",
    })
    assert client.post(f"/api/v1/admin/chat-integrations/{integration_id}/health-checks").status_code == 200
    assert client.post(f"/api/v1/admin/chat-integrations/{integration_id}/activations").status_code == 200
    return integration_id


def _create_session(client: TestClient, owner: str) -> str:
    response = client.post("/api/v1/threads", json={
        "taskGoal": f"task for {owner}",
        "assignments": [{"agent": "claude"}],
        "ownerEmployeeId": owner,
    })
    assert response.status_code == 201
    return response.json()["id"]


def test_conversation_mapping_round_trip(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_secret")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _active_integration(client)
        session_id = _create_session(client, "alice")

        # No binding yet.
        unbound = client.post("/api/v1/internal/chat/conversation/session", headers=CHAT_HEADERS, json=CONVERSATION)
        assert unbound.status_code == 200
        assert unbound.json()["session"] is None

        # Bind the thread to alice's session.
        bind = client.post(
            "/api/v1/internal/chat/conversation/mapping",
            headers=CHAT_HEADERS,
            json={**CONVERSATION, "sessionId": session_id, "messageId": "provider_reply_1"},
        )
        assert bind.status_code == 200
        assert bind.json()["mapping"]["sessionId"] == session_id
        assert bind.json()["mapping"]["ownerEmployeeId"] == "alice"
        assert bind.json()["mapping"]["providerMessageId"] == "provider_reply_1"

        # Resolving now returns the bound session.
        resolved = client.post("/api/v1/internal/chat/conversation/session", headers=CHAT_HEADERS, json=CONVERSATION)
        assert resolved.status_code == 200
        assert resolved.json()["session"]["id"] == session_id

        # And it appears in the owner's conversation list.
        listed = client.post("/api/v1/internal/chat/conversation/sessions", headers=CHAT_HEADERS, json=CONVERSATION)
        assert listed.status_code == 200
        assert [s["id"] for s in listed.json()["sessions"]] == [session_id]


def test_conversation_mapping_rejects_foreign_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_secret")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _active_integration(client)
        bob_session = _create_session(client, "bob")

        # alice's thread may not bind to bob's session.
        rejected = client.post("/api/v1/internal/chat/conversation/mapping", headers=CHAT_HEADERS, json={**CONVERSATION, "sessionId": bob_session})
        assert rejected.status_code == 403


def test_conversation_mapping_rejects_ownerless_legacy_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_secret")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _active_integration(client)
        legacy_session = app.state.session_store.create_session({
            "workspacePath": "/workspace",
            "taskGoal": "legacy task",
            "participants": ["human"],
        })["id"]

        rejected = client.post(
            "/api/v1/internal/chat/conversation/mapping",
            headers=CHAT_HEADERS,
            json={**CONVERSATION, "sessionId": legacy_session},
        )

        assert rejected.status_code == 403


def test_conversation_mapping_requires_service_token(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_secret")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _active_integration(client)

        unauth = client.post("/api/v1/internal/chat/conversation/session", json=CONVERSATION)
        assert unauth.status_code == 401
