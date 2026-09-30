from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.chat import DatabaseChatIntegrationStore, LocalChatIntegrationStore
from relay.chat.provider_health import (
    probe_chat_integration,
    provision_chat_integration,
)
from relay.core.computer_identity import computer_id


@pytest.fixture(autouse=True)
def _channels_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Chat channels ship disabled; these tests cover the enabled feature."""
    monkeypatch.setenv("RELAY_CHANNELS_ENABLED", "1")


async def _healthy_provider(_settings):
    return True, "Provider credentials verified."


async def _healthy_provision(_settings, _integration_id):
    return True, "Provider callback registered."


def test_provider_probe_uses_telegram_get_me() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"ok": True}, request=request)
    )

    async def run_probe():
        async with httpx.AsyncClient(transport=transport) as client:
            return await probe_chat_integration(
                {
                    "provider": "telegram",
                    "secrets": {"botToken": "token", "webhookSecret": "webhook"},
                },
                client,
            )

    assert asyncio.run(run_probe()) == (True, "Provider credentials verified.")


def test_provider_provision_uses_ui_callback_url() -> None:
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/setWebhook"):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={"ok": True}, request=request)
        return httpx.Response(
            200,
            json={
                "ok": True,
                "result": {"url": "https://relay.example/webhooks/telegram/chat_123"},
            },
            request=request,
        )

    async def run_provision():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await provision_chat_integration(
                {
                    "provider": "telegram",
                    "config": {"publicBaseUrl": "https://relay.example"},
                    "secrets": {"botToken": "token", "webhookSecret": "hook"},
                },
                "chat_123",
                client=client,
            )

    assert asyncio.run(run_provision()) == (True, "Telegram webhook registered.")
    assert captured["url"] == "https://relay.example/webhooks/telegram/chat_123"


def test_telegram_provision_rejects_unconfirmed_webhook_url() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = (
            {"ok": True}
            if request.url.path.endswith("/setWebhook")
            else {
                "ok": True,
                "result": {"url": "https://wrong.example/webhook"},
            }
        )
        return httpx.Response(200, json=payload, request=request)

    async def run_provision():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await provision_chat_integration(
                {
                    "provider": "telegram",
                    "config": {"publicBaseUrl": "https://relay.example"},
                    "secrets": {"botToken": "token", "webhookSecret": "hook"},
                },
                "chat_123",
                client=client,
            )

    assert asyncio.run(run_provision()) == (
        False,
        "Telegram did not confirm the configured webhook URL.",
    )


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={
            "token": "admin_token",
            "username": "admin",
            "password": "kestrel-vault-7719",
        },
    )
    assert response.status_code == 200


def _login(client: TestClient, username: str, password: str) -> None:
    response = client.post(
        "/api/v1/auth/login",
        json={
            "username": username,
            "password": password,
        },
    )
    assert response.status_code == 200


def test_chat_integration_setup_flow_redacts_secrets(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat_secret")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        client.app.state.chat_probe = _healthy_provider
        client.app.state.chat_provision = _healthy_provision
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")
        assert (
            client.post(
                "/api/v1/admin/users",
                json={
                    "username": "alice",
                    "password": "harbor-quartz-8830",
                    "employeeId": "alice",
                    "displayName": "Alice",
                },
            ).status_code
            == 201
        )
        node = client.app.state.registry.register(
            {
                "sandboxId": "offline_node_alice",
                "employeeId": "alice",
                "workspaceId": "machine-alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "stopped",
            }
        )
        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Chat agent",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
            },
        ).json()["agent"]

        create = client.post(
            "/api/v1/admin/chat-integrations",
            json={
                "provider": "discord",
                "displayName": "Engineering Discord",
                "tenantId": "guild_123",
                "config": {"commandName": "relay"},
                "secrets": {"botToken": "discord-secret-token"},
            },
        )
        assert create.status_code == 201
        integration = create.json()["integration"]
        integration_id = integration["id"]
        assert integration["provider"] == "discord"
        assert integration["status"] == "draft"
        assert integration["secretConfigured"] is True
        assert integration["secretKeys"] == ["botToken"]
        assert "discord-secret-token" not in create.text

        check = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/health-checks"
        )
        assert check.status_code == 200
        assert check.json()["integration"]["status"] == "degraded"

        activate = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/activations"
        )
        assert activate.status_code == 400
        assert "identity link" in activate.json()["detail"]

        link = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/identity-links",
            json={
                "externalUserId": "discord_user_1",
                "employeeId": "alice",
                "displayName": "Alice",
                "defaultAgentId": agent["id"],
            },
        )
        assert link.status_code == 201
        assert link.json()["integration"]["identityLinkCount"] == 1

        conversation = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/allowed-conversations",
            json={
                "conversationId": "channel_123",
                "label": "team-agents",
            },
        )
        assert conversation.status_code == 201
        assert conversation.json()["integration"]["allowedConversationCount"] == 1

        check = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/health-checks"
        )
        assert check.status_code == 200
        assert check.json()["integration"]["health"]["ok"] is True

        activate = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/activations"
        )
        assert activate.status_code == 200
        assert activate.json()["integration"]["status"] == "active"
        assert activate.json()["provisioning"]["ok"] is True
        assert "discord-secret-token" not in activate.text

        runtime = client.get(
            "/api/v1/internal/chat/integrations/runtime",
            headers={"Authorization": "Bearer chat_secret"},
        )
        assert runtime.status_code == 200
        assert (
            runtime.json()["integrations"][0]["secrets"]["botToken"]
            == "discord-secret-token"
        )

        resolved = client.post(
            "/api/v1/internal/chat/identity/resolve",
            headers={"Authorization": "Bearer chat_secret"},
            json={
                "provider": "discord",
                "tenantId": "guild_123",
                "externalUserId": "discord_user_1",
                "conversationId": "channel_123",
            },
        )
        assert resolved.status_code == 200
        assert resolved.json()["identity"]["employeeId"] == "alice"
        assert resolved.json()["identity"]["defaultAgentId"] == agent["id"]

        disallowed = client.post(
            "/api/v1/internal/chat/identity/resolve",
            headers={"Authorization": "Bearer chat_secret"},
            json={
                "provider": "discord",
                "tenantId": "guild_123",
                "externalUserId": "discord_user_1",
                "conversationId": "channel_elsewhere",
            },
        )
        assert disallowed.status_code == 404

        listing = client.get("/api/v1/admin/chat-integrations")
        assert listing.status_code == 200
        assert listing.json()["integrations"][0]["id"] == integration_id
        assert "discord-secret-token" not in listing.text

        audit = client.get(f"/api/v1/admin/chat-integrations/{integration_id}/audit")
        assert audit.status_code == 200
        assert [event["type"] for event in audit.json()["events"]][
            -1
        ] == "chat.integration.activated"


def test_chat_integration_check_rejects_invalid_provider_credentials(
    monkeypatch,
) -> None:
    async def invalid_provider(_settings):
        return False, "Provider rejected the configured credentials."

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        client.app.state.chat_probe = invalid_provider
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")
        assert (
            client.post(
                "/api/v1/admin/users",
                json={
                    "username": "alice",
                    "password": "harbor-quartz-8830",
                    "employeeId": "alice",
                },
            ).status_code
            == 201
        )
        integration_id = client.post(
            "/api/v1/admin/chat-integrations",
            json={
                "provider": "telegram",
                "displayName": "Operations Telegram",
                "secrets": {"botToken": "invalid"},
            },
        ).json()["integration"]["id"]
        client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/identity-links",
            json={
                "externalUserId": "42",
                "employeeId": "alice",
            },
        )
        client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/allowed-conversations",
            json={
                "conversationId": "-100",
            },
        )

        check = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/health-checks"
        )
        activate = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/activations"
        )

        assert check.status_code == 200
        assert check.json()["integration"]["health"] == {
            "ok": False,
            "message": "Provider rejected the configured credentials.",
            "lastCheckedAt": check.json()["integration"]["health"]["lastCheckedAt"],
        }
        assert activate.status_code == 400


def test_chat_integration_activation_requires_ui_callback_url(monkeypatch) -> None:
    provisioned_secrets = []

    async def capture_provision(settings, _integration_id):
        provisioned_secrets.append(settings["secrets"]["webhookSecret"])
        return True, "Telegram webhook registered."

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        client.app.state.chat_probe = _healthy_provider
        client.app.state.chat_provision = capture_provision
        _bootstrap_admin(client)
        _login(client, "admin", "kestrel-vault-7719")
        assert (
            client.post(
                "/api/v1/admin/users",
                json={
                    "username": "alice",
                    "password": "harbor-quartz-8830",
                    "employeeId": "alice",
                },
            ).status_code
            == 201
        )
        created = client.post(
            "/api/v1/admin/chat-integrations",
            json={
                "provider": "telegram",
                "displayName": "Operations Telegram",
                "secrets": {
                    "botToken": "token",
                    "webhookSecret": "caller-must-not-control-this",
                },
            },
        ).json()["integration"]
        integration_id = created["id"]
        assert created["secretKeys"] == ["botToken", "webhookSecret"]
        generated_secret = client.app.state.chat_store.connection_settings(
            integration_id
        )["secrets"]["webhookSecret"]
        assert generated_secret != "caller-must-not-control-this"
        forbidden_patch = client.patch(
            f"/api/v1/admin/chat-integrations/{integration_id}",
            json={
                "secrets": {"webhookSecret": "bypass-rotation"},
            },
        )
        assert forbidden_patch.status_code == 400

        client.app.state.chat_store.secrets_path.write_text(
            json.dumps(
                {
                    integration_id: {"botToken": "token"},
                }
            )
        )
        client.patch(
            f"/api/v1/admin/chat-integrations/{integration_id}",
            json={
                "config": {"publicBaseUrl": "https://relay.example"},
            },
        )
        repaired = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/webhook-secret-rotations"
        )
        assert repaired.status_code == 200
        client.patch(
            f"/api/v1/admin/chat-integrations/{integration_id}", json={"config": {}}
        )
        client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/identity-links",
            json={
                "externalUserId": "42",
                "employeeId": "alice",
            },
        )
        client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/allowed-conversations",
            json={
                "conversationId": "-100",
            },
        )
        client.post(f"/api/v1/admin/chat-integrations/{integration_id}/health-checks")

        activate = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/activations"
        )

        assert activate.status_code == 400
        assert "public callback URL" in activate.json()["detail"]

        malformed = client.patch(
            f"/api/v1/admin/chat-integrations/{integration_id}",
            json={
                "config": {"publicBaseUrl": "https://relay.example/base?wrong=path"},
            },
        )
        assert malformed.status_code == 200
        client.post(f"/api/v1/admin/chat-integrations/{integration_id}/health-checks")
        assert (
            client.post(
                f"/api/v1/admin/chat-integrations/{integration_id}/activations"
            ).status_code
            == 400
        )

        updated = client.patch(
            f"/api/v1/admin/chat-integrations/{integration_id}",
            json={
                "config": {"publicBaseUrl": "https://relay.example"},
            },
        )
        assert updated.status_code == 200
        client.post(f"/api/v1/admin/chat-integrations/{integration_id}/health-checks")
        activate = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/activations"
        )
        assert activate.status_code == 200
        rotated = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/webhook-secret-rotations"
        )
        assert rotated.status_code == 200
        assert (
            rotated.json()["provisioning"]["message"] == "Telegram webhook registered."
        )
        assert len(provisioned_secrets) == 3
        assert provisioned_secrets[0] == provisioned_secrets[1]
        assert provisioned_secrets[2] != provisioned_secrets[1]

        previous_secret = client.app.state.chat_store.connection_settings(
            integration_id
        )["secrets"]["webhookSecret"]

        async def reject_then_restore(settings, _integration_id):
            if settings["secrets"]["webhookSecret"] == previous_secret:
                return True, "Previous Telegram webhook restored."
            return False, "Telegram webhook confirmation failed."

        client.app.state.chat_provision = reject_then_restore
        failed_rotation = client.post(
            f"/api/v1/admin/chat-integrations/{integration_id}/webhook-secret-rotations"
        )
        assert failed_rotation.status_code == 400
        assert (
            client.app.state.chat_store.connection_settings(integration_id)["secrets"][
                "webhookSecret"
            ]
            == previous_secret
        )


def test_chat_integrations_require_admin(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login(admin_client, "admin", "kestrel-vault-7719")

        response = admin_client.post(
            "/api/v1/admin/users",
            json={
                "username": "alice",
                "password": "userpass",
                "role": "user",
            },
        )
        assert response.status_code == 201

        user_client = TestClient(app)
        _login(user_client, "alice", "userpass")
        response = user_client.get("/api/v1/admin/chat-integrations")
        assert response.status_code == 403


def test_chat_integration_store_serializes_concurrent_creates() -> None:
    with TemporaryDirectory() as root:
        store = LocalChatIntegrationStore(root)

        def create(index: int) -> str:
            integration = store.create_integration(
                {
                    "provider": "discord",
                    "displayName": f"Discord {index}",
                    "secrets": {"botToken": f"secret-{index}"},
                }
            )
            return integration["id"]

        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(create, range(20)))

        integrations = store.list_integrations()
        assert len(integrations) == 20
        assert {item["id"] for item in integrations} == set(ids)
        assert all(item["secretConfigured"] for item in integrations)


def test_database_chat_integration_store_encrypts_secrets(monkeypatch) -> None:
    from cryptography.fernet import Fernet

    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", Fernet.generate_key().decode())
    with TemporaryDirectory() as root:
        store = DatabaseChatIntegrationStore(
            f"sqlite:///{root}/chat.db", create_schema=True
        )
        integration = store.create_integration(
            {
                "provider": "discord",
                "displayName": "Engineering Discord",
                "config": {"publicBaseUrl": "https://relay.example"},
                "secrets": {"botToken": "secret-token"},
            },
            actor="admin",
        )
        store.add_identity_link(
            integration["id"], {"externalUserId": "u1", "employeeId": "alice"}
        )
        store.add_allowed_conversation(integration["id"], {"conversationId": "c1"})
        store.check_integration(
            integration["id"], provider_health=(True, "Provider credentials verified.")
        )
        activated = store.activate_integration(integration["id"], actor="admin")

        assert activated["status"] == "active"
        assert (
            store.resolve_identity(
                {
                    "provider": "discord",
                    "externalUserId": "u1",
                    "conversationId": "c1",
                }
            )["employeeId"]
            == "alice"
        )
        assert (
            store.audit_events(integration["id"])[-1]["type"]
            == "chat.integration.activated"
        )
        assert not (Path(root) / "chat").exists()
        with store.engine.begin() as connection:
            encrypted = (
                connection.execute(
                    store.documents.select().where(
                        store.documents.c.document_key == "secrets"
                    )
                )
                .mappings()
                .one()["payload"]
            )
        assert "secret-token" not in json.dumps(encrypted)
