"""Chat provider waits must not make database work block the application loop."""

import asyncio
import threading
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from relay.api.chat import integrations


@pytest.mark.parametrize("operation", ["activate", "check", "rotate", "restore", "restore_failed", "missing", "invalid"])
def test_chat_admin_database_work_runs_off_loop(monkeypatch, operation):
    async def exercise():
        loop_thread = threading.get_ident()
        calls = []
        provisions = []

        def database_call(name, result=None):
            def call(*args, **kwargs):
                assert threading.get_ident() != loop_thread, f"{name} blocked the event loop"
                calls.append(name)
                if operation == "missing" and name == "connection_settings":
                    raise KeyError("missing")
                if operation == "invalid" and name == "validate_activation":
                    raise ValueError("not ready")
                return result
            return call

        settings = {"provider": "telegram", "secrets": {"webhookSecret": "previous"}}
        store = SimpleNamespace(**{
            name: database_call(name, result)
            for name, result in {
                "validate_activation": None,
                "validate_telegram_webhook_rotation": None,
                "connection_settings": settings,
                "activate_integration": {"status": "active"},
                "check_integration": {"health": {"ok": True}},
                "set_telegram_webhook_secret": {"id": "integration"},
            }.items()
        })
        store.provider_operation = lambda integration_id: nullcontext()
        monkeypatch.setattr(integrations, "require_admin_session", database_call("auth", {"username": "admin"}))

        async def provision(settings, integration_id):
            assert threading.get_ident() == loop_thread
            assert integration_id == "integration"
            provisions.append(settings)
            if operation in {"restore", "restore_failed"}:
                return len(provisions) > 1 and operation == "restore", "provider response"
            return True, "registered"

        async def probe(settings):
            assert threading.get_ident() == loop_thread
            return True, "healthy"

        ctx = SimpleNamespace(
            auth_store=object(), chat_store=store, chat_provision=provision,
            chat_probe=probe,
        )
        handler = (
            integrations.check_chat_integration if operation == "check"
            else integrations.activate_chat_integration if operation in {"activate", "missing", "invalid"}
            else integrations.rotate_telegram_webhook_secret
        )
        if operation in {"restore", "restore_failed", "missing", "invalid"}:
            with pytest.raises(HTTPException) as error:
                await handler("integration", object(), ctx)
            assert error.value.status_code == (404 if operation == "missing" else 400)
        else:
            assert "integration" in await handler("integration", object(), ctx)
        assert calls[0] == "auth"
        if operation in {"restore", "restore_failed"}:
            assert len(provisions) == 2
            assert calls.count("set_telegram_webhook_secret") == (2 if operation == "restore" else 1)

    asyncio.run(exercise())
