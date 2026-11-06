"""Provider side effects coordinate across independent backend contexts."""

import asyncio
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from postgres_backend import disposable_postgres_url
from relay.api.chat import integrations as routes
from relay.chat.integrations import DatabaseChatIntegrationStore


@pytest.fixture
def chat_replicas(monkeypatch):
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(routes, "require_admin_session", lambda *args: {"username": "admin"})
    with disposable_postgres_url() as url:
        first, second = (DatabaseChatIntegrationStore(url) for _ in range(2))
        integration = first.create_integration({
            "provider": "telegram", "config": {"publicBaseUrl": "https://relay.example"},
            "secrets": {"botToken": "test-token"},
        })
        first.add_identity_link(integration["id"], {"externalUserId": "external", "userId": "owner"})
        first.add_allowed_conversation(integration["id"], {"conversationId": "conversation"})
        first.check_integration(integration["id"], provider_health=(True, "healthy"))
        yield first, second, integration["id"]


def context(store, provision):
    async def probe(settings):
        return True, "healthy"
    return SimpleNamespace(
        chat_store=store, auth_store=object(), chat_provision=provision, chat_probe=probe,
    )


@pytest.mark.postgres
@pytest.mark.parametrize("operation", ["rotation", "activation", "health", "update"])
def test_provider_operation_refuses_conflicting_replica_work(chat_replicas, operation):
    first, second, integration_id = chat_replicas

    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def provision(settings, record_id):
            calls.append(settings)
            entered.set()
            await release.wait()
            return True, "registered"

        a, b = context(first, provision), context(second, provision)
        rotation = asyncio.create_task(routes.rotate_telegram_webhook_secret(integration_id, object(), a))
        try:
            await asyncio.wait_for(entered.wait(), 5)
            # The new key must be committed before contacting the provider:
            # incoming webhooks may already use it while provisioning awaits.
            settings = await run_in_threadpool(second.connection_settings, integration_id)
            assert settings["secrets"]["webhookSecret"] == calls[0]["secrets"]["webhookSecret"]
            with pytest.raises(HTTPException) as error:
                if operation == "update":
                    await run_in_threadpool(
                        routes.update_chat_integration, integration_id, object(), b,
                        _request_body={"secrets": {"botToken": "changed-token"}},
                    )
                else:
                    handler = {
                        "rotation": routes.rotate_telegram_webhook_secret,
                        "activation": routes.activate_chat_integration,
                        "health": routes.check_chat_integration,
                    }[operation]
                    await asyncio.wait_for(handler(integration_id, object(), b), 1)
            assert error.value.status_code == 409
        finally:
            release.set()
            await rotation
        assert len(calls) == 1
        # Finishing releases the guard for the next operation on another replica.
        assert "integration" in await routes.check_chat_integration(integration_id, object(), b)

    asyncio.run(exercise())


@pytest.mark.postgres
@pytest.mark.parametrize("outcome", ["cancel", "error"])
def test_provider_operation_releases_after_interruption(chat_replicas, outcome):
    first, second, integration_id = chat_replicas

    async def exercise():
        entered = asyncio.Event()

        async def interrupted(settings, record_id):
            entered.set()
            if outcome == "error":
                raise RuntimeError("provider unavailable")
            await asyncio.Event().wait()
            return True, "unreachable"

        a = context(first, interrupted)
        task = asyncio.create_task(routes.rotate_telegram_webhook_secret(integration_id, object(), a))
        await asyncio.wait_for(entered.wait(), 5)
        if outcome == "cancel":
            task.cancel()
        with pytest.raises(asyncio.CancelledError if outcome == "cancel" else RuntimeError):
            await task

        async def healthy(settings, record_id):
            return True, "registered"

        result = await asyncio.wait_for(
            routes.rotate_telegram_webhook_secret(integration_id, object(), context(second, healthy)), 5
        )
        assert result["provisioning"]["ok"]

    asyncio.run(exercise())
